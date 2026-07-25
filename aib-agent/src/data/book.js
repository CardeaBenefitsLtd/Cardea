/**
 * Loading and querying the book of business.
 *
 * Three source adapters ship here — the bundled sample, a JSON export, and a
 * directory of CSVs. Whatever AIB's policy administration system turns out to
 * be, adding a fourth adapter is the whole integration: return a `Book` in the
 * shape `schema.js` describes and nothing downstream changes.
 *
 * Everything is loaded once and indexed once. The rules engine walks the book
 * repeatedly and the agent queries it interactively, so linear scans per lookup
 * would show up immediately on a real book.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { validateBook, toTTD, isIsoDate } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * @param {{source?: 'sample'|'json'|'csv', path?: string, strict?: boolean}} [opts]
 * @returns {import('./schema.js').Book & {meta?: object}}
 */
export function loadBook(opts = {}) {
  const source = opts.source ?? process.env.BOOK_SOURCE ?? 'sample';
  const path = opts.path ?? process.env.BOOK_PATH;

  let book;
  switch (source) {
    case 'sample':
      book = JSON.parse(readFileSync(join(here, 'sample-book.json'), 'utf8'));
      break;
    case 'json':
      if (!path) throw new Error('BOOK_SOURCE=json requires BOOK_PATH');
      book = JSON.parse(readFileSync(resolve(path), 'utf8'));
      break;
    case 'csv':
      if (!path) throw new Error('BOOK_SOURCE=csv requires BOOK_PATH (a directory)');
      book = loadCsvDirectory(resolve(path));
      break;
    default:
      throw new Error(`Unknown BOOK_SOURCE "${source}" (expected sample, json or csv)`);
  }

  book.clients ??= [];
  book.policies ??= [];
  book.members ??= [];
  book.claims ??= [];

  const report = validateBook(book);
  if (!report.ok) {
    const detail = report.errors.slice(0, 10).join('\n  - ');
    throw new Error(
      `Book failed validation (${report.errors.length} error(s)):\n  - ${detail}` +
        (report.errors.length > 10 ? `\n  ...and ${report.errors.length - 10} more` : ''),
    );
  }
  if (opts.strict && report.warnings.length) {
    throw new Error(`Book has ${report.warnings.length} warning(s) and strict mode is on`);
  }
  book.validation = report;
  return book;
}

// ------------------------------------------------------------------ CSV path

/**
 * Minimal RFC4180-ish CSV reader. Handles quoted fields, embedded commas and
 * doubled quotes, which is where naive `split(',')` implementations fall over
 * on real exports (addresses and company names are full of commas).
 * @param {string} text
 * @returns {Record<string,string>[]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows.filter((r) => r.some((c) => c !== ''));
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

function loadCsvDirectory(dir) {
  const files = new Set(readdirSync(dir));
  const read = (name) => (files.has(name) ? parseCsv(readFileSync(join(dir, name), 'utf8')) : []);

  const num = (v) => (v === '' || v == null ? undefined : Number(v));
  const bool = (v) => (v === '' || v == null ? undefined : /^(true|yes|y|1)$/i.test(v));
  const list = (v) => (v ? v.split(/[;|]/).map((s) => s.trim()).filter(Boolean) : []);

  return {
    clients: read('clients.csv').map((r) => ({
      ...r,
      headcount: num(r.headcount) ?? 0,
      headcountAtInception: num(r.headcountAtInception),
      annualRevenueTTD: num(r.annualRevenueTTD),
      floodZone: bool(r.floodZone),
      locations: list(r.locations),
      primaryContact: r.contactName
        ? { name: r.contactName, title: r.contactTitle, email: r.contactEmail, phone: r.contactPhone }
        : undefined,
    })),
    policies: read('policies.csv').map((r) => ({
      ...r,
      annualPremium: num(r.annualPremium),
      sumInsured: num(r.sumInsured),
      lives: num(r.lives),
      vehicles: num(r.vehicles),
      deductible: num(r.deductible),
      indemnityPeriodMonths: num(r.indemnityPeriodMonths),
      extensions: list(r.extensions),
      currency: r.currency || 'TTD',
      status: r.status || 'active',
    })),
    members: read('members.csv').map((r) => ({
      ...r,
      tertiaryEnrolled: bool(r.tertiaryEnrolled),
      status: r.status || 'active',
    })),
    claims: read('claims.csv').map((r) => ({
      ...r,
      amount: num(r.amount) ?? 0,
      currency: r.currency || 'TTD',
      status: r.status || 'paid',
    })),
  };
}

// ------------------------------------------------------------------- indexing

/**
 * @typedef {Object} BookIndex
 * @property {import('./schema.js').Book} book
 * @property {Map<string, import('./schema.js').Client>} clientsById
 * @property {Map<string, import('./schema.js').Policy>} policiesById
 * @property {Map<string, import('./schema.js').Policy[]>} policiesByClient
 * @property {Map<string, import('./schema.js').Member[]>} membersByClient
 * @property {Map<string, import('./schema.js').Claim[]>} claimsByClient
 * @property {Map<string, Set<string>>} linesByClient
 */

