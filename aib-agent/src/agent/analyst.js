/**
 * The analyst: an agentic loop over the book's read-only tools, followed by a
 * structured synthesis pass.
 *
 * Two phases on purpose. The exploration phase lets the model go and look —
 * pull a client, check the claims, test a hunch against the peer benchmark,
 * follow something the rules did not flag. The synthesis phase then forces the
 * result into a shape the console and the CLI can both render, and that a
 * broker can scan in thirty seconds.
 *
 * The loop is written out by hand rather than delegated to the SDK's tool
 * runner. This is the first AI system to touch a live book of business, and
 * being able to read exactly what happens on each turn — and log it — is worth
 * more here than the lines of code the runner would save.
 */

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, briefInstruction, sweepInstruction } from './prompt.js';
import { TOOL_DEFINITIONS, runTool } from './tools.js';

const DEFAULT_MODEL = process.env.AIB_MODEL || 'claude-opus-5';
const DEFAULT_EFFORT = process.env.AIB_EFFORT || 'high';

/** Ceiling on tool-calling turns, so a confused run stops rather than spirals. */
const MAX_TURNS = 24;

/**
 * @param {{
 *   ix: import('../data/book.js').BookIndex,
 *   benchmarks: Map<string, any>,
 *   now?: Date,
 *   model?: string,
 *   effort?: string,
 *   client?: Anthropic,
 *   onEvent?: (event: {type: string, [k: string]: any}) => void,
 * }} config
 */
