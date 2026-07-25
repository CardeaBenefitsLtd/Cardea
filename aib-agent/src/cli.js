#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * `opportunities` runs the rules engine only and needs no API key — that is
 * deliberate, so the deterministic half can be reviewed, argued with and
 * corrected by the broking team before anyone spends a token on it.
 */

import { loadBook, indexBook, buildBenchmarks } from './data/book.js';
import { findOpportunities } from './engine/rules.js';
import { rankOpportunities, summarise } from './engine/score.js';
import { CATALOGUE } from './engine/catalogue.js';
import { TPA_NAME, relationshipNotice } from './config.js';
import { createAnalyst } from './agent/analyst.js';

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s) => (COLOUR ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (COLOUR ? `\x1b[1m${s}\x1b[0m` : s),
  blue: (s) => (COLOUR ? `\x1b[38;2;9;43;144m${s}\x1b[0m` : s),
  red: (s) => (COLOUR ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (COLOUR ? `\x1b[32m${s}\x1b[0m` : s),
  amber: (s) => (COLOUR ? `\x1b[33m${s}\x1b[0m` : s),
};

const USAGE = `
${c.bold('AIB brokerage analyst')}

  ${c.bold('npm run opportunities')} [-- --client CL-1004] [--family benefits] [--limit 20] [--json]
      Run the gap-analysis rules and print ranked opportunities. No API key needed.

  ${c.bold('npm run brief')} -- --client CL-1004 [--json]
      Full analyst brief on one client: what to raise, in what order, with what evidence.

  ${c.bold('npm run sweep')} [-- --limit 8] [--json]
      Portfolio triage: where to spend the next fortnight across the book.

  ${c.bold('npm run ask')} -- "which clients are most exposed to flooding?"
      Ask a question against the book in plain language.

  ${c.bold('npm run serve')}
      Broker console at http://localhost:4000

Options
  --client ID     restrict to one client
  --family F      general | benefits | personal | service
  --kind K        gap | adequacy | lifecycle | signal | portfolio
  --limit N       how many to show
  --min-score N   0..1, filter low-ranked items
  --json          machine-readable output
`;

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const command = argv[0];
const flags = parseFlags(argv.slice(1));

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
      const next = args[i + 1];
      if (next == null || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(arg);
  }
  return out;
}

// ------------------------------------------------------------------ helpers

const ttd = (n) => `TT$${Math.round(n ?? 0).toLocaleString('en-US')}`;

function strengthColour(strength) {
  return strength === 'strong' ? c.green(strength) : strength === 'moderate' ? c.amber(strength) : c.dim(strength);
}

function loadEverything() {
  const book = loadBook();
  const ix = indexBook(book);
  const benchmarks = buildBenchmarks(ix);
  if (book.validation?.warnings?.length) {
    console.error(c.dim(`  ${book.validation.warnings.length} data warning(s); run with --json to inspect.`));
  }
  return { book, ix, benchmarks, now: new Date() };
}

/** Progress reporting for the agent commands, so a long run does not look hung. */
function reporter() {
  return (event) => {
    if (flags.json) return;
    if (event.type === 'phase') {
      process.stderr.write(c.dim(`  ${event.phase === 'explore' ? 'reading the book' : 'writing it up'}...\n`));
    } else if (event.type === 'tool') {
      const detail = event.input?.clientId ?? event.input?.query ?? event.input?.industry ?? '';
      process.stderr.write(c.dim(`    · ${event.name}${detail ? ` ${detail}` : ''}\n`));
    } else if (event.type === 'notice') {
      process.stderr.write(c.amber(`  ! ${event.message}\n`));
    }
  };
}

function requireApiKey() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error(c.red('ANTHROPIC_API_KEY is not set.'));
    console.error(c.dim('Copy .env.example to .env and add a key, or run `npm run opportunities` which needs no key.'));
    process.exit(1);
  }
}

// ----------------------------------------------------------------- commands

