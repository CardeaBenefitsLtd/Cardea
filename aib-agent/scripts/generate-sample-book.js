#!/usr/bin/env node
/**
 * Builds a synthetic AIB book of business that exercises every rule.
 *
 * Deterministic by design: same seed, same book, so a rule change shows up as a
 * diff in the output rather than as noise. Nothing here is real client data —
 * this exists so the system can be demonstrated and tested before anyone
 * exports anything from the live policy administration system.
 *
 *   node scripts/generate-sample-book.js [--seed 20260725] [--out src/data/sample-book.json]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- randomness

/** mulberry32 — small, fast, and reproducible. @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const args = process.argv.slice(2);
const seed = Number(argValue('--seed') ?? 20260725);
const outPath = resolve(here, '..', argValue('--out') ?? 'src/data/sample-book.json');
const rand = rng(seed);

function argValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + rand() * (hi - lo);
const intBetween = (lo, hi) => Math.floor(between(lo, hi + 1));
const chance = (p) => rand() < p;
const round = (n, to = 1000) => Math.round(n / to) * to;

// ------------------------------------------------------------------- calendar

const TODAY = new Date('2026-07-25T00:00:00Z');

function isoShift(days, from = TODAY) {
  const d = new Date(from.getTime() + days * 86400000);
  return d.toISOString().slice(0, 10);
}
function isoYearsAgo(years) {
  return isoShift(-Math.round(years * 365.25));
}

// --------------------------------------------------------------------- names

const TT_TOWNS = [
  'Port of Spain', 'San Fernando', 'Chaguanas', 'Arima', 'Point Lisas',
  'Couva', 'Tunapuna', 'Scarborough', 'Princes Town', 'La Romaine',
  'Diego Martin', 'Sangre Grande', 'Point Fortin', 'Marabella', 'Piarco',
];
// Towns on the Caroni basin and the south-west coast take the worst of the
// seasonal flooding; the flag drives the flood-extension rule.
const FLOOD_PRONE = new Set(['Chaguanas', 'Couva', 'Port of Spain', 'Marabella', 'Sangre Grande', 'La Romaine']);

const FIRST = ['Anand', 'Kamla', 'Denzil', 'Roshni', 'Curtis', 'Ayanna', 'Rajiv', 'Shivani', 'Marlon', 'Cherisse', 'Terrence', 'Nadia', 'Kwesi', 'Priya', 'Dwayne', 'Lisa-Marie'];
const LAST = ['Ramsingh', 'Boodoo', 'Charles', 'Mohammed', 'La Fleur', 'Persad', 'Alleyne', 'Maharaj', 'Joseph', 'Baptiste', 'Seepersad', 'Guerra', 'Sookdeo', 'Cummings', 'Rampersad'];

const AES = ['R. Boodoo', 'A. Charles', 'S. Maharaj', 'D. Alleyne', 'N. Persad'];

const CARRIERS = {
  general: ['Guardian General', 'Sagicor General', 'TATIL', 'Beacon Insurance', 'Massy United', 'GTM Insurance'],
  benefits: ['Guardian Life', 'Sagicor Life', 'TATIL Life', 'Pan-American Life'],
};

/** Company names that read like a real T&T commercial book. */
const COMPANY_SHAPES = {
  Manufacturing: ['{n} Industries Ltd', '{n} Manufacturing Company Ltd', '{n} Plastics Ltd'],
  Distribution: ['{n} Trading Ltd', '{n} Distributors Ltd', '{n} Import & Export Ltd'],
  Retail: ['{n} Retail Group Ltd', '{n} Stores Ltd', '{n} Supermarkets Ltd'],
  Construction: ['{n} Construction Ltd', '{n} Contracting Services Ltd', '{n} Civil Works Ltd'],
  Energy: ['{n} Energy Services Ltd', '{n} Oilfield Services Ltd', '{n} Petrochemicals Ltd'],
  'Financial Services': ['{n} Financial Ltd', '{n} Capital Ltd', '{n} Credit Union'],
  'Professional Services': ['{n} & Associates', '{n} Advisory Ltd', '{n} Consulting Group'],
  Hospitality: ['{n} Hotels Ltd', '{n} Resorts Ltd', '{n} Restaurant Group Ltd'],
  Agriculture: ['{n} Estates Ltd', '{n} Agro Ltd', '{n} Farms Ltd'],
  Healthcare: ['{n} Medical Centre Ltd', '{n} Diagnostics Ltd', '{n} Health Services Ltd'],
  'Transport & Logistics': ['{n} Haulage Ltd', '{n} Logistics Ltd', '{n} Shipping Agency Ltd'],
  Technology: ['{n} Technologies Ltd', '{n} Systems Ltd', '{n} Digital Ltd'],
};

