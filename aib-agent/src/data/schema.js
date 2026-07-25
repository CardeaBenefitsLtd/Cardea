/**
 * The data contract for the AIB book of business.
 *
 * This is the only thing the agent knows about your systems. Whatever the
 * policy administration system is, the job of an adapter is to produce these
 * four collections. Everything downstream — the rules engine, the scoring,
 * the analyst — reads from this shape and nothing else.
 *
 * Money is stored in the policy's own currency with the currency recorded
 * alongside it; normalisation to TTD happens in one place (`toTTD`) so an FX
 * change is a one-line edit rather than a hunt.
 *
 * @typedef {Object} Client
 * @property {string} id                        Stable key from the admin system, e.g. "CL-1042".
 * @property {string} name
 * @property {IndustryKey} industry
 * @property {'commercial'|'corporate'|'personal'} segment
 * @property {number} headcount                 Current employee count (0 for personal lines).
 * @property {number} [headcountAtInception]    Headcount when the relationship began; drives growth rules.
 * @property {number} [annualRevenueTTD]        Used for liability/cyber adequacy tests.
 * @property {string} relationshipStart         ISO date.
 * @property {string[]} locations               Free-text sites, e.g. ["Port of Spain", "Point Lisas"].
 * @property {boolean} [floodZone]              Site sits in a known flood-prone area.
 * @property {string} [accountExecutive]        Owning AIB producer.
 * @property {Contact} [primaryContact]
 *
 * @typedef {Object} Contact
 * @property {string} name
 * @property {string} [title]
 * @property {string} [email]
 * @property {string} [phone]
 *
 * @typedef {Object} Policy
 * @property {string} id
 * @property {string} clientId
 * @property {LineKey} line                     Must match a key in engine/catalogue.js.
 * @property {string} carrier                   Placing insurer.
 * @property {'AIB'|'Cardea'|'carrier'|'self'|string} [administrator]  Who administers claims. Cardea matters for benefits.
 * @property {string} inceptionDate             ISO date.
 * @property {string} renewalDate               ISO date. Drives every timing rule.
 * @property {number} annualPremium
 * @property {'TTD'|'USD'} currency
 * @property {number} [sumInsured]              Property/marine/liability limit, in `currency`.
 * @property {string} [sumInsuredSetAt]         ISO date the sum insured was last revised. Drives indexation drift.
 * @property {number} [lives]                   Benefits lines only.
 * @property {number} [vehicles]                Motor fleet only.
 * @property {number} [deductible]
 * @property {number} [indemnityPeriodMonths]   Business interruption only.
 * @property {string[]} extensions              e.g. ["flood", "earthquake", "windstorm", "overseas_network"].
 * @property {'active'|'lapsed'|'cancelled'} status
 *
 * @typedef {Object} Member                     Benefits lives. Omit entirely if AIB does not hold census data.
 * @property {string} id
 * @property {string} clientId
 * @property {'employee'|'spouse'|'child'|'retiree'} role
 * @property {string} dob                       ISO date.
 * @property {'active'|'terminated'} status
 * @property {boolean} [tertiaryEnrolled]       Children 21-25 in full-time tertiary education stay covered.
 * @property {string} [primaryMemberId]         For dependants.
 *
 * @typedef {Object} Claim
 * @property {string} id
 * @property {string} clientId
 * @property {string} policyId
 * @property {string} [memberId]
 * @property {string} date                      ISO date.
 * @property {ClaimCategory} category
 * @property {number} amount
 * @property {'TTD'|'USD'} currency
 * @property {'paid'|'declined'|'open'} status
 * @property {string} [declineReason]           The single richest cross-sell signal in the book.
 *
 * @typedef {Object} Book
 * @property {Client[]} clients
 * @property {Policy[]} policies
 * @property {Member[]} members
 * @property {Claim[]} claims
 *
 * @typedef {'Manufacturing'|'Distribution'|'Retail'|'Construction'|'Energy'|'Financial Services'|'Professional Services'|'Hospitality'|'Agriculture'|'Healthcare'|'Transport & Logistics'|'Technology'|'Household'} IndustryKey
 * @typedef {string} LineKey
 * @typedef {'property'|'motor'|'liability'|'marine'|'outpatient'|'inpatient'|'dental'|'vision'|'maternity'|'overseas_precert'|'emergency'|'business_interruption'|'cyber'|'other'} ClaimCategory
 */