/**
 * @param {import('./schema.js').Book} book
 * @returns {BookIndex}
 */
export function indexBook(book) {
  const clientsById = new Map(book.clients.map((c) => [c.id, c]));
  const policiesById = new Map(book.policies.map((p) => [p.id, p]));
  const policiesByClient = groupBy(book.policies, (p) => p.clientId);
  const membersByClient = groupBy(book.members, (m) => m.clientId);
  const claimsByClient = groupBy(book.claims, (c) => c.clientId);

  const linesByClient = new Map();
  for (const [clientId, list] of policiesByClient) {
    linesByClient.set(clientId, new Set(list.filter((p) => p.status === 'active').map((p) => p.line)));
  }

  return { book, clientsById, policiesById, policiesByClient, membersByClient, claimsByClient, linesByClient };
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    let bucket = map.get(key);
    if (!bucket) map.set(key, (bucket = []));
    bucket.push(item);
  }
  return map;
}

// -------------------------------------------------------------------- queries

/** @param {BookIndex} ix @param {string} clientId */
export function policiesFor(ix, clientId) {
  return (ix.policiesByClient.get(clientId) ?? []).filter((p) => p.status === 'active');
}

/** @param {BookIndex} ix @param {string} clientId */
export function membersFor(ix, clientId) {
  return (ix.membersByClient.get(clientId) ?? []).filter((m) => m.status !== 'terminated');
}

/** @param {BookIndex} ix @param {string} clientId */
export function claimsFor(ix, clientId) {
  return ix.claimsByClient.get(clientId) ?? [];
}

/** @param {BookIndex} ix @param {string} clientId @param {string} line */
export function hasLine(ix, clientId, line) {
  return ix.linesByClient.get(clientId)?.has(line) ?? false;
}

/** Total active premium for a client, normalised to TTD. */
export function clientPremiumTTD(ix, clientId) {
  return policiesFor(ix, clientId).reduce((sum, p) => sum + toTTD(p.annualPremium ?? 0, p.currency), 0);
}

/** Whole-of-book premium, normalised to TTD. */
export function bookPremiumTTD(ix) {
  return ix.book.policies
    .filter((p) => p.status === 'active')
    .reduce((sum, p) => sum + toTTD(p.annualPremium ?? 0, p.currency), 0);
}

/**
 * Filtered client search. Every filter is optional; passing none returns the
 * whole book, which is what the agent does when it wants to look around.
 *
 * @param {BookIndex} ix
 * @param {{
 *   query?: string, industry?: string, segment?: string,
 *   minHeadcount?: number, maxHeadcount?: number,
 *   hasLine?: string, missingLine?: string,
 *   renewalWithinDays?: number, accountExecutive?: string,
 *   minPremiumTTD?: number, limit?: number
 * }} [filters]
 */
export function searchClients(ix, filters = {}) {
  const {
    query, industry, segment, minHeadcount, maxHeadcount,
    hasLine: needsLine, missingLine, renewalWithinDays,
    accountExecutive, minPremiumTTD, limit = 50,
  } = filters;

  const q = query?.trim().toLowerCase();
  const results = [];

  for (const client of ix.book.clients) {
    if (q && !`${client.name} ${client.id} ${client.industry}`.toLowerCase().includes(q)) continue;
    if (industry && client.industry !== industry) continue;
    if (segment && client.segment !== segment) continue;
    if (minHeadcount != null && (client.headcount ?? 0) < minHeadcount) continue;
    if (maxHeadcount != null && (client.headcount ?? 0) > maxHeadcount) continue;
    if (accountExecutive && client.accountExecutive !== accountExecutive) continue;

    const lines = ix.linesByClient.get(client.id) ?? new Set();
    if (needsLine && !lines.has(needsLine)) continue;
    if (missingLine && lines.has(missingLine)) continue;

    const premium = clientPremiumTTD(ix, client.id);
    if (minPremiumTTD != null && premium < minPremiumTTD) continue;

    const nextRenewal = nextRenewalFor(ix, client.id);
    if (renewalWithinDays != null) {
      if (nextRenewal == null || nextRenewal.days > renewalWithinDays) continue;
    }

    results.push({
      id: client.id,
      name: client.name,
      industry: client.industry,
      segment: client.segment,
      headcount: client.headcount,
      annualRevenueTTD: client.annualRevenueTTD,
      accountExecutive: client.accountExecutive,
      linesHeld: [...lines].sort(),
      annualPremiumTTD: Math.round(premium),
      nextRenewal: nextRenewal ? { policyId: nextRenewal.policy.id, line: nextRenewal.policy.line, date: nextRenewal.policy.renewalDate, inDays: nextRenewal.days } : null,
    });
  }

  results.sort((a, b) => b.annualPremiumTTD - a.annualPremiumTTD);
  return { total: results.length, returned: Math.min(results.length, limit), clients: results.slice(0, limit) };
}

