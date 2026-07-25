/**
 * The deterministic gap-analysis engine.
 *
 * Every recommendation the system makes starts here, in code, reading real
 * policy and claims records — not in the model. The model's job is to judge,
 * prioritise and explain what these rules surface; it is never the source of a
 * coverage fact. That split is deliberate: in a regulated brokerage, a
 * recommendation that cannot be traced back to a record is a liability, and a
 * language model asked to invent findings will happily produce plausible ones.
 *
 * A rule declares who it applies to and returns zero or more opportunities,
 * each carrying the record IDs that justify it. If you cannot point at the
 * evidence, do not write the rule.
 */

import {
  policiesFor, membersFor, claimsFor, hasLine, nextRenewalFor,
  daysUntil, yearsSince, ageOf, cohortKey, clientPremiumTTD, claimsSummary,
} from '../data/book.js';
import { CATALOGUE, estimatePremiumTTD, estimateRevenueTTD, livesFor, impliedSumInsured } from './catalogue.js';
import { toTTD } from '../data/schema.js';
import { TPA_NAME, TPA_RELATIONSHIP } from '../config.js';

/**
 * @typedef {Object} Evidence
 * @property {'policy'|'claim'|'member'|'client'|'benchmark'} kind
 * @property {string} ref     The record id, so a broker can go and look it up.
 * @property {string} detail  Why this record supports the finding.
 *
 * @typedef {Object} Opportunity
 * @property {string} id
 * @property {string} clientId
 * @property {string} clientName
 * @property {string} ruleId
 * @property {string} ruleTitle
 * @property {string} line
 * @property {'general'|'benefits'|'personal'|'service'} family
 * @property {'gap'|'adequacy'|'lifecycle'|'signal'|'portfolio'} kind
 * @property {string} headline
 * @property {string} rationale
 * @property {Evidence[]} evidence
 * @property {number} estPremiumTTD
 * @property {number} estRevenueTTD
 * @property {number} confidence     0..1, how sure the rule is on the data alone.
 * @property {number} urgencyDays    Days to the client's next renewal; the natural conversation window.
 * @property {'low'|'medium'|'high'} effort
 * @property {boolean} [tpa]         An administration line delivered by the health TPA.
 */

const CUSTOMER_FACING = new Set(['Retail', 'Hospitality', 'Healthcare', 'Professional Services', 'Financial Services']);
const DATA_HEAVY = new Set(['Financial Services', 'Healthcare', 'Technology', 'Retail', 'Professional Services']);
const ADVISORY = new Set(['Professional Services', 'Healthcare', 'Financial Services', 'Technology']);
const GOODS = new Set(['Manufacturing', 'Distribution', 'Retail']);
const PLANT_HEAVY = new Set(['Manufacturing', 'Energy', 'Agriculture']);
const FIELD_RISK = new Set(['Construction', 'Manufacturing', 'Agriculture', 'Transport & Logistics', 'Energy']);

/** Sums insured older than this are treated as having drifted out of date. */
const SUM_INSURED_STALE_YEARS = 3;
/** Assumed compound construction/replacement cost inflation for the drift estimate. */
const REBUILD_INFLATION = 0.055;

// ---------------------------------------------------------------- the rules

