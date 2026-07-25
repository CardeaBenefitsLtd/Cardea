/**
 * Tests for the IBR register adapter and the capability gating it exists to
 * feed.
 *
 * The fixture mirrors the real register's shape — invoice-level rows, taxes and
 * fees alongside premium, reversals, multiple terms per policy — because every
 * one of those is a way to get the premium total wrong.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildBook, normalisePolicyNumber, money, isoDate, PREMIUM_BEARING } from '../src/data/adapters/ibr.js';
import { bookCapabilities } from '../src/data/schema.js';
import { indexBook, clientPremiumTTD, hasSemantic, departmentsFor } from '../src/data/book.js';
import { findOpportunities, dormantRules, RULES } from '../src/engine/rules.js';

const HEADER = {
  'Billed From': '', 'Account Name': '', 'Name': '', 'Policy Number': '', 'Policy/Line': '',
  'Profit Centre Name': '', 'Department Name': '', 'ICO': '', 'Policy Effective Date': '',
  'Policy Expiration Date': '', 'Gross Premium TTD': '', 'Total Brokerage': '', 'Agcy Com %': '',
  'Trans Code': '', 'Trans Date Entered': '', 'Reversed': 'No', 'Branch': 'All Branches',
};

const row = (over) => ({ ...HEADER, ...over });

/** One corporate account with property, plus a benefits account. */
function registerRows() {
  return [
    row({ 'Billed From': 'ACMECO-01', 'Account Name': 'Acme Ltd', 'Name': 'R. Boodoo',
      'Policy Number': 'TT FAR 1041794', 'Policy/Line': 'ARPR', 'Profit Centre Name': 'Property',
      'Department Name': 'Corporate', 'ICO': 'GUARD1', 'Policy Effective Date': '2026-01-01 00:00:00',
      'Policy Expiration Date': '2027-01-01 00:00:00', 'Gross Premium TTD': '100,000',
      'Total Brokerage': '7,800', 'Trans Code': 'RENB', 'Trans Date Entered': '2026-01-05 00:00:00' }),
    // Same policy, spacing differs — must not become a second policy.
    row({ 'Billed From': 'ACMECO-01', 'Account Name': 'Acme Ltd', 'Policy Number': 'TTFAR1041794',
      'Policy/Line': 'ARPR', 'Profit Centre Name': 'Property', 'Department Name': 'Corporate',
      'Policy Effective Date': '2026-01-01 00:00:00', 'Policy Expiration Date': '2027-01-01 00:00:00',
      'Gross Premium TTD': '20,000', 'Total Brokerage': '1,560', 'Trans Code': 'ENDT',
      'Trans Date Entered': '2026-03-01 00:00:00' }),
    // Tax row — must not count as premium.
    row({ 'Billed From': 'ACMECO-01', 'Account Name': 'Acme Ltd', 'Policy Number': 'TT FAR 1041794',
      'Policy/Line': 'ARPR', 'Profit Centre Name': 'Property', 'Department Name': 'Corporate',
      'Policy Effective Date': '2026-01-01 00:00:00', 'Policy Expiration Date': '2027-01-01 00:00:00',
      'Gross Premium TTD': '6,000', 'Trans Code': 'ITAX', 'Trans Date Entered': '2026-01-05 00:00:00' }),
    // Reversal — must be excluded.
    row({ 'Billed From': 'ACMECO-01', 'Account Name': 'Acme Ltd', 'Policy Number': 'TT FAR 1041794',
      'Policy/Line': 'ARPR', 'Profit Centre Name': 'Property', 'Department Name': 'Corporate',
      'Policy Effective Date': '2026-01-01 00:00:00', 'Policy Expiration Date': '2027-01-01 00:00:00',
      'Gross Premium TTD': '50,000', 'Trans Code': 'RENB', 'Reversed': 'Yes',
      'Trans Date Entered': '2026-02-01 00:00:00' }),
    // Prior term of the same policy.
    row({ 'Billed From': 'ACMECO-01', 'Account Name': 'Acme Ltd', 'Policy Number': 'TTFAR1041794',
      'Policy/Line': 'ARPR', 'Profit Centre Name': 'Property', 'Department Name': 'Corporate',
      'Policy Effective Date': '2025-01-01 00:00:00', 'Policy Expiration Date': '2026-01-01 00:00:00',
      'Gross Premium TTD': '90,000', 'Total Brokerage': '7,020', 'Trans Code': 'RENB',
      'Trans Date Entered': '2025-01-05 00:00:00' }),
    // A benefits account with health but no life.
    row({ 'Billed From': 'BENECO-01', 'Account Name': 'Bene Ltd', 'Policy Number': 'GH-900',
      'Policy/Line': 'GPHH', 'Profit Centre Name': 'Accident and Sickness',
      'Department Name': 'Employee Benefits', 'ICO': 'SAGIC1',
      'Policy Effective Date': '2026-02-01 00:00:00', 'Policy Expiration Date': '2027-02-01 00:00:00',
      'Gross Premium TTD': '900,000', 'Total Brokerage': '54,900', 'Trans Code': 'RENB',
      'Trans Date Entered': '2026-02-03 00:00:00' }),
  ];
}

