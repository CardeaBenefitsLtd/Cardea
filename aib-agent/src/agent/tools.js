/**
 * The analyst's read-only view of the book.
 *
 * Every tool here is a query. Nothing writes, nothing sends, nothing quotes.
 * That is a deliberate boundary rather than an oversight: an agent that can
 * only read can be wrong, but it cannot do damage, and that is the right shape
 * for the first AI system to touch a live book of business. Actions that reach
 * a client stay behind a broker.
 *
 * Tool descriptions say *when* to call the tool, not just what it does — the
 * model reaches for tools noticeably more reliably when the trigger condition
 * is part of the description.
 */

import {
  searchClients, policiesFor, membersFor, claimsSummary,
  clientPremiumTTD, nextRenewalFor, cohortKey, ageOf,
} from '../data/book.js';
import { findOpportunities } from '../engine/rules.js';
import { rankOpportunities, summarise } from '../engine/score.js';
import { CATALOGUE } from '../engine/catalogue.js';
import { INDUSTRIES } from '../data/schema.js';

/** @typedef {{ix: import('../data/book.js').BookIndex, benchmarks: Map<string,any>, now: Date}} ToolContext */

export const TOOL_DEFINITIONS = [
  {
    name: 'search_clients',
    description:
      'Search AIB\'s client list with filters. Call this whenever you need to find clients matching a shape — an industry, a size band, everyone missing a particular line, everyone renewing soon — or when you want to see what is on the book at all. Returns a summary per client including lines held, annual premium and next renewal. Pass no filters to see the whole book.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text matched against client name, id and industry.' },
        industry: { type: 'string', enum: INDUSTRIES },
        segment: { type: 'string', enum: ['commercial', 'corporate', 'personal'] },
        minHeadcount: { type: 'number' },
        maxHeadcount: { type: 'number' },
        hasLine: { type: 'string', description: 'Only clients who hold this line. Use a key from get_product_catalogue.' },
        missingLine: { type: 'string', description: 'Only clients who do NOT hold this line. The main way to find coverage gaps across the book.' },
        renewalWithinDays: { type: 'number', description: 'Only clients with a policy renewing within this many days.' },
        accountExecutive: { type: 'string' },
        minPremiumTTD: { type: 'number' },
        limit: { type: 'number', description: 'Default 50.' },
      },
    },
  },
  {
    name: 'get_client',
    description:
      'Full profile for one client: firmographics, every active policy with limits, extensions and renewal dates, a benefits census summary, and total premium. Call this before forming any view on a specific client — the search summary is not enough to recommend against.',
    input_schema: {
      type: 'object',
      properties: { clientId: { type: 'string' } },
      required: ['clientId'],
    },
  },
  {
    name: 'get_claims_summary',
    description:
      'Claims for a client rolled up by category, with paid and declined amounts and the reasons given for declines. Call this whenever a benefits recommendation is in play, and whenever you want to know what a client is actually experiencing rather than what they hold. Declined claims in an excluded category are the single strongest cross-sell signal in the book.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        sinceDays: { type: 'number', description: 'Look-back window. Default 730.' },
      },
      required: ['clientId'],
    },
  },
  {
    name: 'list_opportunities',
    description:
      'Run the deterministic gap-analysis rules and return scored, ranked opportunities with their supporting evidence. Call this to get candidate findings for a client or across the book. These are candidates produced by rules, not conclusions — verify the ones you intend to rely on against the underlying records.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'Restrict to one client.' },
        family: { type: 'string', enum: ['general', 'benefits', 'personal', 'service'] },
        kind: { type: 'string', enum: ['gap', 'adequacy', 'lifecycle', 'signal', 'portfolio'] },
        minScore: { type: 'number', description: '0..1. Filters low-ranked items.' },
        renewalWithinDays: { type: 'number' },
        cardeaOnly: { type: 'boolean', description: 'Only opportunities delivered by the Cardea subsidiary.' },
        limit: { type: 'number', description: 'Default 25.' },
      },
    },
  },
  {
    name: 'get_peer_benchmark',
    description:
      'What comparable clients on AIB\'s own book carry, for the cohort a client belongs to (industry crossed with size band). Call this to test whether a gap is genuinely unusual before raising it — a line 80% of peers hold is a very different conversation from one 20% hold.',
    input_schema: {
      type: 'object',
      properties: { clientId: { type: 'string' } },
      required: ['clientId'],
    },
  },
  {
    name: 'get_product_catalogue',
    description:
      'Every line AIB can place, with what it covers and how it is rated. Call this when you need the exact key for a line, or when you want to check whether something you are about to recommend is actually something AIB places.',
    input_schema: {
      type: 'object',
      properties: {
        family: { type: 'string', enum: ['general', 'benefits', 'personal', 'service'] },
      },
    },
  },
  {
    name: 'get_book_summary',
    description:
      'Portfolio-level totals: client and policy counts, premium by family, line attach rates, renewal distribution and aggregate opportunity value. Call this when you need to orient yourself before drilling in, or to check whether a pattern you noticed on one client holds across the book.',
    input_schema: { type: 'object', properties: {} },
  },
];

