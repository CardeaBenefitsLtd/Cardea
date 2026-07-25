#!/usr/bin/env node
/**
 * The broker console.
 *
 * Node's own http module, no framework. This runs inside AIB's network against
 * a live book of business, and every dependency added here is a dependency
 * somebody has to keep patched.
 *
 * Read endpoints return JSON. The two agent endpoints stream server-sent
 * events instead, because an analyst run takes tens of seconds and a spinner
 * with nothing behind it is how people learn not to trust a tool.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBook, indexBook, buildBenchmarks, searchClients, claimsSummary } from './data/book.js';
import { findOpportunities } from './engine/rules.js';
import { rankOpportunities, summarise } from './engine/score.js';
import { CATALOGUE } from './engine/catalogue.js';
import { runTool } from './agent/tools.js';
import { createAnalyst } from './agent/analyst.js';
import { TPA_NAME, TPA_RELATIONSHIP, GROUP_NAME, relationshipNotice } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(here, '..', 'web');
const PORT = Number(process.env.PORT ?? 4000);

// Loaded once at boot. A live deployment should watch the source and reload;
// for now, restarting the process is the refresh.
const book = loadBook();
const ix = indexBook(book);
const benchmarks = buildBenchmarks(ix);
const now = new Date();

const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(url, req, res);
    return await serveStatic(url, res);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

// -------------------------------------------------------------------- routes

async function api(url, req, res) {
  const route = url.pathname.replace(/^\/api\//, '');
  const q = Object.fromEntries(url.searchParams);

  switch (true) {
    case route === 'summary': {
      return json(res, 200, {
        ...JSON.parse(runTool('get_book_summary', {}, { ix, benchmarks, now }).content),
        analystAvailable: hasCredentials,
        tpa: { name: TPA_NAME, relationship: TPA_RELATIONSHIP, group: GROUP_NAME, notice: relationshipNotice() },
        validation: book.validation,
      });
    }

    case route === 'clients': {
      return json(res, 200, searchClients(ix, {
        query: q.query,
        industry: q.industry,
        segment: q.segment,
        hasLine: q.hasLine,
        missingLine: q.missingLine,
        renewalWithinDays: q.renewalWithinDays ? Number(q.renewalWithinDays) : undefined,
        limit: Number(q.limit ?? 200),
      }));
    }

    case route.startsWith('client/'): {
      const clientId = decodeURIComponent(route.slice('client/'.length));
      const result = runTool('get_client', { clientId }, { ix, benchmarks, now });
      if (result.isError) return json(res, 404, { error: result.content });
      const payload = JSON.parse(result.content);
      payload.claims = claimsSummary(ix, clientId);
      payload.opportunities = rankOpportunities(
        findOpportunities(ix, { now, benchmarks, clientIds: [clientId] }),
      );
      return json(res, 200, payload);
    }

    case route === 'opportunities': {
      let ranked = rankOpportunities(findOpportunities(ix, { now, benchmarks }));
      if (q.family) ranked = ranked.filter((o) => o.family === q.family);
      if (q.kind) ranked = ranked.filter((o) => o.kind === q.kind);
      if (q.tpaOnly === 'true') ranked = ranked.filter((o) => o.tpa);
      if (q.renewalWithinDays) {
        const days = Number(q.renewalWithinDays);
        ranked = ranked.filter((o) => o.urgencyDays >= 0 && o.urgencyDays <= days);
      }
      const limit = Number(q.limit ?? 100);
      return json(res, 200, { summary: summarise(ranked), total: ranked.length, opportunities: ranked.slice(0, limit) });
    }

    case route === 'catalogue': {
      return json(res, 200, { products: Object.values(CATALOGUE) });
    }

    case route === 'brief/stream':
      return streamAgent(res, (analyst) => analyst.briefClient(q.clientId));

    case route === 'sweep/stream':
      return streamAgent(res, (analyst) => analyst.sweepBook({ limit: Number(q.limit ?? 8) }));

    case route === 'ask/stream':
      return streamAgent(res, (analyst) => analyst.ask(q.question ?? ''));

    default:
      return json(res, 404, { error: `No route /api/${route}` });
  }
}

/**
 * Run an analyst call, pushing progress to the browser as it goes.
 * @param {import('node:http').ServerResponse} res
 * @param {(analyst: ReturnType<typeof createAnalyst>) => Promise<any>} run
 */
async function streamAgent(res, run) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  if (!hasCredentials) {
    send('error', { message: 'ANTHROPIC_API_KEY is not set on the server. The rules engine works without it; the analyst does not.' });
    return res.end();
  }

  // Keeps intermediaries from closing an idle connection during a long turn.
  const heartbeat = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000);

  try {
    const analyst = createAnalyst({ ix, benchmarks, now, onEvent: (event) => send(event.type, event) });
    send('phase', { phase: 'starting' });
    const result = await run(analyst);
    send('result', result);
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

// -------------------------------------------------------------------- static

async function serveStatic(url, res) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;

  // The AIB logo lives at the repository root alongside the existing site.
  if (requested === '/logo.jpg') {
    try {
      const logo = await readFile(join(here, '..', '..', 'Cardea Benefits Logo.jpg'));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' });
      return res.end(logo);
    } catch {
      res.writeHead(404).end();
      return;
    }
  }

  // Contain path traversal: resolve, then confirm the result is still under the
  // web root before reading anything.
  const target = join(WEB_ROOT, requested);
  if (!target.startsWith(WEB_ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ---------------------------------------------------------------------- boot

server.listen(PORT, () => {
  const pipeline = summarise(rankOpportunities(findOpportunities(ix, { now, benchmarks })));
  console.log(`\n  AIB broker console  http://localhost:${PORT}`);
  console.log(`  ${book.clients.length} clients · ${book.policies.length} policies · ${pipeline.opportunities} opportunities`);
  console.log(`  analyst ${hasCredentials ? 'ready' : 'unavailable (no ANTHROPIC_API_KEY — rules engine still works)'}`);
  console.log(`  ${relationshipNotice()}\n`);
});
