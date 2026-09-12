// api/agent-card.mjs — the discovery document agents look for.
//
// Also reachable as /agent-card.json (see vercel.json).
//
// The base URL is the one thing a discovery document cannot get wrong: it is
// the address every other agent will keep. Behind a proxy, Host and
// X-Forwarded-Host can both name the host the proxy itself dialled rather than
// the host the caller used, so a hosted copy would advertise an address that
// only exists inside the platform. PUBLIC_BASE_URL settles it explicitly.

import '../src/env.mjs';
import { agentCard, catalog, SERVER_INFO } from '../src/mcp-protocol.mjs';

export function publicBase(req) {
  const declared = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (declared) return declared;
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${String(host).split(',')[0].trim()}` : '';
}

export default function handler(req, res) {
  const base = publicBase(req);

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=60');
  res.statusCode = 200;
  res.end(JSON.stringify({ ...SERVER_INFO, ...agentCard(base), tagline: catalog.tagline }, null, 2));
}
