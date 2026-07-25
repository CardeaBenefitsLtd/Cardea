#!/usr/bin/env node
/**
 * Describe an export without revealing what is in it.
 *
 * The problem this solves: to write an adapter for AIB's real book, the shape
 * of the export is needed — column names, types, date formats, how much is
 * populated, how the identifiers are built. The contents are not needed, and
 * for a file holding member records and medical claims the contents should not
 * leave the machine at all.
 *
 * So this reads the file locally and emits structure only. Values are reduced
 * to format fingerprints: "CL-1004" becomes "AA-9999", "roshni@example.tt"
 * becomes "<email>", "2026-07-25" becomes "YYYY-MM-DD". Nothing that comes out
 * of here identifies a client, a member or a claim.
 *
 *   node scripts/profile-export.js policies.csv
 *   node scripts/profile-export.js ./export/          # every csv/json in a directory
 *   node scripts/profile-export.js book.json --out profile.json
 *
 * Read the output before sending it anywhere. It is designed to be safe to
 * share, but you own that judgement, not this script.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCsv } from '../src/data/book.js';

/** True only when run as a script, so the profiler can be imported and tested. */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const outPath = flag('--out');
/** Opt in to showing the actual values of low-cardinality columns (status, currency, line). */
const revealEnums = args.includes('--reveal-enums');
/** How many distinct values still counts as an enum. */
const ENUM_MAX = Number(flag('--enum-max') ?? 25);

function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

if (isMain && !target) {
  console.error(`
Describe a data export without revealing its contents.

  node scripts/profile-export.js <file-or-directory> [options]

  --out <path>       write the profile as JSON as well as printing it
  --reveal-enums     include actual values for columns with few distinct values
                     (status, currency, line — review before using)
  --enum-max <n>     what counts as "few". Default 25.

Reads .csv and .json. For Excel, save each sheet as CSV first.
`);
  process.exit(1);
}

// --------------------------------------------------------------- fingerprints

/**
 * Reduce a value to its shape. This is the whole safety property: what comes
 * back describes the format and nothing else.
 * @param {unknown} value
 */
function fingerprint(value) {
  if (value === null || value === undefined || value === '') return '<empty>';
  if (typeof value === 'boolean') return '<boolean>';
  if (typeof value === 'number') return numberShape(value);
  if (Array.isArray(value)) return `<array[${value.length}]>`;
  if (typeof value === 'object') return `<object{${Object.keys(value).length}}>`;

  const s = String(value).trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return '<email>';

  const date = dateShape(s);
  if (date) return date;

  // Plain numerics before phones: a sum insured of 24500000 is seven-plus
  // digits and would otherwise be read as a phone number, which both mislabels
  // the column and falsely flags it as personal data.
  if (/^-?[\d,]+\.?\d*$/.test(s)) return numberShape(Number(s.replace(/,/g, '')));

  // A phone needs punctuation or a country code; bare digit runs were caught above.
  if (/^\+?[\d\s()-]{7,20}$/.test(s) && /[\s()+-]/.test(s) && (s.match(/\d/g) ?? []).length <= 15) {
    return '<phone>';
  }

  // Structural signature: letters to A, digits to 9, everything else kept.
  const shape = s.replace(/[A-Za-z]/g, 'A').replace(/\d/g, '9');
  return shape.length > 40 ? `<text len~${roundTo(s.length, 10)}>` : shape;
}

function dateShape(s) {
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return 'YYYY-MM-DDThh:mm:ss';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'YYYY-MM-DD';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return 'DD/MM/YYYY or MM/DD/YYYY (ambiguous)';
  if (/^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test(s)) return 'D-Mon-YYYY';
  // An 8-digit run is far more often a monetary amount than a compact date in
  // an insurance export, so only call it a date if it plausibly is one.
  if (/^\d{8}$/.test(s)) {
    const asYmd = { y: +s.slice(0, 4), m: +s.slice(4, 6), d: +s.slice(6, 8) };
    const asDmy = { d: +s.slice(0, 2), m: +s.slice(2, 4), y: +s.slice(4, 8) };
    const plausible = (p) => p.y >= 1900 && p.y <= 2100 && p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= 31;
    if (plausible(asYmd) && plausible(asDmy)) return 'YYYYMMDD or DDMMYYYY (ambiguous)';
    if (plausible(asYmd)) return 'YYYYMMDD';
    if (plausible(asDmy)) return 'DDMMYYYY';
    return null;
  }
  return null;
}