/** @type {Array<{id: string, title: string, kind: Opportunity['kind'], run: (client: any, ctx: any) => Opportunity[]}>} */
export const RULES = [
  // ------------------------------------------------------------- adequacy
  {
    id: 'property_sum_insured_drift',
    title: 'Property sum insured has not been revised',
    kind: 'adequacy',
    run(client, ctx) {
      const out = [];
      for (const policy of policiesFor(ctx.ix, client.id)) {
        if (policy.line !== 'property_all_risk' && policy.line !== 'homeowners') continue;
        if (!policy.sumInsuredSetAt || !policy.sumInsured) continue;
        const years = yearsSince(policy.sumInsuredSetAt, ctx.now);
        if (years < SUM_INSURED_STALE_YEARS) continue;

        const impliedToday = policy.sumInsured * (1 + REBUILD_INFLATION) ** years;
        const shortfall = impliedToday - policy.sumInsured;
        const underPct = Math.round((shortfall / impliedToday) * 100);
        const upliftPremium = Math.round(toTTD(shortfall, policy.currency) * CATALOGUE[policy.line].rate);

        out.push(make(client, ctx, {
          ruleId: this.id, ruleTitle: this.title, kind: this.kind,
          line: policy.line,
          headline: `Sum insured last set ${years.toFixed(1)} years ago — roughly ${underPct}% under replacement cost`,
          rationale:
            `Policy ${policy.id} carries a sum insured of ${money(policy.sumInsured, policy.currency)}, last revised on ` +
            `${policy.sumInsuredSetAt}. Carried forward at ${(REBUILD_INFLATION * 100).toFixed(1)}% replacement-cost inflation, the same ` +
            `asset would rebuild for about ${money(Math.round(impliedToday), policy.currency)} today. At that level of ` +
            `under-declaration the average clause bites on every partial loss, not just a total loss — the client would carry ` +
            `roughly ${underPct}% of any claim themselves. A revaluation ahead of renewal is the cleanest way to close it.`,
          evidence: [
            { kind: 'policy', ref: policy.id, detail: `sumInsured ${money(policy.sumInsured, policy.currency)} set at ${policy.sumInsuredSetAt}` },
          ],
          estPremiumTTD: Math.max(upliftPremium, 2500),
          confidence: years > 5 ? 0.85 : 0.7,
          effort: 'medium',
        }));
      }
      return out;
    },
  },

  {
    id: 'property_no_flood',
    title: 'Property in a flood-prone area without flood cover',
    kind: 'gap',
    run(client, ctx) {
      if (!client.floodZone) return [];
      const out = [];
      for (const policy of policiesFor(ctx.ix, client.id)) {
        if (policy.line !== 'property_all_risk' && policy.line !== 'homeowners') continue;
        if ((policy.extensions ?? []).includes('flood')) continue;

        out.push(make(client, ctx, {
          ruleId: this.id, ruleTitle: this.title, kind: this.kind,
          line: policy.line,
          headline: `No flood extension on a site at ${client.locations.join(' / ')}`,
          rationale:
            `Policy ${policy.id} covers ${money(policy.sumInsured ?? 0, policy.currency)} of property at ` +
            `${client.locations.join(' and ')} with no flood extension on the schedule. Seasonal flooding is the most ` +
            `frequently realised property peril in Trinidad, and it is excluded from the base wording rather than sub-limited — ` +
            `so this is not a question of how much would be paid, it is that nothing would be. The extension is inexpensive ` +
            `relative to the exposure and can be added mid-term.`,
          evidence: [
            { kind: 'policy', ref: policy.id, detail: `extensions: ${(policy.extensions ?? []).join(', ') || 'none'}` },
            { kind: 'client', ref: client.id, detail: `locations: ${client.locations.join(', ')} (flagged flood-prone)` },
          ],
          estPremiumTTD: Math.round(toTTD(policy.sumInsured ?? 0, policy.currency) * 0.0008) || 3000,
          confidence: 0.8,
          effort: 'low',
        }));
      }
      return out;
    },
  },

  {
    id: 'property_no_catastrophe',
    title: 'Property without earthquake cover',
    kind: 'gap',
    run(client, ctx) {
      const out = [];
      for (const policy of policiesFor(ctx.ix, client.id)) {
        if (policy.line !== 'property_all_risk' && policy.line !== 'homeowners') continue;
        if ((policy.extensions ?? []).includes('earthquake')) continue;

        out.push(make(client, ctx, {
          ruleId: this.id, ruleTitle: this.title, kind: this.kind,
          line: policy.line,
          headline: 'No earthquake extension on the property schedule',
          rationale:
            `Policy ${policy.id} has no earthquake extension. Trinidad and Tobago sits on the Caribbean–South American plate ` +
            `boundary and catastrophe perils are excluded from the standard wording. For an account with ` +
            `${money(policy.sumInsured ?? 0, policy.currency)} at risk this is the single largest uninsured downside on the ` +
            `schedule, and most lenders now require it where the asset is financed.`,
          evidence: [{ kind: 'policy', ref: policy.id, detail: `extensions: ${(policy.extensions ?? []).join(', ') || 'none'}` }],
          estPremiumTTD: Math.round(toTTD(policy.sumInsured ?? 0, policy.currency) * 0.0011) || 4000,
          confidence: 0.72,
          effort: 'low',
        }));
      }
      return out;
    },
  },

  {
    id: 'property_without_bi',
    title: 'Material damage cover with no business interruption',
    kind: 'gap',
    run(client, ctx) {
      if (client.segment === 'personal') return [];
      if (!hasLine(ctx.ix, client.id, 'property_all_risk')) return [];
      if (hasLine(ctx.ix, client.id, 'business_interruption')) return [];

      const property = policiesFor(ctx.ix, client.id).find((p) => p.line === 'property_all_risk');
      const grossProfit = (client.annualRevenueTTD ?? 0) * 0.35;

      return [make(client, ctx, {
        ruleId: this.id, ruleTitle: this.title, kind: this.kind,
        line: 'business_interruption',
        headline: 'Property is insured but the income it produces is not',
        rationale:
          `The client carries ${money(property?.sumInsured ?? 0, property?.currency)} of material damage cover under ` +
          `${property?.id} and no business interruption policy. A fire that takes the ${client.locations[0]} site out for six ` +
          `months would rebuild the asset and leave the client to absorb the lost gross profit — on turnover of ` +
          `${money(client.annualRevenueTTD ?? 0)} that is on the order of ${money(Math.round(grossProfit / 2))}. ` +
          `Business interruption is the most consequential single gap on a commercial schedule and it can only be placed ` +
          `alongside the material damage cover, so renewal is the moment.`,
        evidence: [
          property && { kind: 'policy', ref: property.id, detail: `property all risk, sum insured ${money(property.sumInsured ?? 0, property.currency)}` },
          { kind: 'client', ref: client.id, detail: `turnover ${money(client.annualRevenueTTD ?? 0)}` },
        ].filter(Boolean),
        estPremiumTTD: estimatePremiumTTD('business_interruption', client, { sumInsured: grossProfit }),
        confidence: 0.88,
        effort: 'medium',
      })];
    },
  },

  {
    id: 'bi_indemnity_short',
    title: 'Business interruption indemnity period may be too short',
    kind: 'adequacy',
    run(client, ctx) {
      const out = [];
      for (const policy of policiesFor(ctx.ix, client.id)) {
        if (policy.line !== 'business_interruption') continue;
        const months = policy.indemnityPeriodMonths ?? 12;
        if (months > 12) continue;
        const heavy = PLANT_HEAVY.has(client.industry);
        if (!heavy && months === 12) continue;

        out.push(make(client, ctx, {
          ruleId: this.id, ruleTitle: this.title, kind: this.kind,
          line: 'business_interruption',
          headline: `${months}-month indemnity period against a rebuild that would take longer`,
          rationale:
            `Policy ${policy.id} carries a ${months}-month indemnity period. For a ${client.industry.toLowerCase()} operation, ` +
            `specifying, ordering and commissioning replacement plant routinely runs past twelve months before trading ` +
            `returns to pre-loss levels — and the clock starts at the date of damage, not the date the rebuild finishes. ` +
            `Extending to 18 or 24 months costs materially less than the proportional increase in cover suggests.`,
          evidence: [{ kind: 'policy', ref: policy.id, detail: `indemnityPeriodMonths: ${months}` }],
          estPremiumTTD: Math.round(toTTD(policy.annualPremium ?? 0, policy.currency) * 0.35) || 4000,
          confidence: heavy ? 0.7 : 0.55,
          effort: 'low',
        }));
      }
      return out;
    },
  },

  {
    id: 'no_machinery_breakdown',
    title: 'Plant-heavy operation without machinery breakdown cover',
    kind: 'gap',
    run(client, ctx) {
      if (!PLANT_HEAVY.has(client.industry)) return [];
      if (!hasLine(ctx.ix, client.id, 'property_all_risk')) return [];
      if (hasLine(ctx.ix, client.id, 'machinery_breakdown')) return [];

      const property = policiesFor(ctx.ix, client.id).find((p) => p.line === 'property_all_risk');
      return [make(client, ctx, {
        ruleId: this.id, ruleTitle: this.title, kind: this.kind,
        line: 'machinery_breakdown',
        headline: 'Property all risk does not cover plant that fails on its own',
        rationale:
          `The property policy ${property?.id} responds to external causes of damage. It excludes sudden mechanical or ` +
          `electrical breakdown of the plant itself, which for a ${client.industry.toLowerCase()} client is the more likely ` +
          `loss and the one that stops production. Clients consistently assume this is already covered; it is worth ` +
          `establishing which it is before a claim does it for them.`,
        evidence: property ? [{ kind: 'policy', ref: property.id, detail: 'property all risk in force; no machinery breakdown section' }] : [],
        estPremiumTTD: estimatePremiumTTD('machinery_breakdown', client, { sumInsured: (property?.sumInsured ?? impliedSumInsured(client)) * 0.4 }),
        confidence: 0.68,
        effort: 'medium',
      })];
    },
  },

  // ------------------------------------------------------------ liability gaps
  liabilityGap({
    id: 'no_employers_liability', line: 'employers_liability',
    title: "No employers' liability despite a substantial workforce",
    applies: (c) => c.segment !== 'personal' && (c.headcount ?? 0) >= 25,
    headline: (c) => `${c.headcount} employees and no employers' liability cover`,
    rationale: (c) =>
      `The client employs ${c.headcount} people with no employers' liability policy on the schedule. Statutory ` +
      `workmen's compensation caps out well below what a serious workplace injury award reaches, and the balance falls ` +
      `on the employer directly. Exposure here scales with headcount, and this client has grown to ${c.headcount} ` +
      `from ${c.headcountAtInception ?? 'a smaller base'} since the relationship began.`,
    confidence: (c) => ((c.headcount ?? 0) >= 100 ? 0.8 : 0.65),
  }),

  liabilityGap({
    id: 'no_public_liability', line: 'public_liability',
    title: 'Customer-facing operation without public liability',
    applies: (c) => c.segment !== 'personal' && CUSTOMER_FACING.has(c.industry),
    headline: () => 'No public liability cover on a customer-facing operation',
    rationale: (c) =>
      `A ${c.industry.toLowerCase()} business has members of the public on its premises continuously, and no public ` +
      `liability policy is in force. A single slip-and-fall claim with a legal defence attached typically exceeds the ` +
      `annual premium several times over. This is usually an oversight rather than a decision.`,
    confidence: () => 0.75,
  }),

  liabilityGap({
    id: 'no_products_liability', line: 'products_liability',
    title: 'Goods business without products liability',
    applies: (c) => c.segment !== 'personal' && GOODS.has(c.industry) && (c.annualRevenueTTD ?? 0) >= 10e6,
    headline: () => 'Product in the market with no products liability cover',
    rationale: (c) =>
      `The client turns over ${money(c.annualRevenueTTD ?? 0)} in a ${c.industry.toLowerCase()} business and carries no ` +
      `products liability. Once goods leave the premises the exposure persists for years, and general liability wordings ` +
      `exclude it. Retail buyers and export counterparties increasingly require evidence of it before they will contract.`,
    confidence: () => 0.7,
  }),

  liabilityGap({
    id: 'no_professional_indemnity', line: 'professional_indemnity',
    title: 'Advisory business without professional indemnity',
    applies: (c) => c.segment !== 'personal' && ADVISORY.has(c.industry),
    headline: () => 'Fee-earning advice with no professional indemnity behind it',
    rationale: (c) =>
      `A ${c.industry.toLowerCase()} firm earns fees for advice and carries no professional indemnity cover. Claims here ` +
      `arrive years after the work, are defended at the firm's own cost, and are increasingly written into client ` +
      `contracts as a precondition. For regulated or tendering clients the absence of a policy can cost the engagement ` +
      `outright.`,
    confidence: () => 0.72,
  }),

  liabilityGap({
    id: 'no_cyber_liability', line: 'cyber_liability',
    title: 'Data-holding business without cyber cover',
    applies: (c) => c.segment !== 'personal' && DATA_HEAVY.has(c.industry) && (c.annualRevenueTTD ?? 0) >= 15e6,
    headline: () => 'No cyber cover on a business that holds customer data',
    rationale: (c) =>
      `A ${c.industry.toLowerCase()} business turning over ${money(c.annualRevenueTTD ?? 0)} holds customer data and has ` +
      `no cyber policy. The Data Protection Act obligations bite regardless of company size, and the cost that actually ` +
      `hurts is not the liability — it is the forensic investigation, notification and downtime, none of which the ` +
      `property or general liability wordings reach. This is the fastest-growing gap across the whole book.`,
    confidence: () => 0.75,
    effort: 'medium',
  }),

  liabilityGap({
    id: 'no_directors_officers', line: 'directors_officers',
    title: 'Corporate board without D&O cover',
    applies: (c) => c.segment === 'corporate' && (c.annualRevenueTTD ?? 0) >= 40e6,
    headline: () => 'No directors and officers liability for the board',
    rationale: (c) =>
      `A corporate account turning over ${money(c.annualRevenueTTD ?? 0)} has no D&O cover. Directors are personally ` +
      `liable for management decisions and company indemnities fall away in precisely the insolvency and regulatory ` +
      `scenarios where they are needed. Non-executive appointments increasingly will not be accepted without it, which ` +
      `makes this a board-level conversation rather than a procurement one.`,
    confidence: () => 0.68,
    effort: 'medium',
  }),

  {
    id: 'no_marine_cargo',
    title: 'Importer without marine cargo cover',
    kind: 'gap',
    run(client, ctx) {
      if (client.segment === 'personal') return [];
      if (!GOODS.has(client.industry)) return [];
      if ((client.annualRevenueTTD ?? 0) < 8e6) return [];
      if (hasLine(ctx.ix, client.id, 'marine_cargo')) return [];

      const cargoValue = (client.annualRevenueTTD ?? 0) * 0.3;
      return [make(client, ctx, {
        ruleId: this.id, ruleTitle: this.title, kind: this.kind,
        line: 'marine_cargo',
        headline: 'Goods moving in and out with no cargo cover on the books',
        rationale:
          `A ${client.industry.toLowerCase()} business at ${money(client.annualRevenueTTD ?? 0)} turnover is moving goods ` +
          `through the ports continuously and AIB holds no marine cargo policy. Where clients believe they are covered it ` +
          `is usually under a supplier's terms, which typically end at the port of discharge and leave the inland leg bare. ` +
          `Worth confirming what the Incoterms on their major contracts actually say before assuming the gap is real.`,
        evidence: [{ kind: 'client', ref: client.id, detail: `${client.industry}, turnover ${money(client.annualRevenueTTD ?? 0)}, no cargo policy in force` }],
        estPremiumTTD: estimatePremiumTTD('marine_cargo', client, { sumInsured: cargoValue }),
        confidence: 0.6,
        effort: 'medium',
      })];
    },
  },

  {
    id: 'no_contractors_all_risk',
    title: 'Contractor without contract works cover',
    kind: 'gap',
    run(client, ctx) {
      if (client.industry !== 'Construction') return [];
      if (hasLine(ctx.ix, client.id, 'contractors_all_risk')) return [];

      return [make(client, ctx, {
        ruleId: this.id, ruleTitle: this.title, kind: this.kind,
        line: 'contractors_all_risk',
        headline: 'Contract works are being insured somewhere other than AIB',
        rationale:
          `The client is an active contractor with ${money(client.annualRevenueTTD ?? 0)} of turnover and no contractors ` +
          `all risk policy through AIB. Contract works cover is effectively mandatory to win work, so it is being placed — ` +
          `just not here. That makes this a competitive displacement rather than a coverage gap, and CAR is usually written ` +
          `per project, so the opening is the next contract award rather than a renewal date.`,
        evidence: [{ kind: 'client', ref: client.id, detail: `Construction, turnover ${money(client.annualRevenueTTD ?? 0)}, no CAR placed through AIB` }],
        estPremiumTTD: estimatePremiumTTD('contractors_all_risk', client, { sumInsured: (client.annualRevenueTTD ?? 0) * 0.25 }),
        confidence: 0.65,
        effort: 'high',
      })];
    },
  },

  {
    id: 'motor_fleet_understated',
    title: 'Declared fleet may lag the actual fleet',
    kind: 'adequacy',
    run(client, ctx) {
      const fleet = policiesFor(ctx.ix, client.id).find((p) => p.line === 'motor_fleet');
      if (!fleet?.vehicles) return [];
      const grown = (client.headcount ?? 0) / Math.max(1, client.headcountAtInception ?? client.headcount ?? 1);
      if (grown < 1.3) return [];

      const implied = Math.round(fleet.vehicles * grown);
      const extra = implied - fleet.vehicles;
      if (extra < 2) return [];

      return [make(client, ctx, {
        ruleId: this.id, ruleTitle: this.title, kind: this.kind,
        line: 'motor_fleet',
        headline: `Headcount up ${Math.round((grown - 1) * 100)}% since inception while the declared fleet has not moved`,
        rationale:
          `Fleet policy ${fleet.id} declares ${fleet.vehicles} vehicles. The client has grown from ` +
          `${client.headcountAtInception} to ${client.headcount} employees over the relationship, which on the same ratio ` +
          `implies closer to ${implied} vehicles on the road. Undeclared units are unlikely to be covered at all, and a ` +
          `schedule review is a short conversation with a clear answer. Confirm against their own fleet list rather than ` +
          `treating the headcount ratio as fact.`,
        evidence: [
          { kind: 'policy', ref: fleet.id, detail: `${fleet.vehicles} vehicles declared` },
          { kind: 'client', ref: client.id, detail: `headcount ${client.headcountAtInception} → ${client.headcount}` },
        ],
        estPremiumTTD: estimatePremiumTTD('motor_fleet', client, { vehicles: extra }),
        confidence: 0.5,
        effort: 'low',
      })];
    },
  },

  // ---------------------------------------------------------------- benefits
  {
    id: 'no_benefits_programme',
    title: 'Employer with no employee benefits programme',
    kind: 'portfolio',
    run(client, ctx) {
      if (client.segment === 'personal') return [];
      if ((client.headcount ?? 0) < 25) return [];
      const lines = ctx.ix.linesByClient.get(client.id) ?? new Set();
      if (['group_health_local', 'group_life', 'group_personal_accident', 'intl_health_usd'].some((l) => lines.has(l))) return [];

      return [make(client, ctx, {
        ruleId: this.id, ruleTitle: this.title, kind: this.kind,
        line: 'group_health_local',
        headline: `${client.headcount} employees with no benefits programme placed through AIB`,
        rationale:
          `AIB handles this client's general insurance but places nothing on the benefits side for ${client.headcount} ` +
          `employees. Either they have no programme — in which case a ${client.industry.toLowerCase()} employer competing ` +
          `for staff has a retention problem worth naming — or they have one placed elsewhere, which is a displacement ` +
          `opportunity with an incumbent to unseat. Establish which of the two it is before building the case.`,
        evidence: [
          { kind: 'client', ref: client.id, detail: `${client.headcount} employees; lines held: ${[...lines].join(', ') || 'none'}` },
        ],
        estPremiumTTD: estimatePremiumTTD('group_health_local', client),
        confidence: 0.7,
        effort: 'high',
      })];
    },
  },

  {
    id: 'health_not_administered_by_tpa',
    title: `Group health administered outside ${TPA_NAME}`,
    kind: 'portfolio',
    run(client, ctx) {
      if (TPA_RELATIONSHIP === 'none') return [];
      const out = [];
      for (const policy of policiesFor(ctx.ix, client.id)) {
        if (policy.line !== 'group_health_local') continue;
        if (policy.administrator === TPA_NAME) continue;

        const who = policy.administrator === 'self' ? 'the client administers it in-house' : `${policy.carrier} administers it`;
        out.push(make(client, ctx, {
          ruleId: this.id, ruleTitle: this.title, kind: this.kind,
          line: 'cardea_tpa',
          headline: `Health plan for ${policy.lives ?? livesFor(client)} lives is administered by ${policy.administrator}`,
          rationale:
            `Policy ${policy.id} is placed with ${policy.carrier} and ${who}. Moving administration to ${TPA_NAME} does ` +
            `three things: members get direct settlement with providers instead of paying and claiming back, the client ` +
            `gets a single point of contact for pre-certification, and AIB gets claims visibility on the account. That ` +
            `last one compounds — every benefits recommendation AIB can make on this client currently rests on ` +
            `guesswork, because the utilisation data sits with someone else.`,
          evidence: [
            { kind: 'policy', ref: policy.id, detail: `carrier ${policy.carrier}, administrator ${policy.administrator}, ${policy.lives ?? '?'} lives` },
          ],
          estPremiumTTD: estimatePremiumTTD('cardea_tpa', client, { lives: policy.lives }),
          confidence: 0.75,
          effort: 'medium',
        }));
      }
      return out;
    },
  },

  {
    id: 'no_overseas_network',
    title: `Health plan without access to the ${TPA_NAME} overseas network`,
    kind: 'gap',
    run(client, ctx) {
      if (TPA_RELATIONSHIP === 'none') return [];
      const health = policiesFor(ctx.ix, client.id).find((p) => p.line === 'group_health_local');
      if (!health) return [];
      if ((health.extensions ?? []).includes('overseas_network')) return [];

      const summary = claimsSummary(ctx.ix, client.id);
      const overseas = summary.byCategory.overseas_precert;
      const declinedNetwork = Object.entries(summary.byCategory)
        .flatMap(([, b]) => Object.entries(b.declineReasons ?? {}))
        .filter(([reason]) => /network|pre-cert/i.test(reason));

      return [make(client, ctx, {
        ruleId: this.id, ruleTitle: this.title, kind: this.kind,
        line: 'cardea_overseas_network',
        headline: overseas
          ? `${overseas.count} overseas cases in two years with no network access on the plan`
          : 'Health plan has no overseas provider network attached',
        rationale:
          `Policy ${health.id} has no overseas provider network on the schedule. ` +
          (overseas
            ? `The plan has already seen ${overseas.count} overseas pre-certification cases worth ` +
              `${money(overseas.paidTTD)} in the last two years, so the need is demonstrated rather than hypothetical. `
            : `Where members need specialist care that is not available locally, they currently pay the full overseas cost ` +
              `up front and claim it back. `) +
          `Through the ${TPA_NAME} network, cases are pre-certified and benefits are paid directly to the provider at ` +
          `in-network pricing, which both lowers the member's share and removes the reimbursement lag. This sells on ` +
          `member experience, not on premium.`,
        evidence: [
          { kind: 'policy', ref: health.id, detail: `extensions: ${(health.extensions ?? []).join(', ') || 'none'}` },
          overseas && { kind: 'claim', ref: `${client.id}:overseas_precert`, detail: `${overseas.count} overseas cases, ${money(overseas.paidTTD)} paid` },
          declinedNetwork.length && { kind: 'claim', ref: `${client.id}:network-declines`, detail: `declines citing network or pre-certification: ${declinedNetwork.map(([r, n]) => `${r} (${n})`).join('; ')}` },
        ].filter(Boolean),
        estPremiumTTD: estimatePremiumTTD('cardea_overseas_network', client, { lives: health.lives }),
        confidence: overseas ? 0.82 : 0.6,
        effort: 'low',
      })];
    },
  },

  {
    id: 'no_intl_health',
    title: 'Senior staff without a USD international plan',
    kind: 'gap',
    run(client, ctx) {
      if (client.segment !== 'corporate') return [];
      if ((client.headcount ?? 0) < 80) return [];
      if (!hasLine(ctx.ix, client.id, 'group_health_local')) return [];
      if (hasLine(ctx.ix, client.id, 'intl_health_usd')) return [];

      const executives = Math.max(3, Math.round(client.headcount * 0.06));
      return [make(client, ctx, {
        ruleId: this.id, ruleTitle: this.title, kind: this.kind,
        line: 'intl_health_usd',
        headline: `No USD international plan for an estimated ${executives} senior staff`,
        rationale:
          `A corporate account of ${client.headcount} employees carries local group health only. The standard structure for ` +
          `an employer this size is a USD international plan sitting above the local plan for directors and senior ` +
          `management, with the local plan meeting the deductible first. It is a retention benefit for exactly the ` +
          `people the client can least afford to lose, and it keeps the overseas piece inside an arrangement AIB has ` +
          `visibility of rather than handing it to whoever the carrier happens to use.`,
        evidence: [
          { kind: 'client', ref: client.id, detail: `corporate, ${client.headcount} employees, local health only` },
        ],
        estPremiumTTD: estimatePremiumTTD('intl_health_usd', client, { lives: executives }),
        confidence: 0.65,
        effort: 'high',
      })];
    },
  },

  {
    id: 'health_without_group_life',
    title: 'Group health with no death-in-service benefit',
    kind: 'gap',
    run(client, ctx) {
      if (!hasLine(ctx.ix, client.id, 'group_health_local')) return [];
      if (hasLine(ctx.ix, client.id, 'group_life')) return [];

      const health = policiesFor(ctx.ix, client.id).find((p) => p.line === 'group_health_local');
      return [make(client, ctx, {
        ruleId: this.id, ruleTitle: this.title, kind: this.kind,
        line: 'group_life',
        headline: 'Medical cover in place with no death-in-service benefit',
        rationale:
          `The client funds a medical plan for ${health?.lives ?? livesFor(client)} lives under ${health?.id} but provides ` +
          `nothing if an employee dies. Group life at two to three times salary is the cheapest benefit per dollar of ` +
          `perceived value in the market, and the absence of it is conspicuous the first time an employer has to face a ` +
          `bereaved family with nothing to offer. It is also the most common next purchase after medical, so the ` +
          `conversation is already familiar to most HR managers.`,
        evidence: health ? [{ kind: 'policy', ref: health.id, detail: `group health for ${health.lives ?? '?'} lives; no group life on the account` }] : [],
        estPremiumTTD: estimatePremiumTTD('group_life', client, { lives: client.headcount }),
        confidence: 0.8,
        effort: 'medium',
      })];
    },
  },

  {
    id: 'no_critical_illness',
    title: 'Mature benefits programme without critical illness',
    kind: 'gap',
    run(client, ctx) {
      if (!hasLine(ctx.ix, client.id, 'group_health_local')) return [];
      if (!hasLine(ctx.ix, client.id, 'group_life')) return [];
      if (hasLine(ctx.ix, client.id, 'group_critical_illness')) return [];

      const summary = claimsSummary(ctx.ix, client.id);
      const inpatient = summary.byCategory.inpatient;
      return [make(client, ctx, {
        ruleId: this.id, ruleTitle: this.title, kind: this.kind,
        line: 'group_critical_illness',
        headline: 'Medical and life in place; nothing covers the cost of surviving a serious diagnosis',
        rationale:
          `This client already funds medical and group life, which means the benefits conversation is established and the ` +
          `remaining gap is the one in between: the household costs that arrive with a serious diagnosis and are not ` +
          `medical bills. Critical illness pays a lump sum on diagnosis, independent of treatment cost. ` +
          (inpatient ? `The plan has paid ${money(inpatient.paidTTD)} across ${inpatient.count} in-patient episodes in two years, which makes the case concretely rather than in the abstract.` : ''),
        evidence: [
          { kind: 'client', ref: client.id, detail: 'group health and group life both in force; no critical illness' },
          inpatient && { kind: 'claim', ref: `${client.id}:inpatient`, detail: `${inpatient.count} in-patient claims, ${money(inpatient.paidTTD)} paid` },
        ].filter(Boolean),
        estPremiumTTD: estimatePremiumTTD('group_critical_illness', client),
        confidence: 0.6,
        effort: 'medium',
      })];
    },
  },

  {
    id: 'declined_claims_signal_rider',
    title: 'Repeated declines in an excluded benefit category',
    kind: 'signal',
    run(client, ctx) {
      if (!hasLine(ctx.ix, client.id, 'group_health_local')) return [];
      const summary = claimsSummary(ctx.ix, client.id);
      const out = [];

      for (const [category, line] of [['dental', 'dental_rider'], ['vision', 'vision_rider']]) {
        const bucket = summary.byCategory[category];
        if (!bucket || bucket.declinedCount < 4) continue;
        if (hasLine(ctx.ix, client.id, line)) continue;

        out.push(make(client, ctx, {
          ruleId: this.id, ruleTitle: this.title, kind: this.kind,
          line,
          headline: `${bucket.declinedCount} ${category} claims declined in two years — the demand is already measured`,
          rationale:
            `Members submitted ${bucket.count} ${category} claims over the last two years and ${bucket.declinedCount} were ` +
            `declined as excluded, totalling ${money(bucket.declinedTTD)} that members paid themselves. This is the ` +
            `strongest kind of evidence a benefits recommendation can have: the client's own people have already told them ` +
            `what is missing, one rejected claim at a time. A ${category} rider costs a fraction of the base plan and is ` +
            `the most visible benefits improvement an HR manager can announce.`,
          evidence: [
            { kind: 'claim', ref: `${client.id}:${category}`, detail: `${bucket.declinedCount} of ${bucket.count} ${category} claims declined, ${money(bucket.declinedTTD)} borne by members` },
            ...Object.entries(bucket.declineReasons ?? {}).slice(0, 1).map(([reason, n]) => ({ kind: 'claim', ref: `${client.id}:${category}:reason`, detail: `"${reason}" × ${n}` })),
          ],
          estPremiumTTD: estimatePremiumTTD(line, client),
          confidence: 0.85,
          effort: 'low',
        }));
      }
      return out;
    },
  },

  {
    id: 'dependants_ageing_out',
    title: 'Dependants about to lose cover',
    kind: 'lifecycle',
    run(client, ctx) {
      const members = membersFor(ctx.ix, client.id);
      if (!members.length) return [];

      const leaving = [];
      for (const member of members) {
        if (member.role !== 'child' || !member.dob) continue;
        const age = ageOf(member.dob, ctx.now);
        // Cover ends at 21, or at 25 where the child is in full-time tertiary education.
        const ceiling = member.tertiaryEnrolled ? 25 : 21;
        const yearsLeft = ceiling - age;
        if (yearsLeft < 0 || yearsLeft > 0.5) continue;
        leaving.push({ member, age, ceiling, days: Math.round(yearsLeft * 365.25) });
      }
      if (leaving.length < 2) return [];

      leaving.sort((a, b) => a.days - b.days);
      return [make(client, ctx, {
        ruleId: this.id, ruleTitle: this.title, kind: this.kind,
        line: 'individual_life',
        headline: `${leaving.length} dependants come off the plan within six months`,
        rationale:
          `${leaving.length} children on this client's census reach the age ceiling within six months — the soonest in ` +
          `${leaving[0].days} days. Each one is a household that is about to discover it has no cover, and a personal-lines ` +
          `conversation AIB is better placed to have than anyone else, because AIB knows the date it happens. Handled ` +
          `early it is a service the employer gets credit for; handled late it is a complaint the HR manager fields. ` +
          `Note that cover extends to 25 where the child is in full-time tertiary education, so proof of enrolment may ` +
          `change some of these dates.`,
        evidence: leaving.slice(0, 5).map(({ member, age, ceiling, days }) => ({
          kind: 'member', ref: member.id,
          detail: `age ${age.toFixed(1)}, ceiling ${ceiling}${member.tertiaryEnrolled ? ' (tertiary enrolled)' : ''}, ${days} days remaining`,
        })),
        estPremiumTTD: estimatePremiumTTD('individual_life', client) * Math.min(leaving.length, 6),
        confidence: 0.7,
        effort: 'medium',
      })];
    },
  },

  {
    id: 'no_group_personal_accident',
    title: 'Physical-risk workforce without personal accident cover',
    kind: 'gap',
    run(client, ctx) {
      if (client.segment === 'personal') return [];
      if (!FIELD_RISK.has(client.industry)) return [];
      if ((client.headcount ?? 0) < 20) return [];
      if (hasLine(ctx.ix, client.id, 'group_personal_accident')) return [];

      return [make(client, ctx, {
        ruleId: this.id, ruleTitle: this.title, kind: this.kind,
        line: 'group_personal_accident',
        headline: `${client.headcount} employees in a physical-risk industry with no personal accident cover`,
        rationale:
          `A ${client.industry.toLowerCase()} workforce of ${client.headcount} carries meaningful accident exposure both ` +
          `on and off duty, and no group personal accident cover is in force. GPA is inexpensive, underwrites on headcount ` +
          `rather than individual medicals, and is the lowest-friction way into a benefits relationship with an employer ` +
          `who has resisted a full medical plan on cost.`,
        evidence: [{ kind: 'client', ref: client.id, detail: `${client.industry}, ${client.headcount} employees, no GPA` }],
        estPremiumTTD: estimatePremiumTTD('group_personal_accident', client, { lives: client.headcount }),
        confidence: 0.68,
        effort: 'low',
      })];
    },
  },

  // --------------------------------------------------------------- portfolio
  {
    id: 'single_line_client',
    title: 'Single-line client at risk of walking',
    kind: 'portfolio',
    run(client, ctx) {
      const policies = policiesFor(ctx.ix, client.id);
      if (policies.length !== 1) return [];
      const only = policies[0];
      const tenure = yearsSince(client.relationshipStart, ctx.now);

      // What do comparable clients carry that this one does not?
      const cohort = ctx.benchmarks.get(cohortKey(client));
      const suggestions = cohort
        ? Object.entries(cohort.attachRate)
            .filter(([line, rate]) => rate >= 0.4 && line !== only.line && CATALOGUE[line])
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([line]) => CATALOGUE[line].name)
        : [];

      return [make(client, ctx, {
        ruleId: this.id, ruleTitle: this.title, kind: this.kind,
        line: only.line,
        headline: `${tenure.toFixed(1)} years as a client and still only one policy`,
        rationale:
          `This client holds a single policy — ${only.id}, ${CATALOGUE[only.line]?.name ?? only.line} — after ` +
          `${tenure.toFixed(1)} years. Single-line accounts are the ones that leave: there is nothing holding them beyond ` +
          `price, and a competitor only has to win one quote. ` +
          (suggestions.length
            ? `Comparable clients on the book carry ${suggestions.join(', ')}, which is the natural place to start.`
            : `Rounding out even one more line materially changes the retention profile.`),
        evidence: [
          { kind: 'policy', ref: only.id, detail: `sole active policy, ${money(toTTD(only.annualPremium ?? 0, only.currency))} premium` },
          cohort && { kind: 'benchmark', ref: cohortKey(client), detail: `${cohort.peers.length} comparable clients on the book` },
        ].filter(Boolean),
        estPremiumTTD: Math.round(toTTD(only.annualPremium ?? 0, only.currency) * 0.6),
        confidence: 0.6,
        effort: 'medium',
      })];
    },
  },

  {
    id: 'peer_attach_gap',
    title: 'Line carried by most comparable clients but not this one',
    kind: 'portfolio',
    run(client, ctx) {
      const cohort = ctx.benchmarks.get(cohortKey(client));
      if (!cohort || cohort.peers.length < 4) return [];
      const held = ctx.ix.linesByClient.get(client.id) ?? new Set();
      const out = [];

      for (const [line, rate] of Object.entries(cohort.attachRate)) {
        if (rate < 0.6 || held.has(line)) continue;
        const catalogueEntry = CATALOGUE[line];
        if (!catalogueEntry) continue;

        out.push(make(client, ctx, {
          ruleId: this.id, ruleTitle: this.title, kind: this.kind,
          line,
          headline: `${Math.round(rate * 100)}% of comparable clients carry ${catalogueEntry.name} and this one does not`,
          rationale:
            `Across ${cohort.peers.length} clients on AIB's book in the same industry and size band, ` +
            `${Math.round(rate * 100)}% carry ${catalogueEntry.name}. This client does not. That is a pattern drawn from ` +
            `AIB's own placements rather than a market assumption, which makes it straightforward to raise: their peers ` +
            `have already reached this conclusion. Check for a specific reason it was declined before treating it as an ` +
            `open gap.`,
          evidence: [
            { kind: 'benchmark', ref: cohortKey(client), detail: `${Math.round(rate * 100)}% attach across ${cohort.peers.length} peers: ${cohort.peers.slice(0, 6).join(', ')}` },
          ],
          estPremiumTTD: estimatePremiumTTD(line, client),
          confidence: 0.45 + Math.min(0.25, (rate - 0.6) * 0.8),
          effort: 'medium',
        }));
      }
      return out;
    },
  },
];

