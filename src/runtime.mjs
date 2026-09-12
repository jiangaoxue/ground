// ============================================================
// runtime.mjs — one kernel per process, and every door through it.
//
// The old wiring had a hole that made "built on SharedOS" a partial
// truth: the HTTP kernel route (/check, /extract, …) ran kernel turns,
// but the MCP door — the one advertised in agent-card.json, the one
// agents are told to call — dispatched straight to the engine. Its own
// header said "Nothing here talks to SharedOS." A buyer using the front
// door got no grant check, no re-authorization, and left no trace in
// the audit chain. The official check is the audit trail: "if your
// turns aren't there, it isn't built on SharedOS." The main entrance
// was invisible to it.
//
// This module is the fix: the kernel is built exactly once per process,
// every ground.* tool is registered in it, and the MCP door is armed so
// every tools/call — HTTP or stdio — runs as a kernel turn. There is no
// door into this product that bypasses the kernel anymore.
// ============================================================

import { buildKernel } from "./kernel.mjs";
import { createGroundTools } from "./ground-tools.mjs";
import { createKernelRoute } from "./kernel-route.mjs";
import { agents, owner, PURPOSE } from "./policy.mjs";
import { setKernelRunner } from "./mcp-protocol.mjs";

const { kernel } = buildKernel({ auditPath: "audit/audit.jsonl" });
for (const t of createGroundTools()) kernel.registerTool(t);

/** One paid call = one kernel turn. Used by the HTTP kernel route and the tests. */
export const runTool = createKernelRoute({ kernel, agents, owner, PURPOSE });

// Arm the MCP door: every ground.* tools/call now executes as a kernel
// turn — authority resolved, grant checked, tool invoked, all audited.
setKernelRunner(runTool);

export { kernel };
