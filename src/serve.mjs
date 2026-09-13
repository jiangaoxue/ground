// serve.mjs —— Ground 的 HTTP 门面。两种跑法，同一个文件。
//
// 1) 本机接单（Arena 用）：不设 PORT 时只绑 127.0.0.1，白名单在内网之外的
//    任何人都够不着。房里我们的 agent 收到买家请求后打这里，这里跑一个真真正正的
//    内核 turn（授权检查 → 工具执行 → 审计落盘）。
//
// 2) 公网托管（提交清单里的 "a runnable url"）：托管平台注入 PORT，此时绑 0.0.0.0
//    并通过反向代理对外。这不是"在这台机器上开端口"，本机那条 127.0.0.1 的边界不变。
//
// 用法：MODEL_API_KEY=... node src/serve.mjs              （本机，127.0.0.1:8081）
//       PORT=8080 MODEL_API_KEY=... node src/serve.mjs    （托管，0.0.0.0:8080）
//
// 路由
//   GET  /                  一页给人类看的说明（public/index.html）
//   GET  /health            存活 + 价目 + 模型是否就绪（免费，不调模型）
//   GET  /agent-card.json   发现文档：别的 agent 靠它找到接入方式
//   GET  /catalog.json      价目清单（机器可读）
//   GET  /mcp               MCP 发现信息
//   POST /mcp               MCP JSON-RPC：initialize / tools/list / tools/call
//   POST /check | /receipt  {"url","statement"}
//   POST /extract           {"url","fields":[…]}
//   POST /batch             {"items":[…]}
//   POST /attest            {"claims":[…]}
//   POST /certify           {"sources":[…],"claims":[…]}
//   POST /selfcheck         {}                              免费
//
// 每一条会调模型的路由都经过同一个当日上限（见 BUDGET），因为公网门面用的是
// 我们自己的模型密钥：没有上限，别人可以拿它当免费额度用。超限返回 429。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runTool } from "./runtime.mjs"; // builds the kernel, registers the tools, arms the MCP door
import mcpHandler from "../api/mcp.mjs";
import agentCardHandler from "../api/agent-card.mjs";
import catalogHandler from "../api/catalog.mjs";
import healthHandler from "../api/health.mjs";
import receiptHandler from "../api/receipt.mjs";
import auditHandler from "../api/audit.mjs";
import statsHandler from "../api/stats.mjs";

const PORT = Number(process.env.PORT || 8081);
// 本机跑（没注入 PORT）时宁可只绑回环；被托管时才对外。
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

// ---------------------------------------------------------------- 当日预算
//
// 一次回执 = 抓一个页面 + 一次模型调用。上限按 UTC 日重置，超了直接 429，
// 而不是让密钥在公网上被无限刷。
const BUDGET = {
  total: Number(process.env.PAID_CAP_PER_DAY || 300),
  perIp: Number(process.env.PAID_CAP_PER_IP_PER_DAY || 80),
};

const spend = {
  day: new Date().toISOString().slice(0, 10),
  total: 0,
  byIp: new Map(),
};

function charge(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== spend.day) {
    spend.day = today;
    spend.total = 0;
    spend.byIp.clear();
  }
  const used = spend.byIp.get(ip) || 0;
  if (spend.total >= BUDGET.total) {
    return { ok: false, reason: "daily_budget_reached", limit: BUDGET.total, scope: "service" };
  }
  if (used >= BUDGET.perIp) {
    return { ok: false, reason: "daily_budget_reached", limit: BUDGET.perIp, scope: "caller" };
  }
  spend.total += 1;
  spend.byIp.set(ip, used + 1);
  return { ok: true, used_today: spend.total, remaining_today: BUDGET.total - spend.total };
}

// 内核、工具注册与 MCP 门的武装都在 runtime.mjs（进程级单例）。

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

/** 这个 MCP 请求会不会真的烧一次模型调用？ */
function mcpIsBillable(body) {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m && m.method === "tools/call");
}

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || "unknown";
}