// ------------------------------------------------------------------ helpers

/**
 * Most liability findings differ only in which industry they apply to and what
 * the argument is, so they share one shape. Writing them out longhand would be
 * six near-identical blocks and six places to fix the same bug.
 */
function liabilityGap({ id, line, title, applies, headline, rationale, confidence, effort = 'medium' }) {
  return {
    id, title, kind: /** @type {const} */ ('gap'),
    run(client, ctx) {
      if (!applies(client)) return [];
      if (hasLine(ctx.ix, client.id, line)) return [];
      return [make(client, ctx, {
        ruleId: id, ruleTitle: title, kind: 'gap', line,
        headline: headline(client),
        rationale: rationale(client),
        evidence: [{
          kind: 'client', ref: client.id,
          detail: `${client.industry}, ${client.headcount} employees, turnover ${money(client.annualRevenueTTD ?? 0)}; no ${line} in force`,
        }],
        estPremiumTTD: estimatePremiumTTD(line, client),
        confidence: confidence(client),
        effort,
      })];
    },
  };
}

/** Assemble an opportunity, filling in everything derivable from the client. */
function make(client, ctx, fields) {
  const renewal = nextRenewalFor(ctx.ix, client.id, ctx.now);
  const estPremiumTTD = Math.round(fields.estPremiumTTD ?? 0);
  return {
    id: `${client.id}:${fields.ruleId}:${fields.line}`,
    clientId: client.id,
    clientName: client.name,
    family: CATALOGUE[fields.line]?.family ?? 'general',
    tpa: CATALOGUE[fields.line]?.tpa ?? false,
    urgencyDays: renewal?.days ?? 365,
    nextRenewal: renewal ? { policyId: renewal.policy.id, line: renewal.policy.line, date: renewal.policy.renewalDate } : null,
    ...fields,
    estPremiumTTD,
    estRevenueTTD: estimateRevenueTTD(fields.line, estPremiumTTD),
  };
}

