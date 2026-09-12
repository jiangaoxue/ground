// ============================================================
// test/kernel.test.mjs — every sold service must survive the kernel.
//
// The kernel does not validate JSON Schema: it requires
// parseArguments() to return plain JSON, and one `undefined` anywhere
// in that object fails the whole call as invalid_tool_arguments. That
// trap cost us the extract route once, so it is now a test.
//
// It also proves default-deny: an agent with no grant does not even
// see the tool in its catalogue.
//
//   MODEL_API_KEY=… node test/kernel.test.mjs
// ============================================================

import { randomUUID } from "node:crypto";
import { SharedOSExecutor, StandardRuntime } from "@aicoo/sharedos";
import { buildKernel } from "../src/kernel.mjs";
import { createGroundTools } from "../src/ground-tools.mjs";
import { agents, owner, PURPOSE } from "../src/policy.mjs";

const { kernel } = buildKernel({ auditPath: "audit/_kernel_test.jsonl" });
for (const t of createGroundTools()) kernel.registerTool(t);

const checks = [];
const assert = (name, ok, detail = "") => {
  checks.push({ name, ok: Boolean(ok) });
  process.stderr.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
};

function contextFor(actor, toolNamespaces = ["ground", "files"]) {
  return {
    namespaceId: "ground",
    actor,
    authority: owner,
    owner,
    purpose: PURPOSE,
    traceId: randomUUID(),
    enabledToolNamespaces: toolNamespaces,
    now: new Date().toISOString(),
  };
}

/** Run one kernel turn that calls `tool` once, and return the tool result. */
async function callThroughKernel(tool, args, context) {
  let step = 0;
  let result = null;
  const driver = {
    async open() {
      return {
        async next(input) {
          if (input?.type === "tool_result") result = input.result;
          step += 1;
          if (step === 1) {
            return {
              type: "tool_call",
              call: { id: randomUUID(), tool, arguments: args, traceId: context.traceId, requestedAt: new Date().toISOString() },
            };
          }
          return { type: "complete", output: { done: true } };
        },
      };
    },
  };
  const tools = await kernel.listTools(context);
  await new SharedOSExecutor(kernel, new StandardRuntime(driver), {
    defaultMaxSteps: 6,
    defaultMaxToolCalls: 4,
    defaultTimeoutMs: 150_000,
  }).execute({
    version: "1",
    executionId: randomUUID(),
    agent: context.actor,
    context,
    message: {
      version: "1",
      id: randomUUID(),
      sender: { kind: "agent", agentId: "test" },
      receiver: context.actor,
      purpose: PURPOSE,
      payload: { text: "test" },
      traceId: context.traceId,
      createdAt: new Date().toISOString(),
    },
    tools: [...tools],
  });
  return { result, tools };
}

const ctx = contextFor(agents.probe);

// The catalogue is what the agent is allowed to advertise.
const { tools } = await callThroughKernel("ground.selfcheck", {}, ctx);
const names = tools.filter((t) => t.namespace === "ground").map((t) => t.name).sort();
const expected = ["ground.attest", "ground.batch", "ground.certify", "ground.check", "ground.extract", "ground.selfcheck"];
assert("catalogue lists exactly the six sold services", JSON.stringify(names) === JSON.stringify(expected), names.join(", "));

const URL = "https://example.com";
const CASES = [
  ["ground.selfcheck", {}],
  ["ground.check", { url: URL, statement: "This page is titled Example Domain." }],
  // no `hint` on purpose: this is the case that used to fail as invalid_tool_arguments
  ["ground.extract", { url: URL, fields: [{ name: "heading" }] }],
  ["ground.batch", { items: [{ url: URL, fields: [{ name: "heading" }] }] }],
  ["ground.attest", { claims: [{ statement: "This page is titled Example Domain.", url: URL }] }],
  ["ground.certify", { sources: [{ url: URL, fields: [{ name: "heading" }] }] }],
];

/** Anywhere a receipt can carry the hash of what was actually read. */
function hashesIn(out) {
  if (!out) return [];
  const found = [
    out.source?.text_sha256,
    out.check?.source?.text_sha256,
    out.extract?.source?.text_sha256,
    out.attestation?.packet_sha256,
    out.certification?.packet_sha256,
  ];
  for (const r of out.results || []) found.push(r?.source?.text_sha256);
  return found.filter((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h));
}

for (const [tool, args] of CASES) {
  const { result } = await callThroughKernel(tool, args, ctx);
  const out = result?.output;
  assert(`${tool} survives the kernel`, result?.status === "succeeded" && out?.ok === true, result?.reason || result?.status);
  assert(
    `${tool} returns a sha256 of what was actually read`,
    hashesIn(out).length > 0,
    Object.keys(out || {}).slice(0, 6).join(",")
  );
}

// Default deny: this actor has no grant at all, so the catalogue must be empty
// and the call must never be served.
const stranger = { kind: "agent", agentId: "unrelated-agent" };
const { tools: strangerTools, result: strangerResult } = await callThroughKernel(
  "ground.check",
  { url: URL, statement: "x" },
  contextFor(stranger)
);
assert("an ungranted agent sees no ground tools", strangerTools.filter((t) => t.namespace === "ground").length === 0, `saw ${strangerTools.length} tools`);
assert(
  "an ungranted agent's call is refused, not served",
  strangerResult === null || strangerResult.status === "failed",
  String(strangerResult?.reason || strangerResult?.status || "never served")
);

const failed = checks.filter((c) => !c.ok);
process.stderr.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
process.exit(failed.length ? 1 : 0);
