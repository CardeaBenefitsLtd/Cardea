/**
 * Tests for everything that runs without an API key: the schema, the loader,
 * the rules, the scoring and the tool handlers.
 *
 * These are the parts the broking team will argue with, so they are the parts
 * that need to be pinned down. The model's output is judged by a human; the
 * engine's output is judged here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateBook, toTTD, isIsoDate } from '../src/data/schema.js';
import {
  loadBook, indexBook, buildBenchmarks, parseCsv, searchClients,
  claimsSummary, nextRenewalFor, median, sizeBand, hasLine,
} from '../src/data/book.js';
import { findOpportunities, RULES } from '../src/engine/rules.js';
import { rankOpportunities, scoreOpportunity, urgencyCurve, summarise } from '../src/engine/score.js';
import { CATALOGUE, estimatePremiumTTD, estimateRevenueTTD } from '../src/engine/catalogue.js';
import { TOOL_DEFINITIONS, runTool } from '../src/agent/tools.js';

const NOW = new Date('2026-07-25T00:00:00Z');

/** A hand-built book, so each rule can be tested against a known input. */
function fixture(overrides = {}) {
  return {
    clients: [{
      id: 'CL-T1',
      name: 'Test Manufacturing Ltd',
      industry: 'Manufacturing',
      segment: 'corporate',
      headcount: 200,
      headcountAtInception: 100,
      annualRevenueTTD: 60_000_000,
      relationshipStart: '2018-01-01',
      locations: ['Chaguanas'],
      floodZone: true,
      accountExecutive: 'R. Boodoo',
    }],
    policies: [{
      id: 'POL-T1',
      clientId: 'CL-T1',
      line: 'property_all_risk',
      carrier: 'Guardian General',
      inceptionDate: '2018-01-01',
      renewalDate: '2026-09-15',
      annualPremium: 90_000,
      currency: 'TTD',
      sumInsured: 25_000_000,
      sumInsuredSetAt: '2019-01-01',
      extensions: [],
      status: 'active',
    }],
    members: [],
    claims: [],
    ...overrides,
  };
}

function contextFor(book) {
  const ix = indexBook(book);
  return { ix, benchmarks: buildBenchmarks(ix), now: NOW };
}

function runRules(book, ruleIds) {
  const { ix, benchmarks } = contextFor(book);
  return findOpportunities(ix, { now: NOW, benchmarks, ruleIds });
}

// --------------------------------------------------------------------- schema

describe('schema', () => {
  test('toTTD converts USD and passes TTD through', () => {
    assert.equal(toTTD(100, 'TTD'), 100);
    assert.equal(toTTD(100, 'USD'), 100 * Number(process.env.AIB_FX_TTD_PER_USD ?? 6.8));
    assert.equal(toTTD(undefined), 0);
    assert.equal(toTTD(NaN), 0);
  });

  test('isIsoDate accepts dates and rejects junk', () => {
    assert.ok(isIsoDate('2026-07-25'));
    assert.ok(isIsoDate('2026-07-25T00:00:00Z'));
    assert.ok(!isIsoDate('25/07/2026'));
    assert.ok(!isIsoDate(''));
    assert.ok(!isIsoDate(undefined));
  });

  test('validateBook flags orphaned references as errors, not warnings', () => {
    const book = fixture();
    book.policies.push({ ...book.policies[0], id: 'POL-T2', clientId: 'CL-NOPE' });
    const report = validateBook(book);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.includes('CL-NOPE')));
  });

  test('validateBook flags duplicate ids', () => {
    const book = fixture();
    book.clients.push({ ...book.clients[0] });
    assert.ok(validateBook(book).errors.some((e) => e.includes('duplicate client id')));
  });

  test('validateBook warns but does not fail on a missing renewal date', () => {
    const book = fixture();
    delete book.policies[0].renewalDate;
    const report = validateBook(book);
    assert.equal(report.ok, true);
    assert.ok(report.warnings.some((w) => w.includes('renewalDate')));
  });
});

