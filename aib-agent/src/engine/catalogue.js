/**
 * What AIB can place, and roughly what it earns.
 *
 * The rules engine only ever proposes a line that exists here, so this file is
 * the control surface: delete a line and the agent stops recommending it;
 * change a rate and every estimate moves with it. Rates are indicative
 * placeholders for sizing an opportunity — they are not quotes, and the README
 * says so in the words a compliance officer would want.
 *
 * Brokerage rates are empirical: derived from AIB's own IBR transaction
 * register (61,605 transactions, Dec 2024 - Jun 2026), as realised brokerage
 * over gross premium per profit centre. They are what AIB actually earned on
 * that business, not a rate card, so they already carry the mix of negotiated
 * terms and overrides in the book. Blended across all lines it comes to 8.5%.
 *
 * `basis` tells the estimator how to size a premium:
 *   per_life     - benefits lines, priced per covered life per year
 *   per_vehicle  - motor fleet
 *   rate_on_sum  - property/marine/engineering, priced as a rate on sum insured
 *   pct_revenue  - liability/cyber, priced off turnover
 *   flat         - everything with a conventional minimum
 */

import { TPA_NAME, TPA_ENABLED, TPA_REVENUE_SHARE, TPA_RELATIONSHIP } from '../config.js';

/** @typedef {'per_life'|'per_vehicle'|'rate_on_sum'|'pct_revenue'|'flat'} Basis */

/**
 * @typedef {Object} Product
 * @property {string} key
 * @property {string} name
 * @property {'general'|'benefits'|'personal'|'service'} family
 * @property {string} description        Written for the model, not for a brochure.
 * @property {Basis} basis
 * @property {number} rate               Interpreted per `basis`.
 * @property {number} [minPremiumTTD]
 * @property {number} revenueRate      Share of premium that accrues to AIB. Brokerage on placed
 *                                     lines; on administration lines it depends on the TPA
 *                                     relationship — see src/config.js.
 * @property {string[]} [requires]       Lines that must already exist for this to make sense.
 * @property {boolean} [tpa]             An administration line delivered by the health TPA.
 *                                       Removed from the catalogue when AIB has no relationship
 *                                       with it (AIB_TPA_RELATIONSHIP=none).
 */

