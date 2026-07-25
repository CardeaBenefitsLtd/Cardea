/**
 * Adapter for AIB's IBR transaction register.
 *
 * The register is billing data, not a policy master: one row per invoice line,
 * several rows per policy, and a row for every tax, fee, endorsement and
 * reversal alongside the premium itself. Turning it into something the rules
 * engine can read means three things — filter to the rows that actually carry
 * premium, collapse the transactions into policies, and collapse the policies
 * into clients.
 *
 * What the register does not carry matters as much as what it does. There are
 * no sums insured, no policy extensions, no claims and no member census, so
 * the rules that depend on those stay dormant rather than firing on absent
 * data. `bookCapabilities()` in schema.js is what tells the engine which is
 * which.
 *
 * Column mapping, with the inferences flagged:
 *   Billed From             client key      stable code, e.g. THEBEAC-01
 *   Account Name            client name
 *   Name                    account executive   (119 distinct — inferred as the producer)
 *   Policy Number           policy key
 *   Policy/Line             line code       92 distinct, AIB's own taxonomy
 *   Profit Centre Name      profit centre   10 distinct
 *   Department Name         department      Personal Lines / Corporate / Employee Benefits / TPA / Binding
 *   ICO                     carrier         (inferred — 83 distinct insurer-shaped codes)
 *   Policy Effective Date   term start
 *   Policy Expiration Date  renewal date
 *   Gross Premium TTD       premium, already normalised to TTD
 *   Total Brokerage         realised brokerage
 *   Trans Code              what the row is — see PREMIUM_BEARING below
 *   Reversed                Yes rows are backed out and must be excluded
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCsv } from '../book.js';
import { registerLine } from '../../engine/catalogue.js';

/**
 * Transaction codes that carry premium. Everything else in the register is a
 * tax (ITAX, GTAX, MCTX, WTAX, PTAX), a fee (PFEE, AFEE, CFEE, SFEE) or an
 * accounting movement, and counting those as premium would double the book.
 */
export const PREMIUM_BEARING = new Set(['NEWB', 'RENB', 'ENDT', 'ADJO', 'REIN']);

/** Codes that reduce the book — tracked separately, because churn is a signal. */
export const CANCELLING = new Set(['CANC', 'DECL']);

/** Departments that represent employee benefits business, however administered. */
export const BENEFITS_DEPARTMENTS = new Set(['Employee Benefits', 'Third Party Administration']);

/**
 * Values that appear in the Policy Number column but do not identify a policy.
 * Keying on these would merge every unnumbered policy on an account into one.
 */
const PLACEHOLDER_POLICY_NUMBERS = new Set(['', 'NONUMBER', 'NA', 'N/A', 'NONE', 'NIL', 'TBA', 'UNKNOWN', '0']);

/**
 * Policy numbers are typed by hand and the same policy appears as both
 * "TT FAR 1041794" and "TTFAR1041794". Six such collisions in the register
 * cover TT$8.2M of premium — small, but each one splits a policy in two and
 * makes it look like a client holds more cover than they do.
 * @param {string} raw
 */
export function normalisePolicyNumber(raw) {
  const cleaned = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return PLACEHOLDER_POLICY_NUMBERS.has(cleaned) ? '' : cleaned;
}

const COLUMNS = {
  clientKey: 'Billed From',
  clientName: 'Account Name',
  accountExecutive: 'Name',
  policyNumber: 'Policy Number',
  lineCode: 'Policy/Line',
  profitCentre: 'Profit Centre Name',
  department: 'Department Name',
  carrier: 'ICO',
  effective: 'Policy Effective Date',
  expiration: 'Policy Expiration Date',
  premium: 'Gross Premium TTD',
  brokerage: 'Total Brokerage',
  commissionPct: 'Agcy Com %',
  transCode: 'Trans Code',
  transDate: 'Trans Date Entered',
  reversed: 'Reversed',
  branch: 'Branch',
};

/**
 * @param {string} path CSV export of the register.
 * @param {{now?: Date}} [opts]
 * @returns {import('../schema.js').Book}
 */