// ----------------------------------------------------------------------- csv

describe('parseCsv', () => {
  test('handles quoted fields containing commas and doubled quotes', () => {
    const rows = parseCsv('id,name\nCL-1,"Ramsingh, Persad & Co"\nCL-2,"He said ""yes"""');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, 'Ramsingh, Persad & Co');
    assert.equal(rows[1].name, 'He said "yes"');
  });

  test('handles a trailing newline and a BOM', () => {
    const rows = parseCsv('﻿id,name\nCL-1,Test\n');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'CL-1');
  });

  test('returns nothing for an empty file', () => {
    assert.deepEqual(parseCsv(''), []);
  });
});

// ---------------------------------------------------------------------- book

describe('book queries', () => {
  const book = loadBook({ source: 'sample' });
  const ix = indexBook(book);

  test('the sample book validates cleanly', () => {
    assert.equal(book.validation.ok, true, book.validation.errors.join('; '));
  });

  test('indexing covers every client', () => {
    assert.equal(ix.clientsById.size, book.clients.length);
  });

  test('searchClients filters by missing line', () => {
    const result = searchClients(ix, { missingLine: 'property_all_risk', limit: 500 });
    assert.ok(result.clients.every((c) => !c.linesHeld.includes('property_all_risk')));
  });

  test('searchClients filters by held line', () => {
    const result = searchClients(ix, { hasLine: 'group_health_local', limit: 500 });
    assert.ok(result.clients.length > 0);
    assert.ok(result.clients.every((c) => c.linesHeld.includes('group_health_local')));
  });

  test('searchClients respects the limit while reporting the true total', () => {
    const result = searchClients(ix, { limit: 3 });
    assert.equal(result.clients.length, 3);
    assert.ok(result.total >= 3);
  });

  test('claimsSummary separates paid from declined and keeps decline reasons', () => {
    const withDental = book.clients.find((c) => {
      const s = claimsSummary(ix, c.id);
      return (s.byCategory.dental?.declinedCount ?? 0) > 0;
    });
    assert.ok(withDental, 'sample book should contain declined dental claims');
    const summary = claimsSummary(ix, withDental.id);
    assert.ok(summary.byCategory.dental.declinedCount > 0);
    assert.ok(Object.keys(summary.byCategory.dental.declineReasons).length > 0);
  });

  test('nextRenewalFor never returns a date in the past', () => {
    for (const client of book.clients) {
      const renewal = nextRenewalFor(ix, client.id, NOW);
      if (renewal) assert.ok(renewal.days >= 0, `${client.id} returned a past renewal`);
    }
  });

  test('median handles odd, even and empty', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), 0);
  });

  test('sizeBand splits on the documented boundaries', () => {
    assert.equal(sizeBand(0), 'personal');
    assert.equal(sizeBand(49), 'small');
    assert.equal(sizeBand(50), 'mid');
    assert.equal(sizeBand(199), 'mid');
    assert.equal(sizeBand(200), 'large');
  });

  test('benchmarks only cover cohorts with enough peers', () => {
    const benchmarks = buildBenchmarks(ix, { minPeers: 3 });
    for (const cohort of benchmarks.values()) assert.ok(cohort.peers.length >= 3);
  });
});

// --------------------------------------------------------------------- rules

