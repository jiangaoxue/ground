// ============================================================
// api/stats.mjs — GET /stats  (free, no model call)
//
// Buyers kept asking for the same thing in testing: a track record.
// We have one — this deployment's own kernel audit chain — so we
// publish it instead of claiming reliability in prose. Every number
// here is computed from audit/audit.jsonl, and any trace behind the
// aggregate can be opened at /audit?trace=<id>.
// ============================================================
import { readFile, stat } from "node:fs/promises";

const AUDIT_PATH = "audit/audit.jsonl";
const PAID_TOOLS = new Set([
  "ground.check", "ground.extract", "ground.batch", "ground.attest", "ground.certify", "ground.selfcheck",
]);

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export default async function statsHandler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "GET only" }));
  }
  let raw = "";
  try { raw = await readFile(AUDIT_PATH, "utf8"); } catch { /* fresh deployment: no turns yet */ }
  const traces = new Map();
  let grantChecks = 0, denials = 0, records = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    records++;
    const tid = r.traceId;
    if (!tid) continue;
    let t = traces.get(tid);
    if (!t) { t = { first: null, last: null, tools: [], ended: false }; traces.set(tid, t); }
    const at = r.at ? Date.parse(r.at) : null;
    if (at) { if (t.first === null || at < t.first) t.first = at; if (t.last === null || at > t.last) t.last = at; }
    if (r.type === "authorization.check" || r.type === "authorization.checked") {
      grantChecks++;
      if ((r.outcome || "") !== "allowed") denials++;
    }
    if (r.type === "tool.invoked" && PAID_TOOLS.has(r.tool)) t.tools.push({ tool: r.tool, outcome: r.outcome || "unknown" });
    if (r.type === "turn.ended") t.ended = true;
  }

  const perTool = {};
  const turns = [];
  let toolTurns = 0;
  for (const t of traces.values()) {
    if (!t.tools.length) continue;
    toolTurns++;
    for (const inv of t.tools) {
      const e = (perTool[inv.tool] ||= { calls: 0, succeeded: 0, failed: 0 });
      e.calls++;
      if (inv.outcome === "succeeded") e.succeeded++; else e.failed++;
    }
    if (t.first !== null && t.last !== null) turns.push(Math.max(0, t.last - t.first));
  }
  turns.sort((a, b) => a - b);

  const body = {
    service: "ground",
    what: "track record, computed from this deployment's own kernel audit chain — not a claim, a measurement. Open any individual turn at /audit?trace=<id>.",
    generated_at: new Date().toISOString(),
    kernel_turns_with_tool_calls: toolTurns,
    grant_checks: grantChecks,
    denials,
    latency_ms: { p50: pct(turns, 50), p90: pct(turns, 90), max: turns.length ? turns[turns.length - 1] : null, note: "audit-chain first→last event per turn; includes the upstream fetch, so it is the honest end-to-end number" },
    tools: perTool,
    audit_records: records,
  };

  const accept = String(req.headers.accept || "");
  if (accept.includes("text/html")) {
    const rows = Object.entries(perTool).map(([t, e]) =>
      `<tr><td>${t}</td><td>${e.calls}</td><td>${e.succeeded}</td><td>${e.failed}</td></tr>`).join("");
    const html = `<!doctype html><meta charset="utf-8"><title>Ground — track record</title>
<body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px;color:#111;background:#fff">
<h1>Ground — track record</h1>
<p>Computed from this deployment's own kernel audit chain. Every aggregate below is backed by
individual turns you can open at <code>/audit?trace=&lt;id&gt;</code>.</p>
<ul>
<li>Kernel turns that called a tool: <b>${toolTurns}</b></li>
<li>Grant checks: <b>${grantChecks}</b> (denials: ${denials})</li>
<li>End-to-end latency: p50 <b>${body.latency_ms.p50 ?? "-"}ms</b> · p90 <b>${body.latency_ms.p90 ?? "-"}ms</b> · max <b>${body.latency_ms.max ?? "-"}ms</b></li>
</ul>
<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>tool</th><th>calls</th><th>succeeded</th><th>failed</th></tr>${rows}</table>
<p style="color:#555">Machine copy: add <code>Accept: application/json</code> or fetch this URL with <code>?format=json</code>.</p>
</body>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(html);
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body, null, 1));
}