function numberShape(n) {
  if (!Number.isFinite(n)) return '<number>';
  if (Number.isInteger(n)) return `<integer ~1e${Math.max(0, String(Math.abs(n)).length - 1)}>`;
  return `<decimal ~1e${Math.max(0, String(Math.trunc(Math.abs(n))).length - 1)}>`;
}

const roundTo = (n, to) => Math.round(n / to) * to;

/**
 * Columns that usually carry personal data, so you know what you hold.
 *
 * "Name" on its own is too blunt: a broking export is full of "Policy Type
 * Name", "Department Name" and "Profit Centre Name", none of which identify
 * anybody, and flagging them suppresses exactly the taxonomy columns that make
 * a mapping obvious. So a name qualifies only when the qualifier is a person —
 * or when the column is bare "Name", which nearly always is one.
 */
const PERSON_NAME = /^name$|(first|last|middle|full|given|sur|member|patient|insured|client|contact|employee|dependa?nt|account)[\s_-]*name/i;
const OTHER_PII = /email|phone|mobile|telephone|address|\bdob\b|birth|nric|passport|national[\s_-]*id|diagnosis|\bicd\b|treatment/i;

/** @param {string} column */
function looksPersonalColumn(column) {
  return PERSON_NAME.test(column) || OTHER_PII.test(column);
}

// ------------------------------------------------------------------- profiling

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} label
 */
function profileRows(rows, label) {
  if (!rows.length) return { name: label, rows: 0, columns: [] };

  // Union of keys, because sparse JSON records do not all carry every field.
  const columns = new Map();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.has(key)) columns.set(key, { shapes: new Map(), filled: 0, distinct: new Set(), samples: [] });
    }
  }

  for (const row of rows) {
    for (const [key, stat] of columns) {
      const value = row[key];
      const empty = value === null || value === undefined || value === '';
      if (!empty) {
        stat.filled++;
        // Cap the distinct set: a million unique ids should not be held in memory.
        if (stat.distinct.size <= ENUM_MAX + 1) stat.distinct.add(String(value));
      }
      const shape = fingerprint(value);
      stat.shapes.set(shape, (stat.shapes.get(shape) ?? 0) + 1);
    }
  }

  return {
    name: label,
    rows: rows.length,
    columns: [...columns].map(([name, stat]) => {
      const shapes = [...stat.shapes].sort((a, b) => b[1] - a[1]);
      const isEnum = stat.distinct.size <= ENUM_MAX && stat.filled > 0;
      const looksPersonal = looksPersonalColumn(name) || shapes.some(([s]) => s === '<email>' || s === '<phone>');
      return {
        column: name,
        fillRate: Number((stat.filled / rows.length).toFixed(3)),
        distinctValues: stat.distinct.size > ENUM_MAX ? `>${ENUM_MAX}` : stat.distinct.size,
        formats: shapes.slice(0, 4).map(([shape, count]) => ({ shape, share: Number((count / rows.length).toFixed(3)) })),
        looksPersonal,
        // --reveal-enums never applies to a column that looks personal. A
        // low-cardinality column of member names is still member names, and the
        // flag exists to expose codes like "ACTIVE" or "TTD", not people.
        ...(revealEnums && isEnum && !looksPersonal ? { values: [...stat.distinct].sort() } : {}),
      };
    }),
  };
}

// ------------------------------------------------------------------- reading

function readTable(path) {
  const ext = extname(path).toLowerCase();
  const raw = readFileSync(path, 'utf8');
  if (ext === '.csv' || ext === '.tsv') return { [basename(path, ext)]: parseCsv(raw) };
  if (ext === '.json') {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { [basename(path, ext)]: parsed };
    // A book-shaped object: profile each array property separately.
    const tables = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value) && value.length && typeof value[0] === 'object') tables[key] = value;
    }
    return Object.keys(tables).length ? tables : { [basename(path, ext)]: [parsed] };
  }
  throw new Error(`Cannot read ${ext || 'that file'} — save it as CSV or JSON first`);
}