/** @type {Record<string, Product>} */
export const CATALOGUE = {
  // ---------------------------------------------------------------- general
  property_all_risk: {
    key: 'property_all_risk',
    name: 'Property All Risk',
    family: 'general',
    description:
      'Material damage to buildings, plant, stock and contents. The anchor line for most commercial accounts; sums insured drift out of date faster than anything else in the book.',
    basis: 'rate_on_sum',
    rate: 0.0035,
    minPremiumTTD: 6000,
    revenueRate: 0.078, // Property
    semantic: 'property',
  },
  business_interruption: {
    key: 'business_interruption',
    name: 'Business Interruption',
    family: 'general',
    description:
      'Loss of gross profit and increased cost of working after an insured material damage event. Meaningless without an underlying property policy, which is exactly why it is so often missing.',
    basis: 'rate_on_sum',
    rate: 0.0042,
    minPremiumTTD: 8000,
    revenueRate: 0.078, // Property
    semantic: 'pecuniary',
    requires: ['property_all_risk'],
  },
  motor_fleet: {
    key: 'motor_fleet',
    name: 'Motor Fleet',
    family: 'general',
    description:
      'Comprehensive cover across a commercial vehicle fleet on a single schedule. Vehicle counts move constantly and declared counts lag reality.',
    basis: 'per_vehicle',
    rate: 4200,
    minPremiumTTD: 12000,
    revenueRate: 0.15, // Motor Vehicle
    semantic: 'motor',
  },
  marine_cargo: {
    key: 'marine_cargo',
    name: 'Marine Cargo',
    family: 'general',
    description:
      'Goods in transit by sea, air or land. Near-mandatory for importers and distributors in Trinidad and Tobago; frequently assumed to sit with the supplier when it does not.',
    basis: 'rate_on_sum',
    rate: 0.0045,
    minPremiumTTD: 5000,
    revenueRate: 0.129, // Marine, Aviation and Transport
    semantic: 'marine',
  },
  public_liability: {
    key: 'public_liability',
    name: 'Public Liability',
    family: 'general',
    description:
      'Third-party bodily injury and property damage arising from the business. The first liability line any customer-facing operation should carry.',
    basis: 'pct_revenue',
    rate: 0.0011,
    minPremiumTTD: 7000,
    revenueRate: 0.088, // Liability
    semantic: 'liability',
  },
  employers_liability: {
    key: 'employers_liability',
    name: "Employers' Liability",
    family: 'general',
    description:
      'Employer legal liability for workplace injury and disease, sitting above statutory workmen\'s compensation. Exposure scales directly with headcount.',
    basis: 'pct_revenue',
    rate: 0.0009,
    minPremiumTTD: 6000,
    revenueRate: 0.088, // Liability
    semantic: 'liability',
  },
  products_liability: {
    key: 'products_liability',
    name: 'Products Liability',
    family: 'general',
    description:
      'Liability for injury or damage caused by goods sold or manufactured. Belongs with any manufacturer or distributor putting product into the market.',
    basis: 'pct_revenue',
    rate: 0.001,
    minPremiumTTD: 7500,
    revenueRate: 0.088, // Liability
    semantic: 'liability',
  },
  professional_indemnity: {
    key: 'professional_indemnity',
    name: 'Professional Indemnity',
    family: 'general',
    description:
      'Negligent act, error or omission in professional advice or services. Increasingly a contractual requirement rather than a discretionary purchase.',
    basis: 'pct_revenue',
    rate: 0.0014,
    minPremiumTTD: 9000,
    revenueRate: 0.088, // Liability
    semantic: 'liability',
  },
  directors_officers: {
    key: 'directors_officers',
    name: "Directors' & Officers' Liability",
    family: 'general',
    description:
      'Personal liability of directors and officers for management decisions. Boards ask for it by name once a company reaches any real scale or takes on outside capital.',
    basis: 'pct_revenue',
    rate: 0.0012,
    minPremiumTTD: 12000,
    revenueRate: 0.088, // Liability
    semantic: 'liability',
  },
  cyber_liability: {
    key: 'cyber_liability',
    name: 'Cyber Liability',
    family: 'general',
    description:
      'Breach response, business interruption from a cyber event, extortion and third-party liability. The fastest-growing gap in the regional commercial book.',
    basis: 'pct_revenue',
    rate: 0.0016,
    minPremiumTTD: 10000,
    revenueRate: 0.088, // Liability
    semantic: 'liability',
  },
  contractors_all_risk: {
    key: 'contractors_all_risk',
    name: 'Contractors All Risk',
    family: 'general',
    description:
      'Works, plant and third-party liability across a construction project. Placed per contract, so a contractor with none on the books is usually placing it elsewhere.',
    basis: 'rate_on_sum',
    rate: 0.005,
    minPremiumTTD: 15000,
    revenueRate: 0.078, // Property
    semantic: 'property',
  },
  machinery_breakdown: {
    key: 'machinery_breakdown',
    name: 'Machinery Breakdown',
    family: 'general',
    description:
      'Sudden and unforeseen mechanical or electrical failure of plant. Property all risk excludes it, which surprises most manufacturing clients.',
    basis: 'rate_on_sum',
    rate: 0.0028,
    minPremiumTTD: 6000,
    revenueRate: 0.078, // Property
    semantic: 'property',
    requires: ['property_all_risk'],
  },
  money_fidelity: {
    key: 'money_fidelity',
    name: 'Money & Fidelity Guarantee',
    family: 'general',
    description:
      'Cash in transit and on premises, plus employee dishonesty. Small premium, high attach rate, and an easy round-out at renewal.',
    basis: 'flat',
    rate: 9000,
    revenueRate: 0.136, // Pecuniary Loss
    semantic: 'pecuniary',
  },
  group_personal_accident: {
    key: 'group_personal_accident',
    name: 'Group Personal Accident',
    family: 'general',
    description:
      'Lump sum for accidental death or disablement, covering employees on and off duty. Often the cheapest way to start a benefits conversation.',
    basis: 'per_life',
    rate: 320,
    minPremiumTTD: 5000,
    revenueRate: 0.172, // Personal Accident Short Term
    semantic: 'personal_accident',
  },

  // --------------------------------------------------------------- benefits
  group_health_local: {
    key: 'group_health_local',
    name: 'Group Health (Local)',
    family: 'benefits',
    description:
      'Local medical plan covering in-patient, out-patient and prescription benefits for employees and dependants.',
    basis: 'per_life',
    rate: 6200,
    minPremiumTTD: 40000,
    revenueRate: 0.061, // Accident and Sickness
    semantic: 'health',
  },
  intl_health_usd: {
    key: 'intl_health_usd',
    name: 'US Dollar International Health Plan',
    family: 'benefits',
    description:
      'USD-denominated international plan for senior staff, sitting above the local plan and settling with overseas ' +
      'providers directly' + (TPA_ENABLED ? ` through the ${TPA_NAME} network` : '') + '. Sold on access to overseas ' +
      'specialist care, not on price.',
    basis: 'per_life',
    rate: 8900,
    minPremiumTTD: 60000,
    revenueRate: 0.061, // Accident and Sickness
    semantic: 'health',
  },
  group_life: {
    key: 'group_life',
    name: 'Group Life',
    family: 'benefits',
    description:
      'Death-in-service lump sum, conventionally a multiple of annual salary. The natural companion to a group health plan and usually the next thing a client buys.',
    basis: 'per_life',
    rate: 1400,
    minPremiumTTD: 15000,
    revenueRate: 0.077, // Life
    semantic: 'life',
  },
  group_critical_illness: {
    key: 'group_critical_illness',
    name: 'Group Critical Illness',
    family: 'benefits',
    description:
      'Accelerated lump sum on diagnosis of a defined condition. Sold against the out-of-pocket gap a medical plan leaves behind.',
    basis: 'per_life',
    rate: 900,
    minPremiumTTD: 12000,
    revenueRate: 0.061, // Accident and Sickness
    semantic: 'health',
    requires: ['group_health_local'],
  },
  dental_rider: {
    key: 'dental_rider',
    name: 'Dental Rider',
    family: 'benefits',
    description:
      'Routine and restorative dental benefit bolted onto a medical plan. Excluded from most base plans, so declined dental claims are a direct signal of demand.',
    basis: 'per_life',
    rate: 780,
    minPremiumTTD: 8000,
    revenueRate: 0.061, // Accident and Sickness
    semantic: 'health',
    requires: ['group_health_local'],
  },
  vision_rider: {
    key: 'vision_rider',
    name: 'Vision Rider',
    family: 'benefits',
    description:
      'Routine eye examinations, frames and lenses. Low premium, high visibility with staff, and excluded from most base medical plans.',
    basis: 'per_life',
    rate: 420,
    minPremiumTTD: 5000,
    revenueRate: 0.061, // Accident and Sickness
    semantic: 'health',
    requires: ['group_health_local'],
  },
  group_pension: {
    key: 'group_pension',
    name: 'Group Pension / Retirement Plan',
    family: 'benefits',
    description:
      'Defined contribution retirement arrangement with administration and member servicing. Long sales cycle, extremely sticky once placed.',
    basis: 'pct_revenue',
    rate: 0.0008,
    minPremiumTTD: 25000,
    revenueRate: 0.077, // Life
    semantic: 'life',
  },

  // --------------------------------------------------------------- personal
  private_motor: {
    key: 'private_motor',
    name: 'Private Motor',
    family: 'personal',
    description: 'Comprehensive or third-party cover on a private vehicle.',
    basis: 'flat',
    rate: 5200,
    revenueRate: 0.15, // Motor Vehicle
    semantic: 'motor',
  },
  homeowners: {
    key: 'homeowners',
    name: 'Homeowners',
    family: 'personal',
    description: 'Buildings and contents cover on a private dwelling, including catastrophe perils.',
    basis: 'rate_on_sum',
    rate: 0.0032,
    minPremiumTTD: 2500,
    revenueRate: 0.078, // Property
    semantic: 'property',
  },
  individual_life: {
    key: 'individual_life',
    name: 'Individual Life',
    family: 'personal',
    description:
      'Personal term or whole of life cover. The natural landing place for a dependant ageing off a group plan.',
    basis: 'flat',
    rate: 7200,
    revenueRate: 0.077, // Life
    semantic: 'life',
  },
  travel: {
    key: 'travel',
    name: 'Travel Insurance',
    family: 'personal',
    description: 'Medical and trip cover for individuals and families travelling overseas.',
    basis: 'flat',
    rate: 1800,
    revenueRate: 0.061, // Accident and Sickness
    semantic: 'health',
  },

  // ------------------------------------------ health administration services
  //
  // These describe the TPA arrangement, not a corporate structure. What AIB
  // earns and how the analyst is allowed to characterise the relationship both
  // come from src/config.js, because neither is knowable from the book.
  cardea_tpa: {
    key: 'cardea_tpa',
    name: `${TPA_NAME} Third-Party Administration`,
    family: 'service',
    description:
      `${TPA_NAME} adjudicates medical claims and pays providers or members directly. Moving administration to ` +
      `${TPA_NAME} gives AIB claims visibility it does not get when the carrier or the client self-administers, and ` +
      `that visibility is what makes every other benefits recommendation on the account possible.`,
    basis: 'per_life',
    rate: 540,
    minPremiumTTD: 25000,
    revenueRate: TPA_REVENUE_SHARE,
    semantic: 'health',
    requires: ['group_health_local'],
    tpa: true,
  },
  cardea_overseas_network: {
    key: 'cardea_overseas_network',
    name: `${TPA_NAME} Overseas Provider Network`,
    family: 'service',
    description:
      `Access to ${TPA_NAME}'s overseas provider network with pre-certification and direct settlement at in-network ` +
      `pricing, so members avoid paying up front and claiming back. Sold on member experience and out-of-pocket ` +
      `reduction.`,
    basis: 'per_life',
    rate: 310,
    minPremiumTTD: 15000,
    revenueRate: TPA_REVENUE_SHARE,
    semantic: 'health',
    requires: ['group_health_local'],
    tpa: true,
  },
};

