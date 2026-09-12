// api/agent-card.mjs — the discovery document agents look for.
//
// Also reachable as /agent-card.json (see vercel.json).

import { agentCard, catalog, SERVER_INFO } from '../src/mcp-protocol.mjs';

export default function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = host ? `${proto}://${host}` : '';

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=60');
  res.statusCode = 200;
  res.end(JSON.stringify({ ...SERVER_INFO, ...agentCard(base), tagline: catalog.tagline }, null, 2));
}