const STEMS = [
  'Caroni', 'Maracas', 'Chaguaramas', 'Nariva', 'Toco', 'Blanchisseuse', 'Icacos', 'Manzanilla',
  'Cascade', 'Woodbrook', 'Lopinot', 'Speyside', 'Charlotteville', 'Mayaro', 'Cedros', 'Valencia',
  'Brasso', 'Talparo', 'Guayaguayare', 'Moruga', 'Cumuto', 'Biche', 'Erin', 'Fyzabad',
  'Salybia', 'Matelot', 'Paramin', 'Santa Cruz', 'Aripo', 'Guanapo',
];

// ------------------------------------------------------------------ profiles

/**
 * Each profile describes a plausible client shape and — critically — which
 * lines it deliberately does NOT carry. The gaps are the whole point.
 */
const PROFILES = [
  { industry: 'Manufacturing', segment: 'corporate', headcount: [180, 420], revenue: [45e6, 160e6], has: ['property_all_risk', 'motor_fleet', 'group_health_local'], skip: ['business_interruption', 'machinery_breakdown', 'products_liability'] },
  { industry: 'Manufacturing', segment: 'commercial', headcount: [40, 120], revenue: [8e6, 30e6], has: ['property_all_risk', 'public_liability'], skip: ['group_health_local', 'employers_liability'] },
  { industry: 'Distribution', segment: 'corporate', headcount: [90, 260], revenue: [60e6, 220e6], has: ['property_all_risk', 'motor_fleet', 'group_health_local', 'group_life'], skip: ['marine_cargo', 'cyber_liability'] },
  { industry: 'Distribution', segment: 'commercial', headcount: [25, 80], revenue: [6e6, 24e6], has: ['property_all_risk', 'motor_fleet'], skip: ['marine_cargo', 'business_interruption', 'group_health_local'] },
  { industry: 'Retail', segment: 'corporate', headcount: [200, 650], revenue: [80e6, 300e6], has: ['property_all_risk', 'business_interruption', 'public_liability', 'group_health_local'], skip: ['cyber_liability', 'group_life', 'money_fidelity'] },
  { industry: 'Retail', segment: 'commercial', headcount: [15, 60], revenue: [3e6, 15e6], has: ['property_all_risk'], skip: ['public_liability', 'money_fidelity', 'business_interruption'] },
  { industry: 'Construction', segment: 'commercial', headcount: [50, 180], revenue: [20e6, 90e6], has: ['motor_fleet', 'employers_liability'], skip: ['contractors_all_risk', 'group_personal_accident', 'group_health_local'] },
  { industry: 'Energy', segment: 'corporate', headcount: [140, 400], revenue: [120e6, 500e6], has: ['property_all_risk', 'business_interruption', 'employers_liability', 'group_health_local', 'group_life', 'intl_health_usd'], skip: ['directors_officers', 'cyber_liability'] },
  { industry: 'Financial Services', segment: 'corporate', headcount: [70, 240], revenue: [40e6, 180e6], has: ['property_all_risk', 'money_fidelity', 'group_health_local', 'group_life'], skip: ['cyber_liability', 'directors_officers', 'professional_indemnity'] },
  { industry: 'Professional Services', segment: 'commercial', headcount: [12, 45], revenue: [4e6, 20e6], has: ['property_all_risk'], skip: ['professional_indemnity', 'cyber_liability', 'group_health_local'] },
  { industry: 'Hospitality', segment: 'corporate', headcount: [120, 380], revenue: [30e6, 120e6], has: ['property_all_risk', 'public_liability', 'group_health_local'], skip: ['business_interruption', 'group_personal_accident'] },
  { industry: 'Agriculture', segment: 'commercial', headcount: [30, 110], revenue: [5e6, 22e6], has: ['property_all_risk', 'motor_fleet'], skip: ['employers_liability', 'group_personal_accident', 'group_health_local'] },
  { industry: 'Healthcare', segment: 'commercial', headcount: [45, 160], revenue: [15e6, 70e6], has: ['property_all_risk', 'group_health_local', 'professional_indemnity'], skip: ['cyber_liability', 'group_life'] },
  { industry: 'Transport & Logistics', segment: 'commercial', headcount: [60, 200], revenue: [18e6, 85e6], has: ['motor_fleet', 'marine_cargo', 'employers_liability'], skip: ['property_all_risk', 'group_health_local', 'group_personal_accident'] },
  { industry: 'Technology', segment: 'commercial', headcount: [18, 70], revenue: [6e6, 35e6], has: ['group_health_local'], skip: ['cyber_liability', 'professional_indemnity', 'directors_officers'] },
];

