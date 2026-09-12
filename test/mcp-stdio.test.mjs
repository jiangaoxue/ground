// ============================================================
// test/mcp-stdio.test.mjs — does the stdio door actually work?
//
// Spawns the MCP server the way a coding agent would, performs a
// handshake, lists tools, then calls the free tool and asserts that the
// receipt carries a code-verified quote. No test framework, no deps.
//
//   MODEL_API_KEY=… node test/mcp-stdio.test.mjs
// ============================================================

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const server = spawn(process.execPath, [join(here, '..', 'src', 'mcp-stdio.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

const pending = new Map();
let buffer = '';
server.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let id = 0;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const mine = ++id;
    pending.set(mine, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 90000);
  });

const checks = [];
const assert = (name, cond, detail = '') => {
  checks.push({ name, ok: Boolean(cond), detail });
  process.stderr.write(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert('initialize returns serverInfo', init.result?.serverInfo?.name === 'ground', JSON.stringify(init.result?.serverInfo));

  const list = await rpc('tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name);
  assert('tools/list exposes check + extract', names.includes('ground.check') && names.includes('ground.extract'), names.join(', '));
  assert('tools/list carries prices', list.result?.tools?.every((t) => typeof t._meta?.credits === 'number'));

  const free = await rpc('tools/call', { name: 'ground.selfcheck', arguments: {} });
  const sc = free.result?.structuredContent;
  assert('selfcheck is not an error', free.result?.isError === false);
  assert('selfcheck costs 0', sc?.credits === 0);
  assert('selfcheck quote verified by code', sc?.check?.quote_check === 'verbatim_in_source', String(sc?.check?.verdict));
  assert('selfcheck carries text_sha256', /^[0-9a-f]{64}$/.test(sc?.extract?.source?.text_sha256 || ''));
  assert('selfcheck grounding ran', sc?.extract?.grounding?.total > 0, JSON.stringify(sc?.extract?.grounding));

  const bad = await rpc('tools/call', { name: 'ground.check', arguments: {} });
  assert('missing arguments fail loudly', bad.result?.isError === true, bad.result?.content?.[0]?.text?.slice(0, 60));

  const unknown = await rpc('tools/call', { name: 'ground.nope', arguments: {} });
  assert('unknown tool fails loudly', unknown.result?.isError === true);
} catch (error) {
  assert('suite completed', false, String(error.message));
} finally {
  server.kill();
}

const failed = checks.filter((c) => !c.ok);
process.stderr.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
process.exit(failed.length ? 1 : 0);
