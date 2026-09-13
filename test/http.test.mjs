// ============================================================
// test/http.test.mjs — does the public endpoint behave?
//
// The serverless handlers use the plain Node (req, res) signature, so
// they can be mounted on a local http server and tested without any
// hosting account. If this passes, the deployment has nothing left to
// surprise us with.
//
//   MODEL_API_KEY=… node test/http.test.mjs
// ============================================================

import { createServer } from 'node:http';
import mcp from '../api/mcp.mjs';
import card from '../api/agent-card.mjs';
import health from '../api/health.mjs';
import catalogHandler from '../api/catalog.mjs';

const PORT = Number(process.env.TEST_PORT || 8099);
const ROUTES = { '/mcp': mcp, '/agent-card.json': card, '/health': health, '/catalog.json': catalogHandler };

const server = createServer((req, res) => {
  const path = String(req.url).split('?')[0];
  const handler = ROUTES[path];
  if (!handler) {
    res.statusCode = 404;
    return res.end('not found');
  }
  handler(req, res);
});

const checks = [];
const assert = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) });
  process.stderr.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${PORT}`;

async function post(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, json, text, type: res.headers.get('content-type') };
}

try {
  const h = await fetch(base + '/health');
  const hj = await h.json();
  assert('GET /health is ok', h.status === 200 && hj.ok === true);
  assert('GET /health lists all eight tools', (hj.tools || []).length === 8, String((hj.tools || []).length));
  assert('GET /health reports a configured extractor', hj.extractor_configured === true);

  const c = await fetch(base + '/catalog.json');
  const cj = await c.json();
  assert('GET /catalog.json returns prices', cj.services?.length === 7 && cj.free?.length >= 1);

  const a = await fetch(base + '/agent-card.json');
  const aj = await a.json();
  assert('GET /agent-card.json advertises the mcp endpoint', /\/mcp$/.test(aj.mcp?.endpoint || ''), aj.mcp?.endpoint);

  const info = await fetch(base + '/mcp');
  assert('GET /mcp returns discovery json', info.status === 200 && (await info.json()).name === 'ground');

  const init = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert('POST /mcp initialize', init.json?.result?.protocolVersion === '2025-06-18', init.json?.result?.protocolVersion);

  const list = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert('POST /mcp tools/list', (list.json?.result?.tools || []).length === 8);

  const notify = await post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert('notifications get 202 and no body', notify.status === 202);

  const free = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ground.selfcheck', arguments: {} } });
  const sc = free.json?.result?.structuredContent;
  assert('free selfcheck returns a code-verified receipt', sc?.check?.quote_check === 'verbatim_in_source', String(sc?.check?.verdict));
  assert('free selfcheck costs 0', sc?.credits === 0);

  const paid = await post('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ground.check', arguments: { url: 'https://example.com', statement: 'This page is titled Example Domain.' } } });
  assert('paid ground.check returns a verdict', paid.json?.result?.structuredContent?.verdict === 'supported');

  const sse = await post('/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/list' }, { accept: 'text/event-stream' });
  assert('SSE clients get event-stream framing', sse.type?.includes('text/event-stream') && sse.text.startsWith('event: message'));

  const bad = await post('/mcp', 'not json');
  assert('malformed body returns 400', bad.status === 400);

  const batch = await post('/mcp', [
    { jsonrpc: '2.0', id: 6, method: 'tools/list' },
    { jsonrpc: '2.0', id: 7, method: 'ping' },
  ]);
  assert('batch requests are answered', Array.isArray(batch.json) && batch.json.length === 2);
} catch (error) {
  assert('suite completed', false, String(error.message));
} finally {
  server.close();
}

const failed = checks.filter((c) => !c.ok);
process.stderr.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
process.exit(failed.length ? 1 : 0);
