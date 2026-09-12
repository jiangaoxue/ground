// api/catalog.mjs — the price list, machine-readable.
//
// Also reachable as /catalog.json. Free for anyone to read.

import { catalog } from '../src/mcp-protocol.mjs';

export default function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=60');
  res.statusCode = 200;
  res.end(JSON.stringify(catalog, null, 2));
}
