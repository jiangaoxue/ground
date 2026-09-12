// service.mjs —— 比赛形状的端到端验证：
// 买家 agent 在内核里调用 ground.check（一次授权内、一次越权），审计链全程记录。
//
// 跑法：MODEL_API_KEY=sk-xxx node src/service.mjs
// 验证点：
//   ① ground.check 真的执行（真抓网页 + 真调模型 + 代码校验引文）
//   ② 有 grant 的 agent 能调通；越权 turn 被内核 denied
//   ③ 每一步都落 audit/audit.jsonl —— 这就是"built on SharedOS"的证据

import { randomUUID } from "node:crypto";
import { SharedOSExecutor, StandardRuntime } from "@aicoo/sharedos";
import { buildKernel } from "./kernel.mjs";
import { createGroundTools } from "./ground-tools.mjs";
import { agents, owner, PURPOSE } from "./policy.mjs";

const { kernel } = buildKernel({ auditPath: "audit/audit.jsonl" });

// 注册 Ground 服务工具（暴露 ≠ 授权）
for (const t of createGroundTools()) kernel.registerTool(t);

const BUYER_STATEMENT = "SharedOS is Apache-2.0 licensed.";
const BUYER_URL = "https://github.com/Aicoo-Team/SharedOS";

// —— 买家 agent：有 ground.check 的 grant ——
const buyerContext = {
  namespaceId: "ground",
  actor: agents.probe,
  authority: owner,
  owner,
  purpose: PURPOSE,
  traceId: randomUUID(),
  enabledToolNamespaces: ["ground", "files"],
  now: new Date().toISOString(),
};

const call = (tool, args) => ({
  id: randomUUID(),
  tool,
  arguments: args,
  traceId: buyerContext.traceId,
  requestedAt: new Date().toISOString(),
});

const buyerDriver = {
  async open() {
    let step = 0;
    return {
      async next(input) {
        step += 1;
        // 买家 Agent 收到的工具结果——就是它做购买决策依据的东西
        if (input?.type === "tool_result") {
          const out = input.result?.output;
          if (out?.service === "ground.check") {
            console.log("");
            console.log("=== 买家 Agent 收到的 ground.check 真实回执 ===");
            console.log("verdict :", out.verdict);
            console.log("quote   :", JSON.stringify(out.quote));
            console.log("source  :", out.source?.url, "| status", out.source?.status, "| sha256", String(out.source?.text_sha256).slice(0, 16) + "…", "|", out.source?.elapsed_ms + "ms");
          }
        }
        if (step === 1)
          return {
            type: "tool_call",
            call: call("ground.check", { url: BUYER_URL, statement: BUYER_STATEMENT }),
          };
        if (step === 2)
          // 故意越权：ground.attest 没给这个 agent —— 内核应直接拒
          return {
            type: "tool_call",
            call: call("ground.attest", { statement: "trying to attest without a grant" }),
          };
        return { type: "complete", output: { done: true } };
      },
    };
  },
};

console.log("买家 agent 调用 ground.check（内核内）…");
const tools = await kernel.listTools(buyerContext);
const result = await new SharedOSExecutor(kernel, new StandardRuntime(buyerDriver), {
  defaultMaxSteps: 8,
  defaultMaxToolCalls: 8,
  defaultTimeoutMs: 60_000,
}).execute({
  version: "1",
  executionId: randomUUID(),
  agent: agents.probe,
  context: buyerContext,
  message: {
    version: "1",
    id: randomUUID(),
    sender: { kind: "agent", agentId: "arena-buyer" },
    receiver: agents.probe,
    purpose: PURPOSE,
    payload: { text: `Verify this claim: "${BUYER_STATEMENT}" at ${BUYER_URL}` },
    traceId: buyerContext.traceId,
    createdAt: new Date().toISOString(),
  },
  tools: [...tools],
});

const turn = result;

console.log("");
console.log("turn 状态 :", turn.status);
console.log("事件链    :", turn.events.map((e) => e.type || e.status).join(" -> "));

// 从事件里抠出 ground.check 的真实输出
for (const e of turn.events) {
  const out = e?.result?.output || e?.output;
  if (out && out.service === "ground.check") {
    console.log("");
    console.log("=== ground.check 真实输出（内核内执行）===");
    console.log(JSON.stringify(out, null, 1).slice(0, 1600));
  }
}

console.log("");
console.log("=== 提交物字段 ===");
console.log("purpose string : " + PURPOSE);
console.log("namespace      : ground");
console.log("owner address  :", JSON.stringify(owner));
console.log("agent address  :", JSON.stringify(agents.probe));
console.log("");
console.log("审计链：audit/audit.jsonl —— 每条 turn/授权检查/工具执行都在里面");