/** Industries the rules engine knows how to reason about. */
export const INDUSTRIES = [
  'Manufacturing',
  'Distribution',
  'Retail',
  'Construction',
  'Energy',
  'Financial Services',
  'Professional Services',
  'Hospitality',
  'Agriculture',
  'Healthcare',
  'Transport & Logistics',
  'Technology',
  'Household',
];

export const SEGMENTS = ['commercial', 'corporate', 'personal'];
export const POLICY_STATUSES = ['active', 'lapsed', 'cancelled'];
export const CLAIM_STATUSES = ['paid', 'declined', 'open'];

/** TTD per USD. Overridable so a devaluation is a config change, not a code change. */
export const FX_TTD_PER_USD = Number(process.env.AIB_FX_TTD_PER_USD ?? 6.8);

/**
 * Normalise any amount to TTD. Every comparison, benchmark and score in this
 * codebase runs through here — nothing else should touch the FX rate.
 * @param {number} amount
 * @param {'TTD'|'USD'} [currency]
 * @returns {number}
 */
export function toTTD(amount, currency = 'TTD') {
  if (!Number.isFinite(amount)) return 0;
  return currency === 'USD' ? amount * FX_TTD_PER_USD : amount;
}

/**
 * Validate a book before the agent ever sees it. Returns problems rather than
 * throwing on the first one, so a bad export can be fixed in a single pass
 * instead of one error at a time.
 *
 * @param {Book} book
 * @returns {{ok: boolean, errors: string[], warnings: string[], counts: Record<string, number>}}
 */