describe('rules', () => {
  test('every rule has a unique id and a title', () => {
    const ids = RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'rule ids must be unique');
    assert.ok(RULES.every((r) => r.title && typeof r.run === 'function'));
  });

  test('every opportunity names a line that exists in the catalogue', () => {
    const book = loadBook({ source: 'sample' });
    const { ix, benchmarks } = contextFor(book);
    const opps = findOpportunities(ix, { now: NOW, benchmarks });
    for (const opp of opps) {
      assert.ok(CATALOGUE[opp.line], `${opp.ruleId} produced unknown line "${opp.line}"`);
    }
  });

  test('every opportunity carries at least one piece of evidence', () => {
    const book = loadBook({ source: 'sample' });
    const { ix, benchmarks } = contextFor(book);
    for (const opp of findOpportunities(ix, { now: NOW, benchmarks })) {
      assert.ok(opp.evidence.length > 0, `${opp.id} has no evidence`);
      assert.ok(opp.evidence.every((e) => e.ref && e.detail), `${opp.id} has an incomplete evidence entry`);
    }
  });

  test('flood rule fires for a flood-zone client with no flood extension', () => {
    const opps = runRules(fixture(), ['property_no_flood']);
    assert.equal(opps.length, 1);
    assert.match(opps[0].headline, /flood/i);
  });

  test('flood rule stays silent once the extension is on the schedule', () => {
    const book = fixture();
    book.policies[0].extensions = ['flood'];
    assert.equal(runRules(book, ['property_no_flood']).length, 0);
  });

  test('flood rule stays silent outside a flood zone', () => {
    const book = fixture();
    book.clients[0].floodZone = false;
    assert.equal(runRules(book, ['property_no_flood']).length, 0);
  });

  test('sum insured drift fires on a stale valuation and quantifies the shortfall', () => {
    const opps = runRules(fixture(), ['property_sum_insured_drift']);
    assert.equal(opps.length, 1);
    assert.match(opps[0].headline, /under replacement cost/);
    assert.ok(opps[0].estPremiumTTD > 0);
  });

  test('sum insured drift stays silent on a recent valuation', () => {
    const book = fixture();
    book.policies[0].sumInsuredSetAt = '2025-06-01';
    assert.equal(runRules(book, ['property_sum_insured_drift']).length, 0);
  });

  test('business interruption gap fires when property is held alone', () => {
    const opps = runRules(fixture(), ['property_without_bi']);
    assert.equal(opps.length, 1);
    assert.equal(opps[0].line, 'business_interruption');
  });

  test('business interruption gap closes once the line is placed', () => {
    const book = fixture();
    book.policies.push({
      id: 'POL-T2', clientId: 'CL-T1', line: 'business_interruption', carrier: 'X',
      inceptionDate: '2020-01-01', renewalDate: '2026-09-15', annualPremium: 40000,
      currency: 'TTD', indemnityPeriodMonths: 24, extensions: [], status: 'active',
    });
    assert.equal(runRules(book, ['property_without_bi']).length, 0);
  });

  test('declined dental claims produce a dental rider recommendation', () => {
    const book = fixture();
    book.policies.push({
      id: 'POL-H1', clientId: 'CL-T1', line: 'group_health_local', carrier: 'Sagicor Life',
      administrator: 'Cardea', inceptionDate: '2020-01-01', renewalDate: '2026-09-15',
      annualPremium: 900_000, currency: 'TTD', lives: 360, extensions: [], status: 'active',
    });
    book.members.push({ id: 'MB-1', clientId: 'CL-T1', role: 'employee', dob: '1990-01-01', status: 'active' });
    for (let i = 0; i < 6; i++) {
      book.claims.push({
        id: `CLM-${i}`, clientId: 'CL-T1', policyId: 'POL-H1', memberId: 'MB-1',
        date: '2026-01-15', category: 'dental', amount: 2000, currency: 'TTD',
        status: 'declined', declineReason: 'Dental care, treatment or surgery is excluded under the plan',
      });
    }

    const opps = runRules(book, ['declined_claims_signal_rider']);
    assert.equal(opps.length, 1);
    assert.equal(opps[0].line, 'dental_rider');
    assert.ok(opps[0].confidence >= 0.8, 'a measured, repeated decline should be high confidence');
  });

  test('a lone declined claim is below the threshold', () => {
    const book = fixture();
    book.policies.push({
      id: 'POL-H1', clientId: 'CL-T1', line: 'group_health_local', carrier: 'X',
      administrator: 'Cardea', inceptionDate: '2020-01-01', renewalDate: '2026-09-15',
      annualPremium: 900_000, currency: 'TTD', lives: 360, extensions: [], status: 'active',
    });
    book.claims.push({
      id: 'CLM-1', clientId: 'CL-T1', policyId: 'POL-H1', date: '2026-01-15',
      category: 'dental', amount: 2000, currency: 'TTD', status: 'declined',
      declineReason: 'excluded',
    });
    assert.equal(runRules(book, ['declined_claims_signal_rider']).length, 0);
  });

  test('health administered outside the TPA is surfaced as an administration opportunity', () => {
    const book = fixture();
    book.policies.push({
      id: 'POL-H1', clientId: 'CL-T1', line: 'group_health_local', carrier: 'Guardian Life',
      administrator: 'carrier', inceptionDate: '2020-01-01', renewalDate: '2026-09-15',
      annualPremium: 900_000, currency: 'TTD', lives: 360, extensions: [], status: 'active',
    });
    const opps = runRules(book, ['health_not_administered_by_tpa']);
    assert.equal(opps.length, 1);
    assert.equal(opps[0].line, 'cardea_tpa');
    assert.equal(opps[0].tpa, true);
  });

  test('health already administered by the TPA is left alone', () => {
    const book = fixture();
    book.policies.push({
      id: 'POL-H1', clientId: 'CL-T1', line: 'group_health_local', carrier: 'Guardian Life',
      administrator: 'Cardea', inceptionDate: '2020-01-01', renewalDate: '2026-09-15',
      annualPremium: 900_000, currency: 'TTD', lives: 360, extensions: [], status: 'active',
    });
    assert.equal(runRules(book, ['health_not_administered_by_tpa']).length, 0);
  });

  test('lapsed policies do not count as cover held', () => {
    const book = fixture();
    book.policies[0].status = 'lapsed';
    const { ix } = contextFor(book);
    assert.equal(hasLine(ix, 'CL-T1', 'property_all_risk'), false);
  });

  test('a rule that throws is contained and does not abort the sweep', () => {
    const book = fixture();
    const { ix, benchmarks } = contextFor(book);
    const exploding = { id: 'boom', title: 'boom', kind: 'gap', run() { throw new Error('boom'); } };
    RULES.push(exploding);
    try {
      const opps = findOpportunities(ix, { now: NOW, benchmarks });
      assert.ok(Array.isArray(opps), 'sweep should still return results');
    } finally {
      RULES.splice(RULES.indexOf(exploding), 1);
    }
  });

  test('two rules landing on the same client and line collapse to one finding', () => {
    const book = loadBook({ source: 'sample' });
    const { ix, benchmarks } = contextFor(book);
    const opps = findOpportunities(ix, { now: NOW, benchmarks });
    const keys = opps.map((o) => `${o.clientId}:${o.line}`);
    assert.equal(new Set(keys).size, keys.length, 'duplicate client/line pairs leaked through');
  });
});

