// run.mjs —— 让产品里的一个 agent 真的在内核里跑完一轮 turn，并打印合规要交的东西。
//
// 这一轮故意同时做三件事：一次允许、一次越权（必须被拒）、一次写入记忆。

import { SharedOSExecutor, StandardRuntime } from "@aicoo/sharedos";
import { buildKernel } from "./kernel.mjs";
import { PURPOSE, NAMESPACE, owner, agents, TREE } from "./policy.mjs";

const SEED = {
  "Work/probe/inbox/queue.txt": [
    "rom_2zmVfoyIf0 :: https://www.sharednet.ai/",
    "example.com :: https://example.com/",
  ].join("\n"),
  "Work/finance/payroll.csv": "name,amount\nCEO,999999\n",
};

const { kernel, files, audit, namespaceId } = buildKernel({ auditPath: "audit/audit.jsonl", seed: SEED });

const traceId = crypto.randomUUID();

const call = (tool, args) => ({
  id: crypto.randomUUID(),
  tool,
  arguments: args,
  traceId,
  requestedAt: new Date().toISOString(),
});

const context = {
  namespaceId,
  actor: agents.probe,
  authority: owner,
  owner,
  purpose: PURPOSE,
  traceId,
  enabledToolNamespaces: ["files", "sharedos"],
  now: new Date().toISOString(),
};

const visible = await kernel.listTools(context);
console.log("① 这个 agent 能看到的工具：", visible.map((t) => t.name).sort().join(", "));
console.log("   ↑ 只有 grant 覆盖到的才出现。finance 相关的一个都没有。\n");

// scripted driver —— 我们自己写的 loop
const driver = {
  async open() {
    let step = 0;
    return {
      async next() {
        step += 1;
        if (step === 1) return { type: "tool_call", call: call("files.search", { path: ["Work", "probe", "inbox"], query: "sharednet" }) };
        if (step === 2) return { type: "tool_call", call: call("files.read", { path: ["Work", "finance", "payroll.csv"] }) };
        if (step === 3) return { type: "tool_call", call: call("files.create", { path: ["Work", "probe", "out", "rom_2zmVfoyIf0.txt"], content: "probe ok\n" }) };
        if (step === 4) return { type: "tool_call", call: call("files.read", { path: ["Work", "finance", "payroll.csv"] }) };
        return { type: "complete", output: { steps: step - 1 } };
      },
    };
  },
};

const result = await new SharedOSExecutor(kernel, new StandardRuntime(driver), {
  defaultMaxSteps: 8,
  defaultMaxToolCalls: 8,
  defaultTimeoutMs: 30_000,
}).execute({
  version: "1",
  executionId: crypto.randomUUID(),
  agent: agents.probe,
  context,
  message: {
    version: "1",
    id: crypto.randomUUID(),
    sender: owner,
    receiver: agents.probe,
    purpose: PURPOSE,
    payload: { text: "probe the queued services" },
    traceId: context.traceId,
    createdAt: new Date().toISOString(),
  },
  tools: [...visible],
});

const denied = result.events.filter((e) => e.data?.status === "denied");

console.log("② turn 状态：", result.status);
console.log("③ 事件链：");
for (const e of result.events) {
  const d = e.data ?? {};
  const extra = d.status ? ` status=${d.status}${d.code ? ` code=${d.code}` : ""}` : "";
  console.log(`   ${String(e.sequence).padStart(2)} ${e.type.padEnd(16)} ${d.tool ?? ""}${extra}`);
}
console.log("");
console.log("④ 写在记忆里的文件：", Object.keys(files.snapshot()).sort().join(", "));
console.log("   finance 有没有被读到：", Object.values(files.events()).some((e) => e.path.startsWith("Work/finance")) ? "有（不该！）" : "没有 ✅");
console.log("");
console.log("⑤ 审计落地：", audit.path, "→", audit.count(), "条");
console.log("");

console.log("════════════ 提交时要交给主办方的两样东西 ════════════");
console.log("purpose string :", PURPOSE);
console.log("namespace / tenant:", NAMESPACE);
console.log("owner address  :", JSON.stringify(owner));
console.log("agent address  :", JSON.stringify(agents.probe));
console.log("agent address  :", JSON.stringify(agents.reporter));
console.log("══════════════════════════════════════════════════════");
console.log("");
console.log("文件树里没有任何一格给 Work/finance —— 默认拒绝：", TREE["Work/finance"]);
console.log("");
console.log("RESULT:", result.status === "succeeded" && denied.length >= 1 ? "PASS —— 内核跑通、越权被拒、审计落地" : `CHECK —— status=${result.status} denied=${denied.length}`);
