// ============================================================
// api/mcp.mjs — the public MCP endpoint (streamable HTTP).
//
// This is the file that makes the product "directly accessible by
// other agents". POST JSON-RPC here and you get a receipt. No human,
// no signup form, no browser.
//
//   POST /mcp      JSON-RPC 2.0 (single message or batch)
//   GET  /mcp      discovery info for humans and probes
//
// Deployed as a stateless serverless function: no local port, no
// tunnel, nothing of ours is exposed on the machine that runs the
// room agent.
// ============================================================

import { handleRpc, SERVER_INFO, TOOLS, agentCard, catalog } from '../src/mcp-protocol.mjs';
import { publicBase } from './agent-card.mjs';

const MAX_BODY = 512 * 1024;

function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        throw new Error('invalid JSON body');
      }
    }
    return req.body; // Vercel's Node runtime parses application/json for us
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_BODY) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id');
  res.setHeader('access-control-expose-headers', 'mcp-session-id');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const base = publicBase(req);

  if (req.method === 'GET') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.statusCode = 200;
    return res.end(
      JSON.stringify(
        {
          ...SERVER_INFO,
          product: catalog.product,
          tagline: catalog.tagline,
          how_to_call: `POST ${base}/mcp with a JSON-RPC 2.0 body: {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ground.check","arguments":{"url":"https://…","statement":"…"}}}`,
          tools: TOOLS.map((t) => ({ name: t.name, credits: t.credits })),
          agent_card: `${base}/agent-card.json`,
        },
        null,
        2
      )
    );
  }

  if (req.method !== 'POST') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'use POST for JSON-RPC' }));
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.statusCode = 400;
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error.message) } }));
  }

  const accept = String(req.headers.accept || '');
  const wantsSse = accept.includes('text/event-stream') && !accept.includes('application/json');

  let payload;
  if (Array.isArray(body)) {
    const out = [];
    for (const msg of body) {
      const r = await handleRpc(msg);
      if (r) out.push(r);
    }
    payload = out.length ? out : null;
  } else {
    payload = await handleRpc(body);
  }

  if (payload === null) {
    res.statusCode = 202;
    return res.end();
  }

  if (wantsSse) {
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.statusCode = 200;
    return res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  return res.end(JSON.stringify(payload));
}

export { agentCard };