async function cmdOpportunities() {
  const { ix, benchmarks, now } = loadEverything();
  let ranked = rankOpportunities(
    findOpportunities(ix, { now, benchmarks, clientIds: flags.client ? [flags.client] : undefined }),
  );

  if (flags.family) ranked = ranked.filter((o) => o.family === flags.family);
  if (flags.kind) ranked = ranked.filter((o) => o.kind === flags.kind);
  if (flags.minScore) ranked = ranked.filter((o) => o.score >= Number(flags.minScore));

  const limit = Number(flags.limit ?? 20);
  const shown = ranked.slice(0, limit);

  if (flags.json) {
    console.log(JSON.stringify({ summary: summarise(ranked), opportunities: shown }, null, 2));
    return;
  }

  const s = summarise(ranked);
  console.log('');
  console.log(c.blue(c.bold('  Opportunities')) + c.dim(`  ${s.opportunities} across ${s.clientsWithOpportunities} clients`));
  console.log(c.dim(`  indicative premium ${ttd(s.estPremiumTTD)} · revenue to AIB ${ttd(s.estRevenueTTD)} · ${s.withinNinetyDays} inside 90 days`));
  console.log(c.dim(`  ${relationshipNotice()}`));
  console.log('');

  for (const opp of shown) {
    const urgency = opp.urgencyDays <= 90 ? c.amber(`${opp.urgencyDays}d to renewal`) : c.dim(`${opp.urgencyDays}d to renewal`);
    console.log(
      `  ${c.bold(String(opp.rank).padStart(3))}. ${c.bold(opp.clientName)} ${c.dim(`(${opp.clientId})`)}` +
        `${opp.tpa ? c.blue(`  ‹${TPA_NAME}›`) : ''}`,
    );
    console.log(`       ${CATALOGUE[opp.line]?.name ?? opp.line} ${c.dim('·')} ${opp.headline}`);
    console.log(
      `       ${c.dim('score')} ${opp.score.toFixed(2)}  ${c.dim('premium')} ${ttd(opp.estPremiumTTD)}  ` +
        `${c.dim('revenue')} ${ttd(opp.estRevenueTTD)}  ${urgency}`,
    );
    console.log('');
  }

  if (ranked.length > shown.length) {
    console.log(c.dim(`  ...and ${ranked.length - shown.length} more. Use --limit to see them.\n`));
  }
}

async function cmdBrief() {
  if (!flags.client) { console.error(c.red('brief needs --client CL-XXXX')); process.exit(1); }
  requireApiKey();

  const { ix, benchmarks, now } = loadEverything();
  const analyst = createAnalyst({ ix, benchmarks, now, onEvent: reporter() });
  const brief = await analyst.briefClient(flags.client);

  if (flags.json) { console.log(JSON.stringify(brief, null, 2)); return; }

  console.log('');
  console.log(c.blue(c.bold(`  ${brief.clientName}`)) + c.dim(`  ${brief.clientId}`));
  console.log(`  ${c.bold(brief.headline)}`);
  console.log('');
  console.log(wrap(brief.situation, 4));
  console.log('');

  for (const rec of brief.recommendations) {
    console.log(`  ${c.bold(`${rec.rank}. ${rec.title}`)}`);
    console.log(
      `     ${c.dim(CATALOGUE[rec.line]?.name ?? rec.line)} ${c.dim('·')} evidence ${strengthColour(rec.evidenceStrength)} ` +
        `${c.dim('·')} ${ttd(rec.estPremiumTTD)} indicative`,
    );
    console.log(wrap(rec.rationale, 5));
    console.log(`     ${c.dim('Why now:')} ${rec.whyNow}`);
    console.log(`     ${c.dim('Evidence:')} ${rec.evidenceRefs.join(', ') || c.red('none cited')}`);
    console.log(`     ${c.dim('Talk track:')}`);
    console.log(wrap(rec.talkTrack, 7));
    if (rec.toConfirm?.length) {
      console.log(`     ${c.dim('Confirm first:')} ${rec.toConfirm.join('; ')}`);
    }
    console.log(`     ${c.dim('Likely objection:')} ${rec.likelyObjection}`);
    console.log(wrap(rec.objectionResponse, 7));
    console.log('');
  }

  if (brief.setAside?.length) {
    console.log(c.dim('  Set aside'));
    for (const item of brief.setAside) {
      console.log(c.dim(`    · ${CATALOGUE[item.line]?.name ?? item.line} — ${item.reason}`));
    }
    console.log('');
  }

  if (brief.openQuestions?.length) {
    console.log(c.dim('  Open questions'));
    for (const q of brief.openQuestions) console.log(c.dim(`    · ${q}`));
    console.log('');
  }

  console.log(c.dim(`  ${brief.disclaimer}`));
  console.log('');
}