if (!isMain) {
  // Imported for testing: expose the pieces, run nothing.
} else {
const path = resolve(target);
const files = statSync(path).isDirectory()
  ? readdirSync(path).filter((f) => /\.(csv|tsv|json)$/i.test(f)).map((f) => join(path, f))
  : [path];

if (!files.length) {
  console.error(`No .csv or .json files found in ${path}`);
  process.exit(1);
}

const profiles = [];
for (const file of files) {
  try {
    for (const [label, rows] of Object.entries(readTable(file))) {
      profiles.push(profileRows(rows, label));
    }
  } catch (err) {
    profiles.push({ name: basename(file), error: err.message });
  }
}

// ---------------------------------------------------- mapping to the schema

/** Fields the engine reads, and what it does without them. */
const WANTED = {
  'clients.id': 'required — the key everything joins on',
  'clients.name': 'display only',
  'clients.industry': 'drives the industry-specific liability rules and peer cohorts',
  'clients.segment': 'commercial / corporate / personal',
  'clients.headcount': 'drives benefits sizing and the employers liability rule',
  'clients.annualRevenueTTD': 'drives every liability and cyber estimate',
  'clients.locations': 'drives the flood rule',
  'policies.id': 'required',
  'policies.clientId': 'required — the join key',
  'policies.line': 'required — must map onto the catalogue keys',
  'policies.renewalDate': 'drives every timing and urgency decision',
  'policies.annualPremium': 'drives book value and all sizing',
  'policies.sumInsured': 'drives the property and adequacy rules',
  'policies.sumInsuredSetAt': 'the under-insurance rule needs this and nothing substitutes for it',
  'policies.extensions': 'drives the flood and catastrophe gaps',
  'policies.administrator': 'drives the administration rules',
  'policies.indemnityPeriodMonths': 'drives the business interruption adequacy rule',
  'claims.status': 'required for every claims signal',
  'claims.declineReason': 'the strongest cross-sell signal there is',
  'claims.category': 'groups the claims signals',
  'members.dob': 'drives the dependants-ageing-out rule',
  'members.tertiaryEnrolled': 'distinguishes the age 21 ceiling from 25',
};

// ---------------------------------------------------------------- output

const report = {
  generatedAt: new Date().toISOString(),
  note: 'Structure only. Values are reduced to format fingerprints; no record contents are included.',
  files: files.map((f) => basename(f)),
  tables: profiles,
  engineExpects: WANTED,
};

if (outPath) {
  writeFileSync(resolve(outPath), JSON.stringify(report, null, 2));
  console.log(`Wrote ${outPath}\n`);
}

for (const table of profiles) {
  if (table.error) {
    console.log(`\n${table.name}  —  could not read: ${table.error}`);
    continue;
  }
  console.log(`\n${table.name}  ${table.rows.toLocaleString('en-US')} rows, ${table.columns.length} columns\n`);
  const width = Math.max(...table.columns.map((c) => c.column.length), 6);
  console.log(`  ${'column'.padEnd(width)}  fill   distinct  format`);
  console.log(`  ${'-'.repeat(width)}  -----  --------  ------`);
  for (const col of table.columns) {
    // fillRate already reports emptiness; the format column is more useful
    // showing what the populated values actually look like.
    const top = col.formats.find((f) => f.shape !== '<empty>') ?? col.formats[0];
    console.log(
      `  ${col.column.padEnd(width)}  ${String(Math.round(col.fillRate * 100)).padStart(3)}%  ` +
        `${String(col.distinctValues).padStart(8)}  ${top ? top.shape : ''}` +
        `${col.formats.filter((f) => f.shape !== '<empty>').length > 1 ? ` (+${col.formats.filter((f) => f.shape !== '<empty>').length - 1} other)` : ''}` +
        `${col.looksPersonal ? '  ‹personal data›' : ''}`,
    );
    if (col.values) console.log(`  ${' '.repeat(width)}            values: ${col.values.join(', ')}`);
  }
}

console.log(`
Structure only — no record contents above. Read it before sharing it.
Add --reveal-enums to include the values of low-cardinality columns
(status, currency, line), which is usually what makes the mapping obvious.
Columns marked <personal data> are never revealed, flag or no flag.
`);
}

export { fingerprint, profileRows, looksPersonalColumn };