// -------------------------------------------------------------------- build

/** @type {any[]} */ const clients = [];
/** @type {any[]} */ const policies = [];
/** @type {any[]} */ const members = [];
/** @type {any[]} */ const claims = [];

let policySeq = 1000;
let memberSeq = 1000;
let claimSeq = 10000;

const usedNames = new Set();
function companyName(industry) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = pick(COMPANY_SHAPES[industry]).replace('{n}', pick(STEMS));
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
  return `${pick(STEMS)} ${industry} Ltd ${usedNames.size}`;
}

function person() {
  return `${pick(FIRST)} ${pick(LAST)}`;
}

// -- commercial and corporate clients ----------------------------------------

const COMMERCIAL_COUNT = 26;
for (let i = 0; i < COMMERCIAL_COUNT; i++) {
  const profile = PROFILES[i % PROFILES.length];
  const id = `CL-${1000 + i}`;
  const headcount = intBetween(profile.headcount[0], profile.headcount[1]);
  const tenureYears = between(1.2, 14);
  const growth = between(1.0, 1.9);

  const primaryLocation = pick(TT_TOWNS);
  const locations = [primaryLocation];
  if (chance(0.35)) locations.push(pick(TT_TOWNS.filter((t) => t !== primaryLocation)));

  const client = {
    id,
    name: companyName(profile.industry),
    industry: profile.industry,
    segment: profile.segment,
    headcount,
    headcountAtInception: Math.max(4, Math.round(headcount / growth)),
    annualRevenueTTD: round(between(profile.revenue[0], profile.revenue[1]), 100000),
    relationshipStart: isoYearsAgo(tenureYears),
    locations,
    floodZone: locations.some((l) => FLOOD_PRONE.has(l)),
    accountExecutive: pick(AES),
    primaryContact: {
      name: person(),
      title: pick(['Chief Financial Officer', 'Human Resources Manager', 'Managing Director', 'Operations Director', 'Group Risk Manager']),
      email: `${pick(['finance', 'hr', 'admin', 'risk'])}@${slug(usedNamesLast())}.co.tt`,
      phone: `+1868-${intBetween(220, 799)}-${String(intBetween(1000, 9999))}`,
    },
  };
  clients.push(client);

  for (const line of profile.has) {
    policies.push(makePolicy(client, line, tenureYears));
  }

  // A minority of accounts carry a line the profile didn't call for; a book
  // where every client of a type looks identical teaches the model nothing.
  if (chance(0.25)) {
    const extra = pick(['money_fidelity', 'group_personal_accident', 'public_liability', 'marine_cargo']);
    if (!profile.has.includes(extra)) policies.push(makePolicy(client, extra, tenureYears));
  }
}

// -- personal lines clients ---------------------------------------------------

for (let i = 0; i < 6; i++) {
  const id = `CL-${2000 + i}`;
  const town = pick(TT_TOWNS);
  const client = {
    id,
    name: person(),
    industry: 'Household',
    segment: 'personal',
    headcount: 0,
    relationshipStart: isoYearsAgo(between(0.6, 11)),
    locations: [town],
    floodZone: FLOOD_PRONE.has(town),
    accountExecutive: pick(AES),
    primaryContact: { name: 'self', email: `client${i}@example.tt`, phone: `+1868-${intBetween(220, 799)}-${String(intBetween(1000, 9999))}` },
  };
  clients.push(client);

  policies.push(makePolicy(client, 'private_motor', between(1, 8)));
  // Deliberately leave most personal clients without homeowners: single-line
  // personal accounts are the highest-churn and easiest round-out in the book.
  if (chance(0.34)) policies.push(makePolicy(client, 'homeowners', between(1, 6)));
}

// -- benefits census and claims ----------------------------------------------

