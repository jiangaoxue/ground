#!/usr/bin/env node
// ============================================================
// ground — the CLI door.
//
// A second way in, for agents that would rather shell out than speak
// MCP, and for humans who want to see the receipt with their own eyes.
//
//   npx ground-receipt@latest check https://example.com "the page says …"
//   npx ground-receipt@latest extract https://example.com --fields price,title
//   npx ground-receipt@latest selfcheck          # free
//   npx ground-receipt@latest catalog
//   npx ground-receipt@latest mcp                # serve MCP over stdio
//
// Exit code 0 = a receipt was produced. 1 = it was not, and the reason
// is on stdout. Nothing is ever guessed.
// ============================================================

import { handleRpc, catalog, agentCard } from '../src/mcp-protocol.mjs';

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--json' || a === '--pretty') flags.json = true;
  else if (a === '--compact') flags.compact = true;
  else if (a === '--help' || a === '-h') flags.help = true;
  else if (a === '--remote') flags.remote = argv[++i];
  else if (a.startsWith('--remote=')) flags.remote = a.slice(9);
  else if (a === '--fields') flags.fields = argv[++i];
  else if (a.startsWith('--fields=')) flags.fields = a.slice(9);
  else if (a === '--question') flags.question = argv[++i];
  else if (a === '--data') flags.data = argv[++i];
  else if (a.startsWith('--data=')) flags.data = a.slice(7);
  else positional.push(a);
}

const remote = flags.remote || process.env.GROUND_REMOTE || null;

function out(value, code = 0) {
  const text = flags.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  process.stdout.write(`${text}\n`);
  process.exit(code);
}

function fail(message, extra = {}) {
  out({ ok: false, error: message, ...extra }, 1);
}

function help() {
  process.stdout.write(
    `ground — evidence receipts for agent claims

Usage
  ground check <url> "<statement>"           3 credits
  ground extract <url> --fields a,b[,c]      5 credits
  ground batch --data '<json>'              10 credits
  ground attest --data '<json>'             15 credits
  ground certify --data '<json>'            25 credits
  ground selfcheck [url]                     free
  ground catalog                             free
  ground card                                free
  ground call <tool> '<json arguments>'
  ground mcp                                 serve MCP over stdio
  ground ping

Flags
  --remote <base-url>   call a deployed Ground instead of a local engine
                        (or set GROUND_REMOTE)
  --compact             single-line JSON
  --json                JSON output (default)

Local engine needs MODEL_API_KEY (and optionally MODEL_BASE_URL, MODEL_NAME).
A remote call needs nothing but the URL.

${catalog.product} — ${catalog.tagline}
`
  );
  process.exit(0);
}

async function rpc(method, params) {
  if (remote) {
    const res = await fetch(`${remote.replace(/\/+$/, '')}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`remote returned ${res.status}: ${text.slice(0, 200)}`);
    }
    if (body.error) throw new Error(body.error.message || 'remote error');
    return body.result;
  }
  const res = await handleRpc({ jsonrpc: '2.0', id: 1, method, params });
  if (res?.error) throw new Error(res.error.message || 'error');
  return res?.result;
}

async function tool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  if (result?.isError) {
    const text = result.content?.[0]?.text || 'failed';
    throw new Error(text);
  }
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

function need(cond, message) {
  if (!cond) fail(message);
}

async function main() {
  const cmd = positional[0] || (flags.help ? 'help' : 'help');

  if (cmd === 'help') help();

  if (cmd === 'catalog') return out(catalog);
  if (cmd === 'card') return out(agentCard(remote || 'https://ground.vercel.app'));

  if (cmd === 'ping') {
    const info = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ground-cli', version: '1.0.0' } });
    const list = await rpc('tools/list', {});
    return out({ ok: true, mode: remote ? `remote ${remote}` : 'local engine', server: info.serverInfo, tools: list.tools.map((t) => ({ name: t.name, credits: t._meta?.credits })) });
  }

  if (cmd === 'mcp') {
    await import('../src/mcp-stdio.mjs');
    return undefined; // the stdio server keeps the process alive
  }

  if (cmd === 'call') {
    const name = positional[1];
    need(name, 'ground call <tool> \'<json>\'');
    let args = {};
    if (positional[2]) {
      try {
        args = JSON.parse(positional[2]);
      } catch {
        return fail('arguments must be valid JSON');
      }
    }
    return out(await tool(name, args));
  }

  if (cmd === 'selfcheck') {
    return out(await tool('ground.selfcheck', positional[1] ? { url: positional[1] } : {}));
  }

  if (cmd === 'check') {
    const [url, statement] = [positional[1], positional.slice(2).join(' ')];
    need(url, 'ground check <url> "<statement>"');
    need(statement, 'a statement is required');
    return out(await tool('ground.check', { url, statement }));
  }

  if (cmd === 'extract') {
    const url = positional[1];
    need(url, 'ground extract <url> --fields a,b,c');
    const names = String(flags.fields || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    need(names.length || flags.question, 'pass --fields a,b,c (or --question "...")');
    const fields = names.length ? names.map((name) => ({ name })) : [{ name: 'answer', hint: flags.question }];
    return out(await tool('ground.extract', { url, fields }));
  }

  if (cmd === 'batch' || cmd === 'attest' || cmd === 'certify') {
    need(flags.data, `ground ${cmd} --data '<json>'`);
    let data;
    try {
      data = JSON.parse(flags.data);
    } catch {
      return fail("--data must be valid JSON");
    }
    return out(await tool(`ground.${cmd}`, data));
  }

  return fail(`unknown command: ${cmd}. Run "ground --help".`);
}

main().catch((error) => fail(String(error?.message || error)));