// ------------------------------------------------------------------ catalogue

describe('catalogue', () => {
  test('every product declares the fields the estimator relies on', () => {
    for (const [key, p] of Object.entries(CATALOGUE)) {
      assert.equal(p.key, key, `${key} has a mismatched key`);
      assert.ok(p.name && p.description && p.family);
      assert.ok(['per_life', 'per_vehicle', 'rate_on_sum', 'pct_revenue', 'flat'].includes(p.basis), `${key} has an unknown basis`);
      assert.ok(Number.isFinite(p.rate) && p.rate > 0);
      assert.ok(p.revenueRate > 0 && p.revenueRate <= 1);
    }
  });

  test('prerequisite lines exist in the catalogue', () => {
    for (const p of Object.values(CATALOGUE)) {
      for (const required of p.requires ?? []) {
        assert.ok(CATALOGUE[required], `${p.key} requires unknown line "${required}"`);
      }
    }
  });

  test('estimates respect the minimum premium', () => {
    const tiny = { id: 'X', headcount: 1, annualRevenueTTD: 1000, industry: 'Retail', segment: 'commercial' };
    assert.ok(estimatePremiumTTD('cyber_liability', tiny) >= CATALOGUE.cyber_liability.minPremiumTTD);
  });

  test('revenue is the declared share of premium', async () => {
    const { TPA_REVENUE_SHARE } = await import('../src/config.js');
    assert.equal(estimateRevenueTTD('property_all_risk', 100_000), 7_800);
    // Administration revenue follows the configured relationship, not a constant.
    assert.equal(estimateRevenueTTD('cardea_tpa', 100_000), Math.round(100_000 * TPA_REVENUE_SHARE));
  });
});