export function validateBook(book) {
  const errors = [];
  const warnings = [];

  if (!book || typeof book !== 'object') {
    return { ok: false, errors: ['book is not an object'], warnings, counts: {} };
  }

  for (const key of ['clients', 'policies', 'members', 'claims']) {
    if (!Array.isArray(book[key])) errors.push(`book.${key} must be an array`);
  }
  if (errors.length) return { ok: false, errors, warnings, counts: {} };

  const clientIds = new Set();
  for (const [i, c] of book.clients.entries()) {
    if (!c.id) errors.push(`clients[${i}] is missing an id`);
    else if (clientIds.has(c.id)) errors.push(`duplicate client id ${c.id}`);
    else clientIds.add(c.id);
    if (!c.name) warnings.push(`client ${c.id ?? i} has no name`);
    if (c.industry && !INDUSTRIES.includes(c.industry)) {
      warnings.push(`client ${c.id} has unmapped industry "${c.industry}" — peer benchmarks will skip it`);
    }
    if (c.segment && !SEGMENTS.includes(c.segment)) {
      warnings.push(`client ${c.id} has unknown segment "${c.segment}"`);
    }
  }

  const policyIds = new Set();
  for (const [i, p] of book.policies.entries()) {
    if (!p.id) errors.push(`policies[${i}] is missing an id`);
    else if (policyIds.has(p.id)) errors.push(`duplicate policy id ${p.id}`);
    else policyIds.add(p.id);
    if (!clientIds.has(p.clientId)) errors.push(`policy ${p.id} references unknown client ${p.clientId}`);
    if (!p.line) errors.push(`policy ${p.id} has no line`);
    if (!isIsoDate(p.renewalDate)) {
      warnings.push(`policy ${p.id} has no usable renewalDate — timing rules will skip it`);
    }
    if (!Number.isFinite(p.annualPremium)) {
      warnings.push(`policy ${p.id} has no annualPremium — it will not contribute to book value`);
    }
    if (p.currency && !['TTD', 'USD'].includes(p.currency)) {
      errors.push(`policy ${p.id} has unsupported currency ${p.currency}`);
    }
  }

  for (const [i, m] of book.members.entries()) {
    if (!m.id) errors.push(`members[${i}] is missing an id`);
    if (!clientIds.has(m.clientId)) errors.push(`member ${m.id} references unknown client ${m.clientId}`);
    if (!isIsoDate(m.dob)) warnings.push(`member ${m.id} has no usable dob — lifecycle rules will skip it`);
  }

  for (const [i, cl] of book.claims.entries()) {
    if (!cl.id) errors.push(`claims[${i}] is missing an id`);
    if (!clientIds.has(cl.clientId)) errors.push(`claim ${cl.id} references unknown client ${cl.clientId}`);
    if (cl.policyId && !policyIds.has(cl.policyId)) {
      warnings.push(`claim ${cl.id} references unknown policy ${cl.policyId}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: {
      clients: book.clients.length,
      policies: book.policies.length,
      members: book.members.length,
      claims: book.claims.length,
    },
  };
}

/**
 * Which optional fields a book actually carries.
 *
 * Different exports expose different things: a transaction register has
 * premium and renewal dates but no sums insured, no policy extensions, no
 * claims and no census. A rule that depends on a field the book does not have
 * should stay dormant and say so, not fire on absent data and report a gap
 * that is really a gap in the export.
 *
 * A field counts as present only if enough records carry it to reason with —
 * one populated row out of sixty thousand is noise, not a capability.
 *
 * @param {Book} book
 * @param {{threshold?: number}} [opts] Minimum share of records, default 5%.
 * @returns {Record<string, boolean>}
 */
export function bookCapabilities(book, opts = {}) {
  const threshold = opts.threshold ?? 0.05;
  const share = (list, predicate) => (list.length ? list.filter(predicate).length / list.length : 0);

  const policies = book.policies ?? [];
  const clients = book.clients ?? [];

  return {
    sumInsured: share(policies, (p) => Number.isFinite(p.sumInsured) && p.sumInsured > 0) >= threshold,
    sumInsuredSetAt: share(policies, (p) => isIsoDate(p.sumInsuredSetAt)) >= threshold,
    extensions: share(policies, (p) => Array.isArray(p.extensions) && p.extensions.length > 0) >= threshold,
    indemnityPeriod: share(policies, (p) => Number.isFinite(p.indemnityPeriodMonths)) >= threshold,
    renewalDate: share(policies, (p) => isIsoDate(p.renewalDate)) >= threshold,
    premium: share(policies, (p) => Number.isFinite(p.annualPremium) && p.annualPremium !== 0) >= threshold,
    lives: share(policies, (p) => Number.isFinite(p.lives) && p.lives > 0) >= threshold,
    vehicles: share(policies, (p) => Number.isFinite(p.vehicles) && p.vehicles > 0) >= threshold,
    administrator: share(policies, (p) => Boolean(p.administrator)) >= threshold,
    department: share(policies, (p) => Boolean(p.department)) >= threshold,
    profitCentre: share(policies, (p) => Boolean(p.profitCentre)) >= threshold,
    priorTermPremium: share(policies, (p) => Number.isFinite(p.priorTermPremiumTTD)) >= threshold,
    claims: (book.claims ?? []).length > 0,
    declineReasons: share(book.claims ?? [], (c) => Boolean(c.declineReason)) >= threshold,
    census: (book.members ?? []).length > 0,
    memberDob: share(book.members ?? [], (m) => isIsoDate(m.dob)) >= threshold,
    headcount: share(clients, (c) => Number.isFinite(c.headcount) && c.headcount > 0) >= threshold,
    revenue: share(clients, (c) => Number.isFinite(c.annualRevenueTTD) && c.annualRevenueTTD > 0) >= threshold,
    industry: share(clients, (c) => c.industry && c.industry !== 'Household') >= threshold,
    locations: share(clients, (c) => Array.isArray(c.locations) && c.locations.length > 0) >= threshold,
    floodZone: share(clients, (c) => c.floodZone === true) >= threshold,
  };
}

/** @param {unknown} v */
export function isIsoDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
}
