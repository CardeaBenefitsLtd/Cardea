/**
 * Ranking opportunities.
 *
 * Kept deliberately simple and explicit rather than tuned: a broker who cannot
 * explain why one item outranks another will not trust the list, and an
 * unexplainable ranking is the fastest way to have the whole system ignored.
 * Every component is bounded 0..1 and the weights sum to 1, so the score reads
 * as a percentage and the breakdown is inspectable per item.
 *
 * The weights below are a starting position, not a finding. They should be
 * re-fitted against actual conversion once AIB has a few months of outcomes.
 */

/** Contribution of each factor to the final score. */
export const WEIGHTS = {
  value: 0.34,      // what the placement is worth to the group
  confidence: 0.28, // how well the data supports it
  urgency: 0.24,    // how close the natural conversation window is
  effort: 0.14,     // how much work it is to place
};

const EFFORT_SCORE = { low: 1.0, medium: 0.6, high: 0.3 };

/** Revenue to the group at or above this scores full marks on value. */
const VALUE_CEILING_TTD = 40000;

/**
 * @param {import('./rules.js').Opportunity} opp
 * @returns {{score: number, breakdown: Record<string, number>}}
 */
export function scoreOpportunity(opp) {
  // Log scale: the difference between a TT$2k and a TT$20k line matters
  // far more than between TT$200k and TT$218k.
  const value = clamp01(Math.log10(1 + Math.max(0, opp.estRevenueTTD)) / Math.log10(1 + VALUE_CEILING_TTD));

  const confidence = clamp01(opp.confidence ?? 0.5);

  // Peaks inside the renewal run-up. Something renewing tomorrow is too late to
  // work properly; something renewing in a year is not yet a conversation.
  const urgency = urgencyCurve(opp.urgencyDays ?? 365);

  const effort = EFFORT_SCORE[opp.effort] ?? 0.6;

  const breakdown = { value, confidence, urgency, effort };
  const score =
    WEIGHTS.value * value +
    WEIGHTS.confidence * confidence +
    WEIGHTS.urgency * urgency +
    WEIGHTS.effort * effort;

  return { score: Number(score.toFixed(4)), breakdown };
}

/**
 * Renewal proximity as a 0..1 signal.
 *   inside 21 days  - the window is closing, ramp back down
 *   21 to 120 days  - the sweet spot for a coverage conversation
 *   beyond 120 days - decays toward a floor, never to zero
 * @param {number} days
 */
export function urgencyCurve(days) {
  if (days < 0) return 0.25;
  if (days <= 21) return 0.55 + (days / 21) * 0.45;
  if (days <= 120) return 1.0;
  if (days <= 365) return clamp01(1.0 - ((days - 120) / 245) * 0.7);
  return 0.3;
}

/**
 * Score and sort. Also attaches a rank so downstream consumers — including the
 * model — can refer to items by position without recomputing anything.
 *
 * @param {import('./rules.js').Opportunity[]} opportunities
 * @returns {(import('./rules.js').Opportunity & {score: number, scoreBreakdown: Record<string, number>, rank: number})[]}
 */
export function rankOpportunities(opportunities) {
  return opportunities
    .map((opp) => {
      const { score, breakdown } = scoreOpportunity(opp);
      return { ...opp, score, scoreBreakdown: breakdown };
    })
    .sort((a, b) => b.score - a.score || b.estRevenueTTD - a.estRevenueTTD)
    .map((opp, i) => ({ ...opp, rank: i + 1 }));
}

/**
 * Portfolio-level roll-up, for the console header and the sweep summary.
 * @param {(import('./rules.js').Opportunity & {score: number})[]} ranked
 */
export function summarise(ranked) {
  const byFamily = {};
  const byKind = {};
  const byClient = {};

  for (const opp of ranked) {
    byFamily[opp.family] = (byFamily[opp.family] ?? 0) + opp.estRevenueTTD;
    byKind[opp.kind] = (byKind[opp.kind] ?? 0) + 1;
    byClient[opp.clientId] ??= { clientId: opp.clientId, clientName: opp.clientName, count: 0, revenueTTD: 0 };
    byClient[opp.clientId].count++;
    byClient[opp.clientId].revenueTTD += opp.estRevenueTTD;
  }

  return {
    opportunities: ranked.length,
    clientsWithOpportunities: Object.keys(byClient).length,
    estPremiumTTD: ranked.reduce((s, o) => s + o.estPremiumTTD, 0),
    estRevenueTTD: ranked.reduce((s, o) => s + o.estRevenueTTD, 0),
    cardeaOpportunities: ranked.filter((o) => o.cardea).length,
    withinNinetyDays: ranked.filter((o) => o.urgencyDays >= 0 && o.urgencyDays <= 90).length,
    revenueByFamily: Object.fromEntries(Object.entries(byFamily).map(([k, v]) => [k, Math.round(v)])),
    countByKind: byKind,
    topClients: Object.values(byClient)
      .sort((a, b) => b.revenueTTD - a.revenueTTD)
      .slice(0, 10)
      .map((c) => ({ ...c, revenueTTD: Math.round(c.revenueTTD) })),
  };
}

/** @param {number} n */
function clamp01(n) {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