export function loadIbrRegister(path, opts = {}) {
  const rows = parseCsv(readFileSync(resolve(path), 'utf8'));
  return buildBook(rows, opts);
}

/**
 * @param {Record<string,string>[]} rows
 * @param {{now?: Date}} [opts]
 */
export function buildBook(rows, opts = {}) {
  const missing = Object.values(COLUMNS).filter((c) => rows.length && !(c in rows[0]));
  if (missing.length) {
    throw new Error(
      `Register is missing expected column(s): ${missing.join(', ')}. ` +
        'Check the export includes every field from the IBR report.',
    );
  }

  /** @type {Map<string, any>} */
  const policies = new Map();
  /** @type {Map<string, any>} */
  const clients = new Map();
  const transactions = [];

  let reversedRows = 0;
  let nonPremiumRows = 0;

  for (const row of rows) {
    const reversed = (row[COLUMNS.reversed] ?? '').trim().toLowerCase() === 'yes';
    const code = (row[COLUMNS.transCode] ?? '').trim();
    const clientKey = (row[COLUMNS.clientKey] ?? '').trim();
    const policyNumberRaw = (row[COLUMNS.policyNumber] ?? '').trim();
    const policyNumber = normalisePolicyNumber(policyNumberRaw);
    if (!clientKey) continue;

    const premium = money(row[COLUMNS.premium]);
    const brokerage = money(row[COLUMNS.brokerage]);
    const effective = isoDate(row[COLUMNS.effective]);
    const expiration = isoDate(row[COLUMNS.expiration]);

    // Clients are built from every row, so an account that only ever appears
    // on a tax line still exists rather than vanishing.
    let client = clients.get(clientKey);
    if (!client) {
      clients.set(clientKey, (client = {
        id: clientKey,
        name: (row[COLUMNS.clientName] ?? clientKey).trim(),
        industry: 'Household',
        segment: 'commercial',
        headcount: 0,
        relationshipStart: effective ?? undefined,
        locations: [],
        accountExecutive: (row[COLUMNS.accountExecutive] ?? '').trim() || undefined,
        departments: new Set(),
        profitCentres: new Set(),
        branch: (row[COLUMNS.branch] ?? '').trim() || undefined,
      }));
    }
    const department = (row[COLUMNS.department] ?? '').trim();
    if (department) client.departments.add(department);
    if (effective && (!client.relationshipStart || effective < client.relationshipStart)) {
      client.relationshipStart = effective;
    }

    if (reversed) { reversedRows++; continue; }

    transactions.push({
      clientId: clientKey,
      policyId: policyNumber || null,
      code,
      date: isoDate(row[COLUMNS.transDate]),
      effective,
      premiumTTD: premium,
      brokerageTTD: brokerage,
      department,
      profitCentre: (row[COLUMNS.profitCentre] ?? '').trim(),
      lineCode: (row[COLUMNS.lineCode] ?? '').trim(),
    });

    if (!PREMIUM_BEARING.has(code)) { nonPremiumRows++; continue; }
    // Unnumbered policies still count, keyed by line and term so they stay
    // distinct from each other rather than collapsing into a single record.
    const policyKey = policyNumber || `UNNUMBERED:${clientKey}:${(row[COLUMNS.lineCode] ?? '').trim()}:${effective ?? ''}`;
    if (!policyKey) continue;

    const profitCentre = (row[COLUMNS.profitCentre] ?? '').trim();
    if (profitCentre) client.profitCentres.add(profitCentre);

    // Policies are keyed by number and term: a renewal is a new term of the
    // same policy, and conflating the two would hide the premium history that
    // the decline and lapse rules depend on.
    const termKey = `${policyKey}::${effective ?? 'unknown'}`;
    let policy = policies.get(termKey);
    if (!policy) {
      policies.set(termKey, (policy = {
        id: policyKey,
        displayNumber: policyNumberRaw || '(no policy number)',
        termKey,
        clientId: clientKey,
        line: (row[COLUMNS.lineCode] ?? '').trim() || 'UNKNOWN',
        lineCode: (row[COLUMNS.lineCode] ?? '').trim() || 'UNKNOWN',
        profitCentre,
        department,
        carrier: (row[COLUMNS.carrier] ?? '').trim() || 'unknown',
        inceptionDate: effective,
        renewalDate: expiration,
        annualPremium: 0,
        brokerageTTD: 0,
        currency: 'TTD',
        extensions: [],
        status: 'active',
        transactionCodes: new Set(),
      }));
    }
    policy.annualPremium += premium;
    policy.brokerageTTD += brokerage;
    policy.transactionCodes.add(code);
  }

  // Collapse terms to one current policy each, keeping the prior term's premium
  // so a renewal that came back smaller is visible.
  /** @type {Map<string, any[]>} */
  const byNumber = new Map();
  for (const policy of policies.values()) {
    let list = byNumber.get(policy.id);
    if (!list) byNumber.set(policy.id, (list = []));
    list.push(policy);
  }

  const finalPolicies = [];
  for (const terms of byNumber.values()) {
    terms.sort((a, b) => String(a.inceptionDate ?? '').localeCompare(String(b.inceptionDate ?? '')));
    const current = terms.at(-1);
    const prior = terms.length > 1 ? terms.at(-2) : null;
    finalPolicies.push({
      ...current,
      transactionCodes: [...current.transactionCodes],
      priorTermPremiumTTD: prior ? Math.round(prior.annualPremium) : null,
      priorTermEndedAt: prior?.renewalDate ?? null,
      termCount: terms.length,
      annualPremium: Math.round(current.annualPremium),
      brokerageTTD: Math.round(current.brokerageTTD),
    });
  }

  // Cancellations are policy-level facts the rules read directly.
  const cancelled = new Map();
  for (const row of rows) {
    if ((row[COLUMNS.reversed] ?? '').trim().toLowerCase() === 'yes') continue;
    if (!CANCELLING.has((row[COLUMNS.transCode] ?? '').trim())) continue;
    const key = normalisePolicyNumber(row[COLUMNS.policyNumber]);
    if (key) cancelled.set(key, isoDate(row[COLUMNS.transDate]));
  }
  for (const policy of finalPolicies) {
    if (cancelled.has(policy.id)) {
      policy.status = 'cancelled';
      policy.cancelledAt = cancelled.get(policy.id);
    }
  }

  const finalClients = [...clients.values()].map((c) => ({
    ...c,
    departments: [...c.departments],
    profitCentres: [...c.profitCentres],
    segment: segmentFor(c.departments),
  }));

  // Teach the catalogue the register's own taxonomy, so rules can reason about
  // lines this codebase never enumerated.
  for (const policy of finalPolicies) {
    registerLine({ code: policy.lineCode, profitCentre: policy.profitCentre, department: policy.department });
  }

  // Where the export stops. Anything expiring near or after this cannot be
  // judged as lapsed, because the renewal transaction would simply not be in
  // the file yet. Without this a stale export reports healthy renewals as
  // churn — the single most misleading thing a retention rule can do.
  const dataAsOf = transactions
    .map((t) => t.date)
    .filter(Boolean)
    .reduce((max, d) => (max && max > d ? max : d), undefined);

  return {
    meta: {
      source: 'ibr-register',
      dataAsOf,
      rowsRead: rows.length,
      reversedRowsExcluded: reversedRows,
      nonPremiumRowsExcluded: nonPremiumRows,
      note:
        'Derived from the IBR transaction register. No sums insured, extensions, claims or member census — ' +
        'rules depending on those are reported as dormant rather than run.',
    },
    clients: finalClients,
    policies: finalPolicies,
    members: [],
    claims: [],
    transactions,
  };
}

/** Departments are the only segmentation the register offers. */
function segmentFor(departments) {
  if (departments.has('Corporate')) return 'corporate';
  if (departments.has('Personal Lines') && departments.size === 1) return 'personal';
  return 'commercial';
}

/** @param {string|undefined} v */
export function money(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[,$\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return Number.isFinite(n) ? n : 0;
}

/**
 * The register writes dates as "2026-07-25 00:00:00". Anything else is left
 * alone rather than guessed at, since a misread date silently reorders terms.
 * @param {string|undefined} v
 */
export function isoDate(v) {
  if (!v) return undefined;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10);
}