// With no TPA relationship the administration lines are not something AIB can
// place, so they are removed outright rather than left in and filtered later.
// Deleting them here also switches off every rule that proposes them, because
// the rules only ever name a line that exists in this catalogue.
if (!TPA_ENABLED) {
  for (const [key, entry] of Object.entries(CATALOGUE)) {
    if (entry.tpa) delete CATALOGUE[key];
  }
}

/** The semantic category of a line, or null if unmapped. */
export function semanticOf(key) {
  return CATALOGUE[key]?.semantic ?? null;
}

/** True when the line is delivered by the health TPA rather than placed with a carrier. */
export function isTpaLine(key) {
  return Boolean(CATALOGUE[key]?.tpa);
}

/**
 * Realised brokerage by profit centre, from the IBR register. Lines discovered
 * in a live export are rated from this table rather than guessed at.
 */
export const PROFIT_CENTRE_RATES = {
  'Property': 0.078,
  'Motor Vehicle': 0.15,
  'Marine, Aviation and Transport': 0.129,
  'Liability': 0.088,
  'Workers Compensation': 0.13,
  'Accident and Sickness': 0.061,
  'Life': 0.077,
  'Pecuniary Loss': 0.136,
  'Personal Accident Short Term': 0.172,
  'Disability Income': 0.125,
};

