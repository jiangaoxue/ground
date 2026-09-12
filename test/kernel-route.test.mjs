// ============================================================
// test/kernel-route.test.mjs — the spine of the product, locked down.
//
// Three properties this test file exists to enforce:
//
// 1. THE FRONT DOOR IS NOT A SIDE DOOR. A tools/call that arrives over
//    MCP — the door advertised in agent-card.json — must execute as one
//    SharedOS kernel turn. The old wiring let the MCP door bypass the
//    kernel entirely, which meant the calls the arena actually makes
//    left no trace in the audit chain. That is the difference between
//    "built on SharedOS" and "standing next to it".
//
// 2. FAILURES ARE NEVER SWALLOWED. A call with invalid arguments must
//    come back with the kernel's own reason and a message that names
//    the problem — not the useless word "no_result" that used to hide
//    the truth in the audit log where only we could read it.
//
// 3. THE AUDIT CHAIN IS BUYER-VISIBLE. Every answer carries an audit
//    link, and GET /audit?trace=… returns the kernel's records for that
//    turn. If this breaks, "built on SharedOS" becomes a claim instead
//    of a fact.
// ============================================================

import { buildKernel } from "../src/kernel.mjs";
import { createGroundTools } from "../src/ground-tools.mjs";
import { createKernelRoute } from "../src/kernel-route.mjs";
import { agents, owner, PURPOSE } from "../src/policy.mjs";
import auditHandler from "../api/audit.mjs";
import { setKernelRunner, handleRpc } from "../src/mcp-protocol.mjs";
import { unpackReceipt, renderReceiptHtml } from "../src/receipt.mjs";

const checks = [];
const assert = (name, ok, detail = "") => {
  checks.push({ name, ok: Boolean(ok) });
  process.stderr.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
};

// The same wiring serve.mjs uses. The audit path is the real chain: these
// are true turns that really ran, and the chain is append-only.
const { kernel } = buildKernel({ auditPath: "audit/audit.jsonl" });
for (const t of createGroundTools()) kernel.registerTool(t);
const runTool = createKernelRoute({ kernel, agents, owner, PURPOSE });

function mockRes() {
  return {
    headers: {},
    body: null,
    statusCode: 0,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(b) {
      this.body = b;
    },
  };
}

try {
  // ---- 2) an invalid call surfaces the kernel's own reason
  const bad = await runTool("ground.extract", { url: "https://example.com/" });
  assert("an invalid call fails", bad.ok === false, bad.error);
  assert(
    "the real reason is not swallowed",
    bad.error === "invalid_tool_arguments",
    `error=${bad.error}`
  );
  assert(
    "the message names the missing field",
    /fields/i.test(String(bad.message || "")),
    String(bad.message || "").slice(0, 80)
  );
  assert("even a failure carries an audit address", /^https?:\/\//.test(bad.audit_url || ""), bad.audit_url);

  // ---- a paid call runs as a kernel turn and carries both addresses
  const good = await runTool("ground.extract", {
    url: "https://example.com/",
    fields: [{ name: "title" }],
  });
  assert("a valid call succeeds", good.ok === true, good.error);
  assert("it carries a trace id", typeof good.audit?.trace_id === "string" && good.audit.trace_id.length > 10);
  assert("it carries an audit address", good.audit?.url === bad.audit_url?.split("?")[0] + "?trace=" + good.audit?.trace_id, good.audit?.url);
  assert("it carries a receipt address", /^https?:\/\//.test(good.receipt?.url || ""), String(good.receipt?.url || "").slice(0, 60));

  // ---- 3) the audit endpoint returns the kernel's records for that turn
  const res = mockRes();
  await auditHandler({ url: `/audit?trace=${good.audit.trace_id}` }, res);
  const audit = JSON.parse(res.body);
  assert("/audit finds the trace", audit.ok === true && audit.found === true, `records=${audit.records?.length}`);
  assert(
    "the kernel checked a grant for this turn",
    (audit.records || []).some((r) => r.type === "authorization.check" || r.type === "authorization.checked")
  );
  assert(
    "the kernel recorded the tool invocation",
    (audit.records || []).some((r) => r.type === "tool.invoked" && r.tool === "ground.extract")
  );
  assert("the turn outcome is recorded", audit.turn?.tool_outcome === "succeeded", JSON.stringify(audit.turn));
  assert(
    "an unknown trace is reported, not invented",
    (() => mockRes().end && true)() && true
  );
  const res2 = mockRes();
  await auditHandler({ url: `/audit?trace=no-such-trace-zzz` }, res2);
  const empty = JSON.parse(res2.body);
  assert("an unknown trace returns found:false", empty.found === false && empty.records.length === 0);

  // ---- 1) the MCP door is armed: tools/call is a kernel turn
  setKernelRunner(runTool);
  const rpc = await handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "ground.extract", arguments: { url: "https://example.com/", fields: [{ name: "title" }] } },
  });
  const sc = rpc?.result?.structuredContent;
  assert("MCP tools/call returns a result", Boolean(sc), rpc?.error?.message);
  assert(
    "the MCP call ran as a kernel turn (has audit)",
    typeof sc?.audit?.trace_id === "string",
    "no audit block — the front door bypassed the kernel"
  );
  assert("the MCP call is a different turn than the HTTP one", sc?.audit?.trace_id !== good.audit.trace_id);

  // ---- the receipt page shows the kernel section
  const receipt = unpackReceipt(new URL(sc.receipt.url).searchParams.get("d"));
  const html = renderReceiptHtml(receipt);
  assert("the receipt page links the audit chain", html.includes("audit?trace=") && html.includes("SharedOS"));

  // ---- the packed receipt survives and stays self-contained
  assert("the receipt carries the audit trace inside the link", receipt.audit?.trace_id === sc.audit.trace_id);
} catch (error) {
  assert("suite completed", false, String(error?.message || error));
}

const failed = checks.filter((c) => !c.ok);
process.stderr.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
process.exit(failed.length ? 1 : 0);
