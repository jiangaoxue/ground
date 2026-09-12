// serve.mjs —— 本机接单入口：把内核里的 ground.check / ground.extract 包成 HTTP。
//
// 设计：Arena 房间里我们的 agent 收到买家请求后调这里；这里跑一个真真正正的
// 内核 turn（授权检查 → 工具执行 → 审计落盘），把回执返回给 agent。
//
// 安全：只绑 127.0.0.1，不开公网端口、不建隧道。外部世界只能通过 SharedNet
// 房间里的 agent 消息触达我们——纯出站架构。
//
// 用法：MODEL_API_KEY=... node src/serve.mjs   （默认 127.0.0.1:8081）
// 接口：POST /check | /receipt   {"url","statement"}
//       POST /extract            {"url","fields":[…]}
//       POST /batch              {"items":[…]}
//       POST /attest             {"claims":[…]}
//       POST /certify            {"sources":[…],"claims":[…]}
//       POST /selfcheck          {}                      （免费）
//       GET  /health
// 每条路由都映射到内核里的一个工具，都过 grants 与审计链。
// 对外的 MCP 接入面见 src/mcp-protocol.mjs 与 api/mcp.mjs。

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { SharedOSExecutor, StandardRuntime } from "@aicoo/sharedos";
import { buildKernel } from "./kernel.mjs";
import { createGroundTools } from "./ground-tools.mjs";
import { agents, owner, PURPOSE } from "./policy.mjs";

const PORT = Number(process.env.PORT || 8081);
const HOST = "127.0.0.1";

const { kernel } = buildKernel({ auditPath: "audit/audit.jsonl" });
for (const t of createGroundTools()) kernel.registerTool(t);

/** 跑一个内核 turn 去执行指定工具，返回该工具的原始输出。 */
async function runTool(tool, args, requestedBy = "arena-buyer") {
  const traceId = randomUUID();
  const context = {
    namespaceId: "ground",
    actor: agents.probe,
    authority: owner,
    owner,
    purpose: PURPOSE,
    traceId,
    enabledToolNamespaces: ["ground", "files"], // 实测：只写 ground 时目录为空
    now: new Date().toISOString(),
  };

  let captured = null;
  let step = 0;
  const driver = {
    async open() {
      return {
        async next(input) {
          if (input?.type === "tool_result") {
            const out = input.result?.output;
            if (out && typeof out === "object") captured = out;
          }
          step += 1;
          if (step === 1) {
            return {
              type: "tool_call",
              call: {
                id: randomUUID(),
                tool,
                arguments: args,
                traceId,
                requestedAt: new Date().toISOString(),
              },
            };
          }
          return { type: "complete", output: { done: true } };
        },
      };
    },
  };

  const tools = await kernel.listTools(context);
  const turn = await new SharedOSExecutor(kernel, new StandardRuntime(driver), {
    defaultMaxSteps: 6,
    defaultMaxToolCalls: 4,
    defaultTimeoutMs: 150_000,
  }).execute({
    version: "1",
    executionId: randomUUID(),
    agent: agents.probe,
    context,
    message: {
      version: "1",
      id: randomUUID(),
      sender: { kind: "agent", agentId: requestedBy },
      receiver: agents.probe,
      purpose: PURPOSE,
      payload: { text: `${tool} ${JSON.stringify(args).slice(0, 200)}` },
      traceId,
      createdAt: new Date().toISOString(),
    },
    tools: [...tools],
  });

  if (!captured) return { ok: false, error: "no_result", turn_status: turn.status, trace_id: traceId };
  return { ...captured, trace_id: traceId };
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

const server = createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && req.url === "/health") {
    return send(200, { ok: true, service: "ground", purpose: PURPOSE, agent: agents.probe });
  }

  const ROUTES = {
    "/receipt": "ground.check",
    "/check": "ground.check",
    "/extract": "ground.extract",
    "/batch": "ground.batch",
    "/attest": "ground.attest",
    "/certify": "ground.certify",
    "/selfcheck": "ground.selfcheck",
  };
  const tool = req.method === "POST" ? ROUTES[String(req.url).split("?")[0]] : null;
  if (!tool) return send(404, { ok: false, error: "not found" });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(400, { ok: false, error: "invalid_json" });
  }

  const requestedBy = String(body.requested_by || "arena-buyer");
  delete body.requested_by;

  try {
    const out = await runTool(tool, body, requestedBy);
    return send(out.ok ? 200 : 502, out);
  } catch (error) {
    return send(500, { ok: false, error: String(error?.message || error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ground service on http://${HOST}:${PORT}`);
  console.log(`  POST /receipt | /check  {"url","statement"}      3 credits`);
  console.log(`  POST /extract           {"url","fields":[…]}     5 credits`);
  console.log(`  POST /batch             {"items":[…]}          10 credits`);
  console.log(`  POST /attest            {"claims":[…]}         15 credits`);
  console.log(`  POST /certify           {"sources":[…],"claims":[…]}`);
  console.log(`  POST /selfcheck         {}                      FREE`);
  console.log(`  GET  /health`);
});
