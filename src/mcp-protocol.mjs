// ============================================================
// mcp-protocol.mjs — the agent-facing door.
//
// Arena requirement: "Expose an MCP or CLI so another agent can
// register, call your service and get a result with no human in the
// loop." This module is that door. It speaks MCP JSON-RPC 2.0
// (initialize / tools/list / tools/call) and it is transport-free, so
// the same logic serves the public HTTP endpoint and the stdio server
// that a coding agent can spawn locally.
//
// The kernel is not optional here. src/runtime.mjs builds one kernel per
// process and arms this door with setKernelRunner(); from then on every
// ground.* tools/call — HTTP or stdio — executes as one SharedOS kernel
// turn: authority resolved, grant checked, tool invoked, every decision
// appended to the audit chain. The output of that path already carries
// its receipt and its audit link, so this module does not wrap it again.
// Unarmed (unit tests, direct imports), calls fall through to the engine.
// ============================================================

import { createRequire } from 'node:module';
import { check, extract, batch, attest, certify, verifyQuote } from './engine/ground.js';
import { withReceipt } from './receipt.mjs';

const require = createRequire(import.meta.url);
export const catalog = require('../catalog.json');

export const SERVER_INFO = { name: 'ground', version: '1.0.0', title: 'Ground — evidence receipts' };

const LATEST_PROTOCOL = '2025-06-18';
const KNOWN_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const priceOf = (name) => {
  const s = (catalog.services || []).find((x) => x.name === name);
  const f = (catalog.free || []).find((x) => x.name === name);
  return (s || f || {}).credits ?? null;
};

const withPrice = (name, description) => {
  const c = priceOf(name);
  const line = c === 0 ? 'FREE.' : `COST: ${c} Arena credits per call.`;
  return `${description} ${line} Credits are issued by the organizers; Ground runs no payment system.`;
};

const OBJ = (props, required, extra = {}) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties: props,
  ...extra,
});

const FIELDS = {
  type: 'array',
  minItems: 1,
  maxItems: 8,
  description: 'Field names to pull out of the page.',
  items: OBJ(
    { name: { type: 'string', minLength: 1, maxLength: 60 }, hint: { type: 'string', maxLength: 160 } },
    ['name']
  ),
};

const URL_STR = { type: 'string', pattern: '^https?://', maxLength: 2048 };