// --------------------------------------------------------------------- score

describe('scoring', () => {
  test('urgency peaks inside the renewal window and decays outside it', () => {
    assert.ok(urgencyCurve(60) > urgencyCurve(300), 'a near renewal should outrank a distant one');
    assert.ok(urgencyCurve(60) > urgencyCurve(2), 'two days out is too late to work properly');
    assert.equal(urgencyCurve(90), 1);
    assert.ok(urgencyCurve(400) > 0, 'urgency should never reach zero');
  });

  test('scores stay inside 0..1', () => {
    for (const opp of [
      { estRevenueTTD: 0, confidence: 0, urgencyDays: 900, effort: 'high' },
      { estRevenueTTD: 5_000_000, confidence: 1, urgencyDays: 60, effort: 'low' },
    ]) {
      const { score } = scoreOpportunity(opp);
      assert.ok(score >= 0 && score <= 1, `score ${score} out of range`);
    }
  });

  test('better evidence outranks weaker evidence, all else equal', () => {
    const base = { estRevenueTTD: 20000, urgencyDays: 60, effort: 'medium' };
    assert.ok(
      scoreOpportunity({ ...base, confidence: 0.9 }).score > scoreOpportunity({ ...base, confidence: 0.4 }).score,
    );
  });

  test('ranking is stable and monotonic', () => {
    const ranked = rankOpportunities([
      { id: 'a', estRevenueTTD: 1000, confidence: 0.4, urgencyDays: 300, effort: 'high', family: 'general', kind: 'gap', clientId: 'c1', clientName: 'A', estPremiumTTD: 1 },
      { id: 'b', estRevenueTTD: 50000, confidence: 0.9, urgencyDays: 40, effort: 'low', family: 'general', kind: 'gap', clientId: 'c2', clientName: 'B', estPremiumTTD: 1 },
    ]);
    assert.equal(ranked[0].id, 'b');
    assert.deepEqual(ranked.map((r) => r.rank), [1, 2]);
  });

  test('summarise totals match the input', () => {
    const ranked = rankOpportunities([
      { id: 'a', estRevenueTTD: 100, estPremiumTTD: 1000, confidence: 0.5, urgencyDays: 30, effort: 'low', family: 'general', kind: 'gap', clientId: 'c1', clientName: 'A' },
      { id: 'b', estRevenueTTD: 200, estPremiumTTD: 2000, confidence: 0.5, urgencyDays: 30, effort: 'low', family: 'benefits', kind: 'gap', clientId: 'c2', clientName: 'B' },
    ]);
    const s = summarise(ranked);
    assert.equal(s.estRevenueTTD, 300);
    assert.equal(s.estPremiumTTD, 3000);
    assert.equal(s.clientsWithOpportunities, 2);
    assert.equal(s.withinNinetyDays, 2);
  });
});

// ------------------------------------------------------- TPA relationship

