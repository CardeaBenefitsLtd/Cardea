/**
 * Tests for the agentic loop, using a stubbed Anthropic client.
 *
 * These do not test whether Claude gives good advice — that is a human
 * judgement. They test the wiring around it: that tool calls are executed and
 * fed back correctly, that all results go back in one message, that the loop
 * terminates, that a refusal surfaces as a clear error rather than an empty
 * result, and that the structured pass is actually parsed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadBook, indexBook, buildBenchmarks } from '../src/data/book.js';
import { createAnalyst } from '../src/agent/analyst.js';

const NOW = new Date('2026-07-25T00:00:00Z');

const book = await loadBook({ source: 'sample' });
const ix = indexBook(book);
const benchmarks = buildBenchmarks(ix);
const clientId = book.clients[0].id;

/**
 * Stands in for the SDK. Returns queued responses in order and records every
 * request, so the test can assert on what was actually sent.
 */
function stubClient(responses) {
  const requests = [];
  const next = () => {
    const response = responses.shift();
    if (!response) throw new Error('stub ran out of queued responses');
    return response;
  };
  const surface = {
    messages: {
      stream(request) {
        // Snapshot: the loop reuses one messages array across turns, so
        // recording it by reference would capture only the final state.
        requests.push(structuredClone(request));
        const response = next();
        return { finalMessage: async () => response };
      },
    },
  };
  return { client: { ...surface, beta: surface }, requests };
}

const text = (t) => ({ type: 'text', text: t });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const reply = (content, stop_reason = 'end_turn') => ({ content, stop_reason, stop_details: null });

function analystWith(responses, onEvent = () => {}) {
  const { client, requests } = stubClient(responses);
  return { analyst: createAnalyst({ ix, benchmarks, now: NOW, client, onEvent }), requests };
}