export function createAnalyst(config) {
  const {
    ix, benchmarks,
    now = new Date(),
    model = DEFAULT_MODEL,
    effort = DEFAULT_EFFORT,
    onEvent = () => {},
  } = config;

  const anthropic = config.client ?? new Anthropic();
  const toolCtx = { ix, benchmarks, now };

  // Claude Opus 5 can decline a request outright; without a fallback the call
  // simply stops. Opting in means a decline is re-served by another model
  // inside the same request rather than surfacing as a dead run. If the beta is
  // not available to this account we drop it and carry on unprotected.
  let useFallbacks = true;

  /**
   * One request, streamed. Streaming is not for show — at this max_tokens a
   * non-streaming call risks an HTTP timeout on a long agentic turn.
   */
  async function send({ messages, tools, outputFormat }) {
    /** @type {any} */
    const params = {
      model,
      max_tokens: 32000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages,
      output_config: { effort, ...(outputFormat ? { format: outputFormat } : {}) },
    };
    if (tools) params.tools = tools;

    const attempt = async (withFallbacks) => {
      const request = withFallbacks
        ? { ...params, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] }
        : params;
      const stream = withFallbacks
        ? anthropic.beta.messages.stream(request)
        : anthropic.messages.stream(request);
      return stream.finalMessage();
    };

    try {
      return await attempt(useFallbacks);
    } catch (err) {
      const message = String(err?.message ?? err);
      if (useFallbacks && /fallback|beta/i.test(message)) {
        // Not entitled to the beta — note it once and continue without.
        onEvent({ type: 'notice', message: 'Server-side refusal fallbacks unavailable on this account; continuing without them.' });
        useFallbacks = false;
        return attempt(false);
      }
      throw err;
    }
  }

  /**
   * Drive the tool loop until the model stops asking for tools.
   * @returns {Promise<{messages: any[], finalText: string, toolCalls: {name: string, input: any}[]}>}
   */
  async function explore(instruction) {
    const messages = [{ role: 'user', content: instruction }];
    const toolCalls = [];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await send({ messages, tools: TOOL_DEFINITIONS });

      if (response.stop_reason === 'refusal') {
        throw new Error(
          `The model declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}. ` +
            'This is unusual for book analysis — check the instruction for anything that reads as a request for something other than broking analysis.',
        );
      }

      messages.push({ role: 'assistant', content: response.content });

      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) onEvent({ type: 'text', text: block.text });
      }

      const requested = response.content.filter((b) => b.type === 'tool_use');
      if (!requested.length) {
        const finalText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        return { messages, finalText, toolCalls };
      }

      const results = [];
      for (const call of requested) {
        onEvent({ type: 'tool', name: call.name, input: call.input });
        toolCalls.push({ name: call.name, input: call.input });
        const { content, isError } = runTool(call.name, call.input, toolCtx);
        results.push({ type: 'tool_result', tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
      }
      // All results go back in one user message — splitting them teaches the
      // model to stop making parallel tool calls.
      messages.push({ role: 'user', content: results });
    }

    onEvent({ type: 'notice', message: `Stopped after ${MAX_TURNS} turns without a final answer.` });
    return { messages, finalText: '', toolCalls };
  }

  /**
   * Second pass: same conversation, no tools, constrained to a schema.
   * Re-running the exploration would double the cost and could reach a
   * different conclusion; continuing it keeps the evidence in view.
   */
  async function synthesise(messages, schema, instruction) {
    const response = await send({
      messages: [...messages, { role: 'user', content: instruction }],
      outputFormat: { type: 'json_schema', schema },
    });

    if (response.stop_reason === 'refusal') throw new Error('The model declined to produce the structured summary.');
    if (response.stop_reason === 'max_tokens') {
      throw new Error('The structured summary was cut short by the token limit. Narrow the scope and try again.');
    }

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON from the synthesis pass, got: ${text.slice(0, 200)}`);
    }
  }

  return {
    /** Deep dive on one client, returned as structured recommendations. */
    async briefClient(clientId) {
      const client = ix.clientsById.get(clientId);
      if (!client) throw new Error(`No client "${clientId}" on the book`);

      onEvent({ type: 'phase', phase: 'explore', clientId });
      const { messages, toolCalls } = await explore(briefInstruction(clientId));

      onEvent({ type: 'phase', phase: 'synthesise', clientId });
      const brief = await synthesise(
        messages,
        BRIEF_SCHEMA,
        'Now set that out as the structured brief. Keep every recommendation tied to the record identifiers you actually saw — if you cannot cite it, leave it out of the recommendations and raise it as an open question instead.',
      );

      return {
        ...brief,
        clientId,
        clientName: client.name,
        generatedAt: new Date().toISOString(),
        toolCallCount: toolCalls.length,
        disclaimer:
          'Internal preparation material. Estimates are indicative for ranking, not quotes. Nothing here should reach a client without review by a licensed AIB broker.',
      };
    },

    /** Portfolio triage across the book or a filtered slice of it. */
    async sweepBook({ scope = 'the whole book', limit = 8 } = {}) {
      onEvent({ type: 'phase', phase: 'explore', scope });
      const { messages, toolCalls } = await explore(sweepInstruction(scope, limit));

      onEvent({ type: 'phase', phase: 'synthesise', scope });
      const sweep = await synthesise(
        messages,
        SWEEP_SCHEMA,
        `Now set that out as the structured sweep, at most ${limit} recommendations. Every one must name a real client id you looked at.`,
      );

      return {
        ...sweep,
        scope,
        generatedAt: new Date().toISOString(),
        toolCallCount: toolCalls.length,
        disclaimer:
          'Internal preparation material. Estimates are indicative for ranking, not quotes. Nothing here should reach a client without review by a licensed AIB broker.',
      };
    },

    /** Free-form question against the book. Returns prose, not structure. */
    async ask(question) {
      onEvent({ type: 'phase', phase: 'explore', question });
      const { finalText, toolCalls } = await explore(question);
      return { question, answer: finalText, toolCallCount: toolCalls.length, generatedAt: new Date().toISOString() };
    },
  };
}

// ------------------------------------------------------------------ schemas

const EVIDENCE_STRENGTH = { type: 'string', enum: ['strong', 'moderate', 'weak'] };

const RECOMMENDATION = {
  type: 'object',
  properties: {
    rank: { type: 'integer' },
    line: { type: 'string', description: 'Catalogue key for the line being recommended.' },
    title: { type: 'string', description: 'One line naming the gap, specific to this client.' },
    evidenceStrength: EVIDENCE_STRENGTH,
    rationale: { type: 'string', description: 'Why this matters for this client, citing record ids.' },
    evidenceRefs: { type: 'array', items: { type: 'string' }, description: 'Policy, claim, member or client ids that support this.' },
    whyNow: { type: 'string', description: 'What makes this timely — renewal date, claim pattern, lifecycle event.' },
    estPremiumTTD: { type: 'number', description: 'Indicative annual premium, not a quote.' },
    talkTrack: { type: 'string', description: 'Notes for the account executive on how to raise it. Not client-ready copy.' },
    toConfirm: { type: 'array', items: { type: 'string' }, description: 'What must be checked with the client before relying on this.' },
    likelyObjection: { type: 'string' },
    objectionResponse: { type: 'string' },
  },
  required: ['rank', 'line', 'title', 'evidenceStrength', 'rationale', 'evidenceRefs', 'whyNow', 'estPremiumTTD', 'talkTrack', 'toConfirm', 'likelyObjection', 'objectionResponse'],
  additionalProperties: false,
};

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One sentence: the single most important thing about this account.' },
    situation: { type: 'string', description: 'Short paragraph on where the account stands.' },
    recommendations: { type: 'array', items: RECOMMENDATION },
    setAside: {
      type: 'array',
      description: 'Rule findings deliberately not recommended, and why. Being explicit here is what makes the rest trustworthy.',
      items: {
        type: 'object',
        properties: {
          line: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['line', 'reason'],
        additionalProperties: false,
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' }, description: 'What the account executive should establish that the data cannot answer.' },
  },
  required: ['headline', 'situation', 'recommendations', 'setAside', 'openQuestions'],
  additionalProperties: false,
};

const SWEEP_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One sentence on where the effort should go.' },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rank: { type: 'integer' },
          clientId: { type: 'string' },
          clientName: { type: 'string' },
          line: { type: 'string' },
          title: { type: 'string' },
          evidenceStrength: EVIDENCE_STRENGTH,
          rationale: { type: 'string' },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
          whyNow: { type: 'string' },
          estPremiumTTD: { type: 'number' },
          nextStep: { type: 'string' },
        },
        required: ['rank', 'clientId', 'clientName', 'line', 'title', 'evidenceStrength', 'rationale', 'evidenceRefs', 'whyNow', 'estPremiumTTD', 'nextStep'],
        additionalProperties: false,
      },
    },
    patterns: {
      type: 'array',
      description: 'Findings that repeat across the book and are worth running as a campaign rather than client by client.',
      items: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          affectedClientIds: { type: 'array', items: { type: 'string' } },
          suggestedApproach: { type: 'string' },
        },
        required: ['pattern', 'affectedClientIds', 'suggestedApproach'],
        additionalProperties: false,
      },
    },
    caveats: { type: 'array', items: { type: 'string' }, description: 'What would change this view.' },
  },
  required: ['headline', 'recommendations', 'patterns', 'caveats'],
  additionalProperties: false,
};

export { BRIEF_SCHEMA, SWEEP_SCHEMA };