/** @param {number} n @param {'TTD'|'USD'} [currency] */
function money(n, currency = 'TTD') {
  const value = Math.round(n ?? 0).toLocaleString('en-US');
  return currency === 'USD' ? `US$${value}` : `TT$${value}`;
}

// ---------------------------------------------------------------- the engine

/**
 * Run every rule across every client (or a subset) and return deduplicated
 * opportunities.
 *
 * Where two rules land on the same client and line — a specific gap rule and
 * the peer-benchmark rule usually — the more confident one wins and the other
 * is folded in as corroboration. Presenting both as separate findings would
 * inflate the pipeline with the same recommendation counted twice.
 *
 * @param {import('../data/book.js').BookIndex} ix
 * @param {{clientIds?: string[], now?: Date, benchmarks?: Map<string, any>, ruleIds?: string[]}} [opts]
 * @returns {Opportunity[]}
 */
export function findOpportunities(ix, opts = {}) {
  const now = opts.now ?? new Date();
  const benchmarks = opts.benchmarks ?? new Map();
  const ctx = { ix, now, benchmarks };

  const clients = opts.clientIds
    ? opts.clientIds.map((id) => ix.clientsById.get(id)).filter(Boolean)
    : ix.book.clients;

  const rules = opts.ruleIds ? RULES.filter((r) => opts.ruleIds.includes(r.id)) : RULES;

  /** @type {Map<string, Opportunity>} */
  const byClientLine = new Map();

  for (const client of clients) {
    for (const rule of rules) {
      let produced;
      try {
        produced = rule.run(client, ctx) ?? [];
      } catch (err) {
        // One malformed record must not take down the whole sweep.
        console.warn(`rule ${rule.id} failed on ${client.id}: ${err.message}`);
        continue;
      }

      for (const opp of produced) {
        const key = `${opp.clientId}:${opp.line}`;
        const existing = byClientLine.get(key);
        if (!existing) {
          byClientLine.set(key, opp);
        } else if (opp.confidence > existing.confidence) {
          opp.corroboratedBy = [...(existing.corroboratedBy ?? []), existing.ruleId];
          byClientLine.set(key, opp);
        } else {
          existing.corroboratedBy = [...(existing.corroboratedBy ?? []), opp.ruleId];
        }
      }
    }
  }

  return [...byClientLine.values()];
}