async function cmdSweep() {
  requireApiKey();
  const { ix, benchmarks, now } = loadEverything();
  const analyst = createAnalyst({ ix, benchmarks, now, onEvent: reporter() });
  const sweep = await analyst.sweepBook({ limit: Number(flags.limit ?? 8) });

  if (flags.json) { console.log(JSON.stringify(sweep, null, 2)); return; }

  console.log('');
  console.log(c.blue(c.bold('  Book sweep')));
  console.log(`  ${c.bold(sweep.headline)}`);
  console.log('');

  for (const rec of sweep.recommendations) {
    console.log(`  ${c.bold(`${rec.rank}. ${rec.clientName}`)} ${c.dim(`(${rec.clientId})`)}`);
    console.log(`     ${rec.title}`);
    console.log(
      `     ${c.dim(CATALOGUE[rec.line]?.name ?? rec.line)} ${c.dim('·')} evidence ${strengthColour(rec.evidenceStrength)} ` +
        `${c.dim('·')} ${ttd(rec.estPremiumTTD)} indicative`,
    );
    console.log(wrap(rec.rationale, 5));
    console.log(`     ${c.dim('Why now:')} ${rec.whyNow}`);
    console.log(`     ${c.dim('Next step:')} ${rec.nextStep}`);
    console.log(`     ${c.dim('Evidence:')} ${rec.evidenceRefs.join(', ') || c.red('none cited')}`);
    console.log('');
  }

  if (sweep.patterns?.length) {
    console.log(c.blue(c.bold('  Patterns worth running as a campaign')));
    for (const p of sweep.patterns) {
      console.log(`    ${c.bold(p.pattern)}`);
      console.log(wrap(p.suggestedApproach, 6));
      console.log(c.dim(`      ${p.affectedClientIds.length} clients: ${p.affectedClientIds.slice(0, 8).join(', ')}`));
      console.log('');
    }
  }

  if (sweep.caveats?.length) {
    console.log(c.dim('  Caveats'));
    for (const q of sweep.caveats) console.log(c.dim(`    · ${q}`));
    console.log('');
  }

  console.log(c.dim(`  ${sweep.disclaimer}`));
  console.log('');
}

async function cmdAsk() {
  const question = flags._.join(' ').trim();
  if (!question) { console.error(c.red('ask needs a question in quotes')); process.exit(1); }
  requireApiKey();

  const { ix, benchmarks, now } = loadEverything();
  const analyst = createAnalyst({ ix, benchmarks, now, onEvent: reporter() });
  const result = await analyst.ask(question);

  if (flags.json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log('');
  console.log(wrap(result.answer, 2));
  console.log('');
}

/** Soft-wrap prose to the terminal width at a given indent. */
function wrap(text, indent) {
  const width = Math.min(process.stdout.columns || 100, 100) - indent;
  const pad = ' '.repeat(indent);
  return String(text ?? '')
    .split('\n')
    .flatMap((paragraph) => {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (!words.length) return [''];
      const lines = [];
      let line = '';
      for (const word of words) {
        if (line.length + word.length + 1 > width) { lines.push(line); line = word; }
        else line = line ? `${line} ${word}` : word;
      }
      if (line) lines.push(line);
      return lines;
    })
    .map((l) => pad + l)
    .join('\n');
}

// -------------------------------------------------------------------- main

const COMMANDS = {
  opportunities: cmdOpportunities,
  brief: cmdBrief,
  sweep: cmdSweep,
  ask: cmdAsk,
};

const run = COMMANDS[command];
if (!run) {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}

run().catch((err) => {
  console.error(c.red(`\n  ${err.message}\n`));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