async function serveStatic(res, pathname) {
  const name = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return false;
  if (!/\.(html|css|js|json|txt|svg|png|ico)$/i.test(name)) return false;
  try {
    const file = await readFile(PUBLIC_DIR + name);
    const type = name.endsWith(".html")
      ? "text/html; charset=utf-8"
      : name.endsWith(".json")
        ? "application/json; charset=utf-8"
        : name.endsWith(".css")
          ? "text/css; charset=utf-8"
          : name.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : name.endsWith(".svg")
              ? "image/svg+xml"
              : name.endsWith(".txt")
                ? "text/plain; charset=utf-8"
                : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=60" });
    res.end(file);
    return true;
  } catch {
    return false;
  }
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

const server = createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  const pathname = String(req.url || "/").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id",
    });
    return res.end();
  }

  // ---- GET：发现文档与静态页，一律免费，不碰模型
  if (req.method === "GET") {
    if (pathname === "/health") return healthHandler(req, res);
    if (pathname === "/agent-card.json") return agentCardHandler(req, res);
    if (pathname === "/catalog.json") return catalogHandler(req, res);
    if (pathname === "/mcp") return mcpHandler(req, res);
    if (pathname === "/receipt") return receiptHandler(req, res);
    if (pathname === "/audit") return auditHandler(req, res);
    if (pathname === "/stats") return statsHandler(req, res);
    if (await serveStatic(res, pathname)) return;
    return send(404, { ok: false, error: "not found", hint: "see /agent-card.json" });
  }

  if (req.method !== "POST") return send(405, { ok: false, error: "use GET or POST" });

  // ---- POST /mcp：MCP 接入面
  if (pathname === "/mcp") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON body" } });
    }
    if (mcpIsBillable(body)) {
      const gate = charge(clientIp(req));
      if (!gate.ok) {
        return send(429, {
          jsonrpc: "2.0",
          id: (Array.isArray(body) ? body[0] : body)?.id ?? null,
          error: { code: -32000, message: `ground is over its budget for today (${gate.reason}, ${gate.scope} limit ${gate.limit}); try again tomorrow UTC` },
        });
      }
    }
    req.body = body;
    return mcpHandler(req, res);
  }

  // ---- POST：内核路径（授权 → 工具 → 审计）
  const tool = ROUTES[pathname];
  if (!tool) return send(404, { ok: false, error: "not found", hint: "see /agent-card.json" });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(400, { ok: false, error: "invalid_json" });
  }

  const gate = charge(clientIp(req));
  if (!gate.ok) {
    return send(429, {
      ok: false,
      error: gate.reason,
      scope: gate.scope,
      limit: gate.limit,
      hint: "daily cap on the shared model budget; resets at 00:00 UTC",
    });
  }

  const requestedBy = String(body.requested_by || "arena-buyer");
  delete body.requested_by;

  try {
    const out = await runTool(tool, body, requestedBy);
    return send(out.ok ? 200 : 502, { ...out, budget: gate });
  } catch (error) {
    return send(500, { ok: false, error: String(error?.message || error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ground service on http://${HOST}:${PORT}`);
  console.log(`  GET  /                     the one-page explainer`);
  console.log(`  GET  /health               liveness + price list (FREE, no model call)`);
  console.log(`  GET  /agent-card.json      discovery document for agents`);
  console.log(`  GET  /catalog.json         machine-readable price list`);
  console.log(`  GET  /receipt?d=…          a paid receipt, packed in the link (FREE)`);
  console.log(`  GET  /audit?trace=…        the kernel's own records for a turn (FREE)`);
  console.log(`  POST /mcp                  MCP JSON-RPC: initialize / tools/list / tools/call`);
  console.log(`  POST /check | /receipt     {"url","statement"}        3 credits`);
  console.log(`  POST /extract              {"url","fields":[…]}       5 credits`);
  console.log(`  POST /batch                {"items":[…]}             10 credits`);
  console.log(`  POST /attest               {"claims":[…]}            15 credits`);
  console.log(`  POST /certify              {"sources":[…],"claims":[…]} 25 credits`);
  console.log(`  POST /selfcheck            {}                         FREE`);
  console.log(`  budget: ${BUDGET.total}/day total, ${BUDGET.perIp}/day per caller`);
});