/**
 * Execute a tool call. Errors are returned to the model rather than thrown, so
 * a bad argument becomes something it can correct rather than a dead run.
 *
 * @param {string} name
 * @param {any} input
 * @param {ToolContext} ctx
 * @returns {{content: string, isError?: boolean}}
 */
export function runTool(name, input, ctx) {
  try {
    const handler = HANDLERS[name];
    if (!handler) return { content: `Unknown tool "${name}". Available: ${Object.keys(HANDLERS).join(', ')}`, isError: true };
    return { content: JSON.stringify(handler(input ?? {}, ctx), null, 1) };
  } catch (err) {
    return { content: `Tool ${name} failed: ${err.message}`, isError: true };
  }
}

const HANDLERS = {
  search_clients(input, ctx) {
    return searchClients(ctx.ix, input);
  },

  get_client(input, ctx) {
    const client = ctx.ix.clientsById.get(input.clientId);
    if (!client) throw new Error(`No client "${input.clientId}" on the book`);

    const policies = policiesFor(ctx.ix, client.id);
    const members = membersFor(ctx.ix, client.id);
    const renewal = nextRenewalFor(ctx.ix, client.id, ctx.now);

    const census = members.length
      ? {
          total: members.length,
          byRole: members.reduce((acc, m) => ((acc[m.role] = (acc[m.role] ?? 0) + 1), acc), {}),
          childrenNearingCeiling: members
            .filter((m) => {
              if (m.role !== 'child' || !m.dob) return false;
              const age = ageOf(m.dob, ctx.now);
              const ceiling = m.tertiaryEnrolled ? 25 : 21;
              return ceiling - age >= 0 && ceiling - age <= 1;
            })
            .map((m) => ({
              memberId: m.id,
              age: Number(ageOf(m.dob, ctx.now).toFixed(1)),
              ceiling: m.tertiaryEnrolled ? 25 : 21,
              tertiaryEnrolled: !!m.tertiaryEnrolled,
            })),
        }
      : { total: 0, note: 'No benefits census held for this client.' };

    return {
      client: {
        ...client,
        annualPremiumTTD: Math.round(clientPremiumTTD(ctx.ix, client.id)),
        cohort: cohortKey(client),
        nextRenewal: renewal ? { policyId: renewal.policy.id, line: renewal.policy.line, date: renewal.policy.renewalDate, inDays: renewal.days } : null,
      },
      policies: policies.map((p) => ({
        id: p.id,
        line: p.line,
        lineName: CATALOGUE[p.line]?.name ?? p.line,
        carrier: p.carrier,
        administrator: p.administrator ?? null,
        inceptionDate: p.inceptionDate,
        renewalDate: p.renewalDate,
        renewsInDays: p.renewalDate ? Math.round((Date.parse(p.renewalDate) - ctx.now.getTime()) / 86400000) : null,
        annualPremium: p.annualPremium,
        currency: p.currency,
        sumInsured: p.sumInsured ?? null,
        sumInsuredSetAt: p.sumInsuredSetAt ?? null,
        deductible: p.deductible ?? null,
        indemnityPeriodMonths: p.indemnityPeriodMonths ?? null,
        lives: p.lives ?? null,
        vehicles: p.vehicles ?? null,
        extensions: p.extensions ?? [],
      })),
      census,
      linesHeld: [...(ctx.ix.linesByClient.get(client.id) ?? [])].sort(),
      linesNotHeld: Object.keys(CATALOGUE).filter((k) => !(ctx.ix.linesByClient.get(client.id) ?? new Set()).has(k)),
    };
  },

  get_claims_summary(input, ctx) {
    if (!ctx.ix.clientsById.has(input.clientId)) throw new Error(`No client "${input.clientId}" on the book`);
    return claimsSummary(ctx.ix, input.clientId, { sinceDays: input.sinceDays });
  },

  list_opportunities(input, ctx) {
    const opportunities = findOpportunities(ctx.ix, {
      now: ctx.now,
      benchmarks: ctx.benchmarks,
      clientIds: input.clientId ? [input.clientId] : undefined,
    });

    let ranked = rankOpportunities(opportunities);
    if (input.family) ranked = ranked.filter((o) => o.family === input.family);
    if (input.kind) ranked = ranked.filter((o) => o.kind === input.kind);
    if (input.cardeaOnly) ranked = ranked.filter((o) => o.cardea);
    if (input.minScore != null) ranked = ranked.filter((o) => o.score >= input.minScore);
    if (input.renewalWithinDays != null) {
      ranked = ranked.filter((o) => o.urgencyDays >= 0 && o.urgencyDays <= input.renewalWithinDays);
    }

    const limit = input.limit ?? 25;
    return {
      total: ranked.length,
      returned: Math.min(ranked.length, limit),
      summary: summarise(ranked),
      opportunities: ranked.slice(0, limit),
    };
  },

  get_peer_benchmark(input, ctx) {
    const client = ctx.ix.clientsById.get(input.clientId);
    if (!client) throw new Error(`No client "${input.clientId}" on the book`);

    const key = cohortKey(client);
    const cohort = ctx.benchmarks.get(key);
    if (!cohort) {
      return {
        cohort: key,
        available: false,
        note: 'Too few comparable clients on the book to benchmark this cohort. Treat any peer-gap finding for this client as unsupported.',
      };
    }

    const held = ctx.ix.linesByClient.get(client.id) ?? new Set();
    return {
      cohort: key,
      available: true,
      peerCount: cohort.peers.length,
      peerIds: cohort.peers,
      medianPremiumTTD: cohort.medianPremiumTTD,
      clientPremiumTTD: Math.round(clientPremiumTTD(ctx.ix, client.id)),
      attachRates: Object.fromEntries(
        Object.entries(cohort.attachRate)
          .sort((a, b) => b[1] - a[1])
          .map(([line, rate]) => [line, { attachRate: Number(rate.toFixed(2)), clientHolds: held.has(line) }]),
      ),
    };
  },

  get_product_catalogue(input) {
    const entries = Object.values(CATALOGUE).filter((p) => !input.family || p.family === input.family);
    return {
      count: entries.length,
      note: 'Rates are indicative, for sizing and ranking opportunities. They are not quotes.',
      products: entries.map((p) => ({
        key: p.key,
        name: p.name,
        family: p.family,
        description: p.description,
        basis: p.basis,
        requires: p.requires ?? [],
        deliveredByCardea: !!p.cardea,
      })),
    };
  },

  get_book_summary(_input, ctx) {
    const { book } = ctx.ix;
    const ranked = rankOpportunities(findOpportunities(ctx.ix, { now: ctx.now, benchmarks: ctx.benchmarks }));

    const attach = {};
    for (const lines of ctx.ix.linesByClient.values()) {
      for (const line of lines) attach[line] = (attach[line] ?? 0) + 1;
    }

    const renewalBuckets = { within30: 0, within90: 0, within180: 0, beyond180: 0 };
    for (const policy of book.policies) {
      if (policy.status !== 'active' || !policy.renewalDate) continue;
      const days = Math.round((Date.parse(policy.renewalDate) - ctx.now.getTime()) / 86400000);
      if (days < 0) continue;
      if (days <= 30) renewalBuckets.within30++;
      else if (days <= 90) renewalBuckets.within90++;
      else if (days <= 180) renewalBuckets.within180++;
      else renewalBuckets.beyond180++;
    }

    return {
      asOf: ctx.now.toISOString().slice(0, 10),
      clients: book.clients.length,
      activePolicies: book.policies.filter((p) => p.status === 'active').length,
      benefitsMembers: book.members.length,
      claimsOnFile: book.claims.length,
      clientsBySegment: book.clients.reduce((acc, c) => ((acc[c.segment] = (acc[c.segment] ?? 0) + 1), acc), {}),
      clientsByIndustry: book.clients.reduce((acc, c) => ((acc[c.industry] = (acc[c.industry] ?? 0) + 1), acc), {}),
      lineAttachCounts: Object.fromEntries(Object.entries(attach).sort((a, b) => b[1] - a[1])),
      renewalBuckets,
      opportunityPipeline: summarise(ranked),
    };
  },
};