for (const client of clients) {
  const health = policies.find((p) => p.clientId === client.id && p.line === 'group_health_local');
  if (!health) continue;

  const employeeCount = Math.min(client.headcount, 40); // cap the census to keep the fixture small
  for (let e = 0; e < employeeCount; e++) {
    const empId = `MB-${memberSeq++}`;
    members.push({
      id: empId,
      clientId: client.id,
      role: chance(0.08) ? 'retiree' : 'employee',
      dob: isoShift(-Math.round(between(24, 63) * 365.25)),
      status: 'active',
    });

    if (chance(0.55)) {
      members.push({
        id: `MB-${memberSeq++}`,
        clientId: client.id,
        role: 'spouse',
        dob: isoShift(-Math.round(between(24, 61) * 365.25)),
        status: 'active',
        primaryMemberId: empId,
      });
    }
    const kids = chance(0.45) ? intBetween(1, 3) : 0;
    for (let k = 0; k < kids; k++) {
      // Weighted toward the 18-25 band so the ageing-out rule has real subjects.
      const age = chance(0.4) ? between(18, 25.4) : between(0, 18);
      members.push({
        id: `MB-${memberSeq++}`,
        clientId: client.id,
        role: 'child',
        dob: isoShift(-Math.round(age * 365.25)),
        status: 'active',
        primaryMemberId: empId,
        tertiaryEnrolled: age >= 21 ? chance(0.7) : undefined,
      });
    }
  }

  // Claims. Declined dental and vision claims are the signal the rules read.
  const clientMembers = members.filter((m) => m.clientId === client.id);
  const claimCount = intBetween(18, 60);
  const dentalPressure = chance(0.4);
  const overseasPressure = chance(0.3);

  for (let c = 0; c < claimCount; c++) {
    const member = pick(clientMembers);
    let category = pick(['outpatient', 'outpatient', 'outpatient', 'inpatient', 'maternity', 'emergency']);
    if (dentalPressure && chance(0.3)) category = 'dental';
    else if (chance(0.08)) category = 'vision';
    else if (overseasPressure && chance(0.18)) category = 'overseas_precert';

    const excluded = category === 'dental' || category === 'vision';
    const status = excluded ? 'declined' : chance(0.06) ? 'declined' : chance(0.08) ? 'open' : 'paid';

    claims.push({
      id: `CLM-${claimSeq++}`,
      clientId: client.id,
      policyId: health.id,
      memberId: member.id,
      date: isoShift(-intBetween(1, 700)),
      category,
      amount: round(
        category === 'inpatient' ? between(8000, 140000)
          : category === 'overseas_precert' ? between(30000, 400000)
          : category === 'dental' ? between(600, 6000)
          : category === 'vision' ? between(400, 2600)
          : between(300, 9000),
        50,
      ),
      currency: category === 'overseas_precert' ? 'USD' : 'TTD',
      status,
      declineReason: status !== 'declined' ? undefined
        : category === 'dental' ? 'Dental care, treatment or surgery is excluded under the plan'
        : category === 'vision' ? 'Routine eye examinations, eyeglasses and contact lenses are excluded'
        : pick(['Benefit maximum exhausted', 'Service obtained out of network', 'Pre-existing condition not disclosed', 'Pre-certification not obtained prior to treatment']),
    });
  }
}

// -- general-lines claims -----------------------------------------------------

for (const policy of policies) {
  if (!['property_all_risk', 'motor_fleet', 'marine_cargo', 'public_liability'].includes(policy.line)) continue;
  const n = policy.line === 'motor_fleet' ? intBetween(0, 9) : intBetween(0, 4);
  for (let i = 0; i < n; i++) {
    const category = policy.line === 'motor_fleet' ? 'motor'
      : policy.line === 'marine_cargo' ? 'marine'
      : policy.line === 'public_liability' ? 'liability'
      : 'property';
    claims.push({
      id: `CLM-${claimSeq++}`,
      clientId: policy.clientId,
      policyId: policy.id,
      date: isoShift(-intBetween(1, 900)),
      category,
      amount: round(between(4000, category === 'property' ? 480000 : 90000), 500),
      currency: 'TTD',
      status: chance(0.12) ? 'declined' : chance(0.1) ? 'open' : 'paid',
      declineReason: undefined,
    });
  }
}

// ------------------------------------------------------------ policy factory

