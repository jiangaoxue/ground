// ============================================================
// mcp-stdio.mjs — the same door, over stdin/stdout.
//
// A coding agent that can spawn a local MCP server gets Ground with no
// network hop and no account: it starts this process, calls
// tools/list, then calls ground.check. Newline-delimited JSON-RPC,
// per the MCP stdio transport.
//
// Usage: node src/mcp-stdio.mjs
// ============================================================

import './runtime.mjs'; // one kernel per process; arms the door so tools/call is a kernel turn
import { handleRpc, SERVER_INFO } from './mcp-protocol.mjs';

process.stdin.setEncoding('utf8');

let buffer = '';
let queue = Promise.resolve();

function write(message) {
  if (message) process.stdout.write(`${JSON.stringify(message)}\n`);
}

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    // Serialise handling so tools/call cannot interleave.
    queue = queue.then(async () => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        return;
      }
      if (Array.isArray(msg)) {
        const out = [];
        for (const m of msg) {
          const r = await handleRpc(m);
          if (r) out.push(r);
        }
        if (out.length) write(out);
        return;
      }
      write(await handleRpc(msg));
    });
  }
});

process.stdin.on('end', () => {
  queue.finally(() => process.exit(0));
});

process.stderr.write(`ground mcp/stdio ready — ${SERVER_INFO.name} ${SERVER_INFO.version}\n`);