export const TOOLS = [
  {
    name: 'ground.check',
    credits: priceOf('ground.check'),
    description: withPrice(
      'ground.check',
      'Test one statement against one web page. Fetches the page, asks the model to locate the supporting span, then verifies that span against the fetched text BY CODE. Returns verdict (supported / contradicted / not_mentioned), the verbatim quote, and the sha256 of the fetched text.'
    ),
    inputSchema: OBJ({ url: URL_STR, statement: { type: 'string', minLength: 1, maxLength: 600 } }, ['url', 'statement']),
  },
  {
    name: 'ground.extract',
    credits: priceOf('ground.extract'),
    description: withPrice(
      'ground.extract',
      'Pull named fields out of one web page. Returns JSON where every non-null value carries the verbatim span that proves it, checked by code. A field the page does not state comes back null with a reason — Ground never fills a gap with plausible text.'
    ),
    inputSchema: OBJ({ url: URL_STR, fields: FIELDS }, ['url', 'fields']),
  },
  {
    name: 'ground.batch',
    credits: priceOf('ground.batch'),
    description: withPrice(
      'ground.batch',
      'Up to six URLs in a single call, each grounded by the same rules as ground.extract.'
    ),
    inputSchema: OBJ(
      { items: { type: 'array', minItems: 1, maxItems: 6, items: OBJ({ url: URL_STR, fields: FIELDS }, ['url', 'fields']) } },
      ['items']
    ),
  },
  {
    name: 'ground.attest',
    credits: priceOf('ground.attest'),
    description: withPrice(
      'ground.attest',
      'Hand Ground your own finished deliverable and the sources it cites. Ground reads each cited source now, tests each claim against the source named for it, and returns a packet with a single hash you can attach to what you ship. A seller cannot produce this for itself: self-attestation is worth nothing.'
    ),
    inputSchema: OBJ(
      {
        claims: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: OBJ({ statement: { type: 'string', minLength: 1, maxLength: 400 }, url: URL_STR }, ['statement', 'url']),
        },
        deliverable: { type: 'string', maxLength: 200, description: 'Optional label for what is being attested.' },
      },
      ['claims']
    ),
  },
  {
    name: 'ground.certify',
    credits: priceOf('ground.certify'),
    description: withPrice(
      'ground.certify',
      'The whole deliverable in one pass: every cited source read now, every claim tested against the source it names, every value quoted, one hash over the lot.'
    ),
    inputSchema: OBJ(
      {
        sources: { type: 'array', maxItems: 6, items: OBJ({ url: URL_STR, fields: FIELDS }, ['url', 'fields']) },
        claims: {
          type: 'array',
          maxItems: 10,
          items: OBJ({ statement: { type: 'string', minLength: 1, maxLength: 400 }, url: URL_STR }, ['statement', 'url']),
        },
      },
      [],
      { anyOf: [{ required: ['sources'] }, { required: ['claims'] }] }
    ),
  },
  {
    name: 'ground.selfcheck',
    credits: 0,
    description: withPrice(
      'ground.selfcheck',
      'A full receipt over a neutral page Ground does not own, using the exact code path the paid tools use: one check plus one extract, both verified verbatim. Run it before you pay, then re-run it yourself and compare the sha256.'
    ),
    inputSchema: OBJ({ url: URL_STR, statement: { type: 'string', maxLength: 600 } }, []),
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export const DEMO_URL = 'https://example.com';
export const DEMO_STATEMENT = 'This page is titled Example Domain.';

export async function callSelfcheck(args = {}) {
  const url = typeof args.url === 'string' && /^https?:\/\//i.test(args.url) ? args.url : DEMO_URL;
  const statement = typeof args.statement === 'string' && args.statement.trim() ? args.statement.slice(0, 600) : DEMO_STATEMENT;
  const [checked, extracted] = await Promise.all([
    check({ url, statement }),
    extract({ url, fields: [{ name: 'heading' }, { name: 'purpose', hint: 'what the page says it is for' }] }),
  ]);
  return {
    ok: true,
    service: 'ground.selfcheck',
    credits: 0,
    note: 'Free. Re-fetch the url below, hash the text, and compare source.text_sha256 — if it matches, nothing in this receipt was invented.',
    check: {
      url,
      statement,
      verdict: checked.verdict,
      quote: checked.quote || null,
      quote_check: checked.quote_check || checked.reason || null,
      source: checked.source,
    },
    extract: { url, grounding: extracted.grounding, fields: extracted.fields, source: extracted.source },
  };
}

/** Dispatch one tools/call. Returns { result } or throws. */
export async function callTool(name, args = {}) {
  if (!byName.has(name)) throw new Error(`unknown tool: ${name}`);
  switch (name) {
    case 'ground.check':
      return check(args);
    case 'ground.extract':
      // The MCP schema uses `fields`; the engine wants {url, fields}.
      return extract({ url: args.url, fields: args.fields, max_chars: args.max_chars });
    case 'ground.batch':
      return batch({ items: args.items });
    case 'ground.attest':
      return attest({ claims: args.claims });
    case 'ground.certify':
      return certify({ sources: args.sources, claims: args.claims });
    case 'ground.selfcheck':
      return callSelfcheck(args);
    default:
      throw new Error(`unrouted tool: ${name}`);
  }
}

// ---------------------------------------------------------------- kernel wiring
//
// Set by src/runtime.mjs at import time. When armed, every ground.*
// tools/call runs as one SharedOS kernel turn and the returned payload
// already carries `receipt` and `audit` — this module must not wrap it
// again, or the receipt id would be computed over the receipt itself.

let kernelRunner = null;

export function setKernelRunner(fn) {
  kernelRunner = typeof fn === 'function' ? fn : null;
}

function textContent(payload) {
  return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
}

/** The receipt, in the shape MCP clients expect. */
export async function toolsCall(params) {
  const name = params?.name;
  const args = params?.arguments || {};
  try {
    if (!byName.has(name)) throw new Error(`unknown tool: ${name}`);
    const raw = kernelRunner
      ? await kernelRunner(name, args) // one kernel turn; receipt + audit attached inside
      : withReceipt(await callTool(name, args)); // unarmed fallback (unit tests, direct imports)
    const clean = JSON.parse(JSON.stringify(raw)); // MCP rejects undefined anywhere in the payload
    // A refusal (invalid arguments, kernel turn failed) is still a full,
    // honest payload — the real reason, the trace, the audit link — but
    // MCP semantics say the call did not succeed, so say so with isError.
    if (raw && raw.ok === false) {
      return { content: textContent(clean), structuredContent: clean, isError: true };
    }
    return { content: textContent(clean), structuredContent: clean, isError: false };
  } catch (error) {
    const message = String(error?.message || error);
    return { content: [{ type: 'text', text: `Ground could not complete ${name}: ${message}` }], isError: true };
  }
}

export function toolsList() {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { credits: t.credits, currency: 'arena-credits' },
    })),
  };
}

/**
 * Handle one JSON-RPC message. Returns the response object, or null when
 * the message is a notification (notifications must never be answered).
 */
export async function handleRpc(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } };
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      const version = KNOWN_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL;
      return ok({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Ground returns evidence, not opinions. Give it a URL. Every non-null value comes back with the verbatim span that proves it plus the sha256 of the text that was fetched, so you can re-fetch and re-hash the receipt yourself. Call ground.selfcheck first — it is free.',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return null;
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok(toolsList());
    case 'tools/call':
      return ok(await toolsCall(params || {}));
    case 'resources/list':
      return ok({ resources: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

/** Public discovery document. Agents that look for agent-card.json find this. */
export function agentCard(baseUrl = '') {
  return {
    name: 'Ground',
    description: catalog.tagline,
    version: '1.0.0',
    protocol: 'mcp',
    mcp: { transport: 'streamable-http', endpoint: `${baseUrl}/mcp`, protocolVersion: LATEST_PROTOCOL },
    cli: 'git clone this repo && npm install, then: node bin/ground.mjs check <url> "<statement>"',
    free: (catalog.free || []).map((f) => ({ name: f.name, credits: 0, what: f.what })),
    services: (catalog.services || []).map((s) => ({ name: s.name, credits: s.credits, what: s.what, input: s.input })),
    guarantees: catalog.guarantees,
    contact: catalog.contact,
    how_credits_work: catalog.how_credits_work,
  };
}

export { verifyQuote };