function makePolicy(client, line, tenureYears) {
  const id = `POL-${policySeq++}`;
  const benefits = ['group_health_local', 'group_life', 'intl_health_usd', 'group_critical_illness', 'group_personal_accident'].includes(line);
  const carrier = pick(benefits ? CARRIERS.benefits : CARRIERS.general);
  const yearsOn = Math.min(tenureYears, between(0.8, tenureYears || 1));
  const lives = Math.max(1, Math.round((client.headcount || 1) * 1.8));

  /** @type {any} */
  const policy = {
    id,
    clientId: client.id,
    line,
    carrier,
    inceptionDate: isoYearsAgo(yearsOn),
    // Spread renewals across the year, with a deliberate cluster inside the
    // next 90 days so the timing rules have something to fire on.
    renewalDate: isoShift(chance(0.3) ? intBetween(5, 90) : intBetween(91, 360)),
    currency: 'TTD',
    extensions: [],
    status: 'active',
  };

  switch (line) {
    case 'property_all_risk': {
      const sum = round(between(2e6, 90e6), 100000);
      policy.sumInsured = sum;
      // Most sums insured were last touched years ago — that is the finding.
      policy.sumInsuredSetAt = isoYearsAgo(chance(0.55) ? between(3, 9) : between(0.2, 2));
      policy.annualPremium = round(sum * between(0.0028, 0.0045), 500);
      policy.deductible = round(sum * 0.01, 1000);
      if (chance(0.45)) policy.extensions.push('flood');
      if (chance(0.5)) policy.extensions.push('earthquake');
      if (chance(0.4)) policy.extensions.push('windstorm');
      break;
    }
    case 'business_interruption': {
      const sum = round(between(1e6, 40e6), 100000);
      policy.sumInsured = sum;
      policy.indemnityPeriodMonths = pick([6, 12, 12, 18, 24]);
      policy.annualPremium = round(sum * between(0.0035, 0.005), 500);
      break;
    }
    case 'motor_fleet': {
      const declared = intBetween(4, 70);
      policy.vehicles = declared;
      policy.annualPremium = round(declared * between(3400, 5200), 500);
      policy.deductible = 5000;
      break;
    }
    case 'marine_cargo': {
      const sum = round(between(1.5e6, 45e6), 100000);
      policy.sumInsured = sum;
      policy.annualPremium = round(sum * between(0.0035, 0.0055), 500);
      break;
    }
    case 'group_health_local': {
      policy.lives = lives;
      policy.annualPremium = round(lives * between(5200, 7400), 500);
      // Administration sits with the carrier or the client on most accounts —
      // every one of those is a Cardea TPA conversation.
      policy.administrator = chance(0.35) ? 'Cardea' : chance(0.5) ? 'carrier' : 'self';
      if (policy.administrator === 'Cardea' && chance(0.6)) policy.extensions.push('overseas_network');
      break;
    }
    case 'intl_health_usd': {
      const covered = Math.max(3, Math.round(client.headcount * 0.06));
      policy.lives = covered;
      policy.currency = 'USD';
      policy.annualPremium = round(covered * between(1100, 1500), 100);
      policy.sumInsured = 2000000;
      policy.deductible = 20000;
      policy.administrator = 'Cardea';
      policy.extensions.push('overseas_network');
      break;
    }
    case 'group_life': {
      policy.lives = Math.round(client.headcount);
      policy.annualPremium = round(policy.lives * between(1100, 1700), 500);
      break;
    }
    case 'group_personal_accident': {
      policy.lives = Math.round(client.headcount);
      policy.annualPremium = round(policy.lives * between(260, 400), 500);
      break;
    }
    case 'private_motor': {
      policy.vehicles = 1;
      policy.sumInsured = round(between(60000, 340000), 5000);
      policy.annualPremium = round(policy.sumInsured * between(0.03, 0.05), 100);
      break;
    }
    case 'homeowners': {
      policy.sumInsured = round(between(600000, 3200000), 25000);
      policy.sumInsuredSetAt = isoYearsAgo(between(1, 8));
      policy.annualPremium = round(policy.sumInsured * between(0.0028, 0.004), 100);
      if (chance(0.5)) policy.extensions.push('earthquake');
      if (chance(0.35)) policy.extensions.push('flood');
      break;
    }
    default: {
      const revenue = client.annualRevenueTTD ?? 5e6;
      policy.annualPremium = round(Math.max(6000, revenue * between(0.0008, 0.0016)), 500);
      if (['public_liability', 'employers_liability', 'products_liability', 'professional_indemnity', 'directors_officers', 'cyber_liability'].includes(line)) {
        policy.sumInsured = pick([1e6, 2e6, 5e6, 10e6]);
      }
      break;
    }
  }

  return policy;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 18) || 'client';
}
function usedNamesLast() {
  return [...usedNames].at(-1) ?? 'client';
}

// -------------------------------------------------------------------- write

const book = {
  meta: {
    generatedAt: TODAY.toISOString(),
    seed,
    synthetic: true,
    note: 'Synthetic data for development and demonstration. Contains no real client information.',
  },
  clients,
  policies,
  members,
  claims,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(book, null, 2));

console.log(
  `Wrote ${outPath}\n` +
    `  seed      ${seed}\n` +
    `  clients   ${clients.length}\n` +
    `  policies  ${policies.length}\n` +
    `  members   ${members.length}\n` +
    `  claims    ${claims.length}`,
);