/** Soonest upcoming renewal for a client. @param {BookIndex} ix @param {string} clientId */
export function nextRenewalFor(ix, clientId, now = new Date()) {
  let best = null;
  for (const policy of policiesFor(ix, clientId)) {
    if (!isIsoDate(policy.renewalDate)) continue;
    const days = daysUntil(policy.renewalDate, now);
    if (days < 0) continue;
    if (!best || days < best.days) best = { policy, days };
  }
  return best;
}

/** @param {string} iso @param {Date} [now] */
export function daysUntil(iso, now = new Date()) {
  return Math.round((Date.parse(iso) - now.getTime()) / 86400000);
}

/** @param {string} iso @param {Date} [now] */
export function yearsSince(iso, now = new Date()) {
  return (now.getTime() - Date.parse(iso)) / (365.25 * 86400000);
}

/** Age in years at `now`. @param {string} dob */
export function ageOf(dob, now = new Date()) {
  return yearsSince(dob, now);
}

/**
 * Peer benchmarks derived from the book itself, so they reflect what AIB
 * actually places rather than an imported market assumption. A line held by
 * most of a client's peers and not by the client is a defensible finding;
 * one held by two of forty is not, which is why `minPeers` gates it.
 *
 * @param {BookIndex} ix
 * @param {{minPeers?: number}} [opts]
 * @returns {Map<string, {peers: string[], attachRate: Record<string, number>, medianPremiumTTD: number}>}
 */
export function buildBenchmarks(ix, opts = {}) {
  const minPeers = opts.minPeers ?? 3;
  const cohorts = new Map();

  for (const client of ix.book.clients) {
    const key = cohortKey(client);
    let cohort = cohorts.get(key);
    if (!cohort) cohorts.set(key, (cohort = []));
    cohort.push(client);
  }

  const out = new Map();
  for (const [key, cohort] of cohorts) {
    if (cohort.length < minPeers) continue;
    const counts = new Map();
    const premiums = [];
    for (const client of cohort) {
      premiums.push(clientPremiumTTD(ix, client.id));
      for (const line of ix.linesByClient.get(client.id) ?? []) {
        counts.set(line, (counts.get(line) ?? 0) + 1);
      }
    }
    const attachRate = {};
    for (const [line, n] of counts) attachRate[line] = n / cohort.length;
    out.set(key, {
      peers: cohort.map((c) => c.id),
      attachRate,
      medianPremiumTTD: Math.round(median(premiums)),
    });
  }
  return out;
}

/** Cohort a client belongs to for benchmarking: industry crossed with size band. */
export function cohortKey(client) {
  return `${client.industry}::${sizeBand(client.headcount ?? 0)}`;
}

/** @param {number} headcount */
export function sizeBand(headcount) {
  if (headcount === 0) return 'personal';
  if (headcount < 50) return 'small';
  if (headcount < 200) return 'mid';
  return 'large';
}

/** @param {number[]} values */
export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Claims rolled up by category for a client, in TTD. This is the evidence base
 * for every claims-driven recommendation.
 * @param {BookIndex} ix @param {string} clientId @param {{sinceDays?: number}} [opts]
 */
export function claimsSummary(ix, clientId, opts = {}) {
  const sinceDays = opts.sinceDays ?? 730;
  const cutoff = Date.now() - sinceDays * 86400000;
  const rows = claimsFor(ix, clientId).filter((c) => Date.parse(c.date) >= cutoff);

  const byCategory = {};
  for (const claim of rows) {
    const bucket = (byCategory[claim.category] ??= {
      count: 0, paidCount: 0, declinedCount: 0, openCount: 0,
      paidTTD: 0, declinedTTD: 0, declineReasons: {},
    });
    bucket.count++;
    const ttd = toTTD(claim.amount, claim.currency);
    if (claim.status === 'paid') { bucket.paidCount++; bucket.paidTTD += ttd; }
    else if (claim.status === 'declined') {
      bucket.declinedCount++;
      bucket.declinedTTD += ttd;
      if (claim.declineReason) {
        bucket.declineReasons[claim.declineReason] = (bucket.declineReasons[claim.declineReason] ?? 0) + 1;
      }
    } else bucket.openCount++;
  }

  for (const bucket of Object.values(byCategory)) {
    bucket.paidTTD = Math.round(bucket.paidTTD);
    bucket.declinedTTD = Math.round(bucket.declinedTTD);
  }

  const premium = clientPremiumTTD(ix, clientId);
  const paidTTD = Object.values(byCategory).reduce((s, b) => s + b.paidTTD, 0);

  return {
    clientId,
    windowDays: sinceDays,
    totalClaims: rows.length,
    paidTTD,
    annualPremiumTTD: Math.round(premium),
    // Indicative only: premium is annual, the window is usually two years.
    lossRatioIndicative: premium > 0 ? Number((paidTTD / (premium * (sinceDays / 365))).toFixed(2)) : null,
    byCategory,
  };
}