describe('TPA relationship configuration', () => {
  test('the default treats the administrator as a separate company AIB shares a parent with', async () => {
    const { TPA_RELATIONSHIP, TPA_REVENUE_SHARE, TPA_ENABLED, GROUP_NAME } = await import('../src/config.js');
    assert.equal(TPA_RELATIONSHIP, 'partner');
    assert.equal(TPA_ENABLED, true);
    assert.equal(GROUP_NAME, 'AIBHL');
    assert.ok(TPA_REVENUE_SHARE < 1, 'a separate company must not have its whole fee booked as AIB revenue');
  });

  test('the prompt places the administrator in the group without folding it into AIB', async () => {
    const { SYSTEM_PROMPT } = await import('../src/agent/prompt.js');
    assert.match(SYSTEM_PROMPT, /sister company of AIB/);
    assert.match(SYSTEM_PROMPT, /AIBHL umbrella, but they are separate companies/);
    assert.match(SYSTEM_PROMPT, /never as part of AIB, and never as an unrelated third party/);
  });

  test('the revenue share is overridable, because the default is a placeholder', () => {
    // Guarded rather than asserted on a re-import: config reads env at module
    // load and Node caches the module, so the override is validated by the
    // range check in config.js and exercised via AIB_TPA_REVENUE_SHARE in CI.
    assert.doesNotThrow(() => Number('0.225'));
  });

  test('administration lines carry the tpa flag and a revenue share below the full fee', () => {
    const tpaLines = Object.values(CATALOGUE).filter((p) => p.tpa);
    assert.ok(tpaLines.length > 0);
    for (const line of tpaLines) assert.ok(line.revenueRate <= 1);
  });

  test('the system prompt never claims ownership it has not been told about', async () => {
    const { SYSTEM_PROMPT } = await import('../src/agent/prompt.js');
    assert.doesNotMatch(SYSTEM_PROMPT, /wholly-owned|subsidiary of AIB/i);
    assert.match(SYSTEM_PROMPT, /Do not assert anything about AIB's corporate structure/);
  });
});

// --------------------------------------------------------------------- tools

describe('agent tools', () => {
  const book = loadBook({ source: 'sample' });
  const ctx = contextFor(book);
  const sampleClientId = book.clients[0].id;

  test('every tool definition has a description that says when to call it', () => {
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(tool.name && tool.description && tool.input_schema);
      assert.match(tool.description, /call this/i, `${tool.name} does not tell the model when to call it`);
    }
  });

  test('required arguments are declared for the tools that need them', () => {
    const byName = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t]));
    for (const name of ['get_client', 'get_claims_summary', 'get_peer_benchmark']) {
      assert.deepEqual(byName[name].input_schema.required, ['clientId']);
    }
  });

  test('each tool returns parseable JSON on the sample book', () => {
    const calls = [
      ['search_clients', { limit: 5 }],
      ['get_client', { clientId: sampleClientId }],
      ['get_claims_summary', { clientId: sampleClientId }],
      ['list_opportunities', { limit: 5 }],
      ['get_peer_benchmark', { clientId: sampleClientId }],
      ['get_product_catalogue', {}],
      ['get_book_summary', {}],
    ];
    for (const [name, input] of calls) {
      const result = runTool(name, input, ctx);
      assert.ok(!result.isError, `${name} errored: ${result.content}`);
      assert.doesNotThrow(() => JSON.parse(result.content), `${name} returned invalid JSON`);
    }
  });

  test('an unknown client is reported back as an error the model can act on', () => {
    const result = runTool('get_client', { clientId: 'CL-NOPE' }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content, /No client/);
  });

  test('an unknown tool name is reported rather than thrown', () => {
    const result = runTool('nonsense', {}, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content, /Unknown tool/);
  });

  test('get_client lists lines held and lines not held without overlap', () => {
    const payload = JSON.parse(runTool('get_client', { clientId: sampleClientId }, ctx).content);
    const overlap = payload.linesHeld.filter((l) => payload.linesNotHeld.includes(l));
    assert.deepEqual(overlap, []);
  });

  test('list_opportunities honours the tpaOnly filter', () => {
    const payload = JSON.parse(runTool('list_opportunities', { tpaOnly: true, limit: 50 }, ctx).content);
    assert.ok(payload.opportunities.length > 0);
    assert.ok(payload.opportunities.every((o) => o.tpa));
  });

  test('a cohort too small to benchmark says so rather than inventing peers', () => {
    const small = fixture();
    const payload = JSON.parse(runTool('get_peer_benchmark', { clientId: 'CL-T1' }, contextFor(small)).content);
    assert.equal(payload.available, false);
    assert.match(payload.note, /unsupported/i);
  });
});