/**
 * What a line *is*, independent of what anyone calls it.
 *
 * Rules must not name line keys directly. This codebase invented keys like
 * `group_health_local`; AIB's register calls the same thing `GPHH`; a third
 * export will call it something else again. A rule that says "health cover
 * with no life cover" should hold in all three, so rules reason about
 * semantics and the mapping lives here.
 */
export const PROFIT_CENTRE_SEMANTICS = {
  'Property': 'property',
  'Motor Vehicle': 'motor',
  'Marine, Aviation and Transport': 'marine',
  'Liability': 'liability',
  'Workers Compensation': 'workers_comp',
  'Accident and Sickness': 'health',
  'Life': 'life',
  'Pecuniary Loss': 'pecuniary',
  'Personal Accident Short Term': 'personal_accident',
  'Disability Income': 'disability',
};

/** Line codes whose profit centre understates them — group life sits under Accident and Sickness. */
export const LINE_CODE_SEMANTICS = {
  GLFH: 'life',
  GPLF: 'life',
  GPHH: 'health',
};

/** Blended rate, used when a profit centre is unrecognised. */
export const BLENDED_REVENUE_RATE = 0.085;

const DEPARTMENT_FAMILY = {
  'Personal Lines': 'personal',
  'Corporate': 'general',
  'Binding Facilities': 'general',
  'Employee Benefits': 'benefits',
  'Third Party Administration': 'service',
};