describe('analyst loop', () => {
  test('executes a requested tool and feeds the result back', async () => {
    const { analyst, requests } = analystWith([
      reply([toolUse('tu_1', 'get_client', { clientId })], 'tool_use'),
      reply([text('Done looking.')]),
    ]);

    const result = await analyst.ask('what does this client hold?');
    assert.equal(result.answer, 'Done looking.');
    assert.equal(result.toolCallCount, 1);

    // Second request must carry the assistant turn and then the tool result.
    const followUp = requests[1].messages;
    assert.equal(followUp.at(-2).role, 'assistant');
    const resultTurn = followUp.at(-1);
    assert.equal(resultTurn.role, 'user');
    assert.equal(resultTurn.content[0].type, 'tool_result');
    assert.equal(resultTurn.content[0].tool_use_id, 'tu_1');
    assert.ok(JSON.parse(resultTurn.content[0].content).client.id === clientId);
  });

  test('returns parallel tool results in a single user message', async () => {
    const { analyst, requests } = analystWith([
      reply([
        toolUse('tu_1', 'get_client', { clientId }),
        toolUse('tu_2', 'get_claims_summary', { clientId }),
      ], 'tool_use'),
      reply([text('ok')]),
    ]);

    await analyst.ask('look at two things');
    const resultTurn = requests[1].messages.at(-1);
    assert.equal(resultTurn.content.length, 2, 'both results must ride in one message');
    assert.deepEqual(resultTurn.content.map((c) => c.tool_use_id), ['tu_1', 'tu_2']);
  });

  test('a failing tool comes back flagged rather than throwing', async () => {
    const { analyst, requests } = analystWith([
      reply([toolUse('tu_1', 'get_client', { clientId: 'CL-NOPE' })], 'tool_use'),
      reply([text('That client does not exist.')]),
    ]);

    await analyst.ask('look up a client that is not there');
    const block = requests[1].messages.at(-1).content[0];
    assert.equal(block.is_error, true);
    assert.match(block.content, /No client/);
  });

  test('a refusal surfaces as an explicit error, not an empty answer', async () => {
    const { analyst } = analystWith([
      { content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } },
    ]);
    await assert.rejects(() => analyst.ask('something'), /declined this request.*cyber/s);
  });

  test('tool definitions and a cached system prompt go out on every request', async () => {
    const { analyst, requests } = analystWith([reply([text('hi')])]);
    await analyst.ask('hello');
    const request = requests[0];
    assert.ok(request.tools.length > 0);
    assert.equal(request.system[0].cache_control.type, 'ephemeral');
    assert.ok(request.output_config.effort);
  });

  test('briefClient runs the loop then parses the structured pass', async () => {
    const brief = {
      headline: 'One thing matters here.',
      situation: 'Situation.',
      recommendations: [{
        rank: 1, line: 'dental_rider', title: 'Dental rider', evidenceStrength: 'strong',
        rationale: 'Because.', evidenceRefs: ['POL-1000'], whyNow: 'Renewal.',
        estPremiumTTD: 1000, talkTrack: 'Say this.', toConfirm: ['Check that.'],
        likelyObjection: 'Cost.', objectionResponse: 'Reframe.',
      }],
      setAside: [{ line: 'cyber_liability', reason: 'Already declined last year.' }],
      openQuestions: ['Who signs off?'],
    };

    const { analyst, requests } = analystWith([
      reply([toolUse('tu_1', 'list_opportunities', { clientId })], 'tool_use'),
      reply([text('Here is my read.')]),
      reply([text(JSON.stringify(brief))]),
    ]);

    const result = await analyst.briefClient(clientId);
    assert.equal(result.headline, brief.headline);
    assert.equal(result.clientId, clientId);
    assert.equal(result.clientName, book.clients[0].name);
    assert.ok(result.disclaimer.includes('licensed AIB broker'));
    assert.equal(result.toolCallCount, 1);

    // The synthesis request must be constrained and tool-free.
    const synthesis = requests.at(-1);
    assert.equal(synthesis.output_config.format.type, 'json_schema');
    assert.equal(synthesis.tools, undefined, 'synthesis pass should not offer tools');
  });

  test('briefClient rejects an unknown client before spending a request', async () => {
    const { analyst, requests } = analystWith([]);
    await assert.rejects(() => analyst.briefClient('CL-NOPE'), /No client/);
    assert.equal(requests.length, 0);
  });

  test('non-JSON from the structured pass produces a clear error', async () => {
    const { analyst } = analystWith([
      reply([text('exploring')]),
      reply([text('not json at all')]),
    ]);
    await assert.rejects(() => analyst.briefClient(clientId), /Expected JSON/);
  });

  test('a truncated structured pass is reported rather than silently parsed', async () => {
    const { analyst } = analystWith([
      reply([text('exploring')]),
      reply([text('{"headline":')], 'max_tokens'),
    ]);
    await assert.rejects(() => analyst.briefClient(clientId), /cut short/);
  });

  test('progress events are emitted for phases and tool calls', async () => {
    const events = [];
    const { analyst } = analystWith([
      reply([toolUse('tu_1', 'get_book_summary', {})], 'tool_use'),
      reply([text('done')]),
    ], (e) => events.push(e));

    await analyst.ask('summarise the book');
    assert.ok(events.some((e) => e.type === 'phase'));
    assert.ok(events.some((e) => e.type === 'tool' && e.name === 'get_book_summary'));
  });

  test('the loop stops rather than spinning when the model keeps calling tools', async () => {
    const responses = Array.from({ length: 40 }, () =>
      reply([toolUse('tu_x', 'get_book_summary', {})], 'tool_use'));
    const notices = [];
    const { analyst, requests } = analystWith(responses, (e) => e.type === 'notice' && notices.push(e));

    const result = await analyst.ask('loop forever');
    assert.equal(result.answer, '');
    assert.ok(requests.length <= 24, `made ${requests.length} requests`);
    assert.ok(notices.some((n) => /Stopped after/.test(n.message)));
  });

  test('sweepBook returns the structured shape with its disclaimer', async () => {
    const sweep = {
      headline: 'Start here.',
      recommendations: [{
        rank: 1, clientId, clientName: book.clients[0].name, line: 'group_life',
        title: 'No death-in-service benefit', evidenceStrength: 'moderate',
        rationale: 'Because.', evidenceRefs: ['POL-1000'], whyNow: 'Renewal.',
        estPremiumTTD: 5000, nextStep: 'Call the HR manager.',
      }],
      patterns: [{ pattern: 'Dental exclusions', affectedClientIds: [clientId], suggestedApproach: 'Batch it.' }],
      caveats: ['Estimates are indicative.'],
    };

    const { analyst } = analystWith([
      reply([text('exploring')]),
      reply([text(JSON.stringify(sweep))]),
    ]);

    const result = await analyst.sweepBook({ limit: 5 });
    assert.equal(result.headline, 'Start here.');
    assert.equal(result.recommendations[0].clientId, clientId);
    assert.ok(result.disclaimer);
  });
});