describe('IBR adapter', () => {
  const book = buildBook(registerRows());
  const ix = indexBook(book);

  test('collapses invoice rows into clients and policies', () => {
    assert.equal(book.clients.length, 2);
    assert.equal(book.policies.length, 2, 'two policies, not one per transaction');
  });

  test('policy numbers differing only by spacing are the same policy', () => {
    assert.equal(normalisePolicyNumber('TT FAR 1041794'), normalisePolicyNumber('TTFAR1041794'));
    const acme = book.policies.filter((p) => p.clientId === 'ACMECO-01');
    assert.equal(acme.length, 1, 'spacing variants must not split a policy in two');
  });

  test('placeholder policy numbers are not treated as identifiers', () => {
    for (const junk of ['NO NUMBER', 'N/A', 'none', '', 'NIL']) {
      assert.equal(normalisePolicyNumber(junk), '', `${junk} should not key a policy`);
    }
  });

  test('taxes, fees and reversals are excluded from premium', () => {
    const acme = book.policies.find((p) => p.clientId === 'ACMECO-01');
    // 100,000 renewal + 20,000 endorsement. The 6,000 tax and the 50,000
    // reversal must not appear.
    assert.equal(acme.annualPremium, 120_000);
    assert.equal(book.meta.reversedRowsExcluded, 1);
  });

  test('only premium-bearing codes contribute', () => {
    for (const code of ['ITAX', 'GTAX', 'PFEE', 'CFEE', 'MCTX']) {
      assert.ok(!PREMIUM_BEARING.has(code), `${code} must not count as premium`);
    }
    for (const code of ['NEWB', 'RENB', 'ENDT']) assert.ok(PREMIUM_BEARING.has(code));
  });

  test('the prior term is kept so a shrinking renewal is visible', () => {
    const acme = book.policies.find((p) => p.clientId === 'ACMECO-01');
    assert.equal(acme.termCount, 2);
    assert.equal(acme.priorTermPremiumTTD, 90_000);
  });

  test('client premium aggregates its policies', () => {
    assert.equal(Math.round(clientPremiumTTD(ix, 'ACMECO-01')), 120_000);
  });

  test('the register taxonomy is learned, not guessed', () => {
    const acme = book.policies.find((p) => p.clientId === 'ACMECO-01');
    assert.equal(acme.lineCode, 'ARPR');
    assert.equal(acme.profitCentre, 'Property');
    assert.equal(hasSemantic(ix, 'BENECO-01', 'health'), true, 'GPHH should read as health cover');
    assert.equal(hasSemantic(ix, 'BENECO-01', 'life'), false);
  });

  test('departments are carried through', () => {
    assert.deepEqual([...departmentsFor(ix, 'ACMECO-01')], ['Corporate']);
    assert.deepEqual([...departmentsFor(ix, 'BENECO-01')], ['Employee Benefits']);
  });

  test('money and date parsing handle the register conventions', () => {
    assert.equal(money('1,240,000.00'), 1240000);
    assert.equal(money('(500)'), -500);
    assert.equal(money(''), 0);
    assert.equal(isoDate('2026-07-25 00:00:00'), '2026-07-25');
    assert.equal(isoDate(''), undefined);
  });
});

describe('capability gating', () => {
  const book = buildBook(registerRows());
  const capabilities = bookCapabilities(book);

  test('the register reports what it has and what it does not', () => {
    assert.equal(capabilities.premium, true);
    assert.equal(capabilities.renewalDate, true);
    assert.equal(capabilities.department, true);
    for (const absent of ['sumInsured', 'extensions', 'claims', 'census', 'headcount', 'revenue', 'industry']) {
      assert.equal(capabilities[absent], false, `${absent} must be reported absent`);
    }
  });

  test('rules needing absent data are skipped, not run on nothing', () => {
    const ix = indexBook(book);
    findOpportunities(ix, { now: new Date('2026-07-25'), benchmarks: new Map(), capabilities });
    const dormant = dormantRules();
    assert.ok(dormant.length > 0);

    const ids = new Set(dormant.map((d) => d.ruleId));
    for (const shouldSleep of ['property_no_flood', 'declined_claims_signal_rider', 'dependants_ageing_out']) {
      assert.ok(ids.has(shouldSleep), `${shouldSleep} must be dormant without its data`);
    }
    // And each one says what it was missing, so the gap is diagnosable.
    assert.ok(dormant.every((d) => d.missing.length > 0));
  });

  test('every rule declares what it needs', () => {
    for (const rule of RULES) {
      assert.ok(Array.isArray(rule.requires), `${rule.id} does not declare requires[]`);
    }
  });

  test('the health-without-life rule fires on register taxonomy', () => {
    const ix = indexBook(book);
    const found = findOpportunities(ix, { now: new Date('2026-07-25'), benchmarks: new Map(), capabilities })
      .filter((o) => o.ruleId === 'health_without_group_life');
    assert.equal(found.length, 1, 'GPHH without GLFH/GPLF should be found');
    assert.equal(found[0].clientId, 'BENECO-01');
  });
});