/**
 * Register a line discovered in a live export.
 *
 * AIB's register carries 92 line codes of its own; this codebase cannot know
 * what each means, and inventing a description would be worse than admitting
 * it. So a discovered line is registered with its code as its name, its family
 * taken from the department that wrote it, and its rate from the profit centre
 * — all facts the register actually supplies. Anything richer has to come from
 * someone at AIB.
 *
 * @param {{code: string, profitCentre?: string, department?: string}} entry
 */
export function registerLine({ code, profitCentre, department }) {
  if (!code || CATALOGUE[code]) return CATALOGUE[code];
  return (CATALOGUE[code] = {
    key: code,
    name: code,
    family: DEPARTMENT_FAMILY[department] ?? 'general',
    description:
      `Line code ${code} from AIB's register` +
      (profitCentre ? `, in the ${profitCentre} profit centre` : '') +
      (department ? `, written by ${department}` : '') +
      '. No description held — the register carries the code but not its meaning.',
    basis: 'flat',
    rate: 10000,
    revenueRate: PROFIT_CENTRE_RATES[profitCentre] ?? BLENDED_REVENUE_RATE,
    semantic: LINE_CODE_SEMANTICS[code] ?? PROFIT_CENTRE_SEMANTICS[profitCentre] ?? null,
    profitCentre,
    department,
    discovered: true,
  });
}

/** @param {string} key */
export function product(key) {
  const p = CATALOGUE[key];
  if (!p) throw new Error(`Unknown product line "${key}" — add it to engine/catalogue.js or register it from the export`);
  return p;
}

/** Like `product`, but tolerates a line the catalogue has never seen. */
export function productOrNull(key) {
  return CATALOGUE[key] ?? null;
}

export const LINE_KEYS = Object.keys(CATALOGUE);

/** @param {'general'|'benefits'|'personal'|'service'} family */
export function linesInFamily(family) {
  return Object.values(CATALOGUE).filter((p) => p.family === family);
}

/**
 * Indicative annual premium for placing `line` at `client`. Deliberately blunt:
 * the point is to rank opportunities against each other, not to quote.
 *
 * @param {string} line
 * @param {import('../data/schema.js').Client} client
 * @param {{sumInsured?: number, lives?: number, vehicles?: number}} [ctx]
 * @returns {number} TTD
 */
export function estimatePremiumTTD(line, client, ctx = {}) {
  const p = product(line);
  const revenue = client.annualRevenueTTD ?? 0;
  const lives = ctx.lives ?? livesFor(client);
  let raw;

  switch (p.basis) {
    case 'per_life':
      raw = p.rate * lives;
      break;
    case 'per_vehicle':
      raw = p.rate * (ctx.vehicles ?? 0);
      break;
    case 'rate_on_sum':
      raw = p.rate * (ctx.sumInsured ?? impliedSumInsured(client));
      break;
    case 'pct_revenue':
      raw = p.rate * revenue;
      break;
    case 'flat':
    default:
      raw = p.rate;
      break;
  }

  return Math.round(Math.max(raw, p.minPremiumTTD ?? 0));
}

/**
 * Revenue to the AIB group from an estimated premium: brokerage on a placed
 * line, or the full fee on a Cardea service.
 * @param {string} line @param {number} premiumTTD
 */
export function estimateRevenueTTD(line, premiumTTD) {
  const rate = CATALOGUE[line]?.revenueRate ?? BLENDED_REVENUE_RATE;
  return Math.round(premiumTTD * rate);
}

/**
 * Covered lives for a client, counting dependants. Employees rarely enrol alone,
 * so a flat multiplier keeps benefits estimates from reading absurdly low.
 * @param {import('../data/schema.js').Client} client
 */
export function livesFor(client) {
  return Math.max(1, Math.round((client.headcount ?? 0) * 1.8));
}

/**
 * Rough asset base when a client has no property policy to read a sum insured
 * from. Used only to size a first property or engineering opportunity.
 * @param {import('../data/schema.js').Client} client
 */
export function impliedSumInsured(client) {
  const revenue = client.annualRevenueTTD ?? 0;
  const byRevenue = revenue * 0.6;
  const byHeadcount = (client.headcount ?? 0) * 180000;
  return Math.max(byRevenue, byHeadcount, 500000);
}
