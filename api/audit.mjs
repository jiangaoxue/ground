// ============================================================
// api/audit.mjs — GET /audit?trace=<traceId>
//
// The buyer-visible half of "built on SharedOS".
//
// The official check is the audit trail: "if your turns aren't there,
// it isn't built on SharedOS." Until now the kernel kept those records
// in a file only we could read — which means the buyer had to take our
// word for it. That is the one thing this product never asks for.
//
// So the kernel's own records are a free endpoint. Every paid answer
// carries audit.trace_id; this endpoint returns the kernel's decisions
// for that turn: the authority that was resolved, the grant that was
// checked, the tool that was invoked, the outcome. Records come from
// the audit chain, not from the product: we cannot edit them without
// breaking the chain of custody the judges already hold.
//
//   GET /audit?trace=<trace_id>                JSON, for machines
//   GET /audit?trace=<trace_id>&format=html    a page a human can read
//
// Free, and deliberately so: charging to see the proof would make the
// proof worthless.
// ============================================================

import { readFileSync, existsSync } from 'node:fs';

const AUDIT_PATH = new URL('../audit/audit.jsonl', import.meta.url);

const WHAT = {
  'authority.resolved': 'the kernel re-loaded the grant table for this actor from trusted storage',
  'tool.catalog.listed': 'the kernel listed the tools this actor is allowed to discover',
  'authorization.check': 'the grant for the requested capability was checked before the call ran',
  'authorization.checked': 'the grant for the requested capability was checked before the call ran',
  'tool.invoked': 'the tool ran (or was refused) under that grant',
  'turn.ended': 'the kernel turn finished and was appended to the audit chain',
};

const GRANT_CHECK = new Set(['authorization.check', 'authorization.checked']);

function loadRecords(traceId) {
  if (!existsSync(AUDIT_PATH)) return [];
  const out = [];
  for (const line of String(readFileSync(AUDIT_PATH, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.traceId !== traceId) continue;
    out.push({
      at: e.at,
      type: e.type,
      what: WHAT[e.type] || null,
      tool: e.tool || null,
      outcome: e.outcome ?? null,
      reason: e.reason || null,
      actor: e.actor?.agentId || null,
      namespace: e.namespaceId || null,
      purpose: e.purpose || null,
    });
  }
  return out;
}

function turnSummary(records) {
  const invoked = records.filter((r) => r.type === 'tool.invoked');
  const ended = records.filter((r) => r.type === 'turn.ended').at(-1);
  return {
    tools_invoked: invoked.map((r) => r.tool).filter(Boolean),
    tool_outcome: invoked.at(-1)?.outcome || null,
    turn_outcome: ended?.outcome || null,
    grant_checks: records.filter((r) => GRANT_CHECK.has(r.type)).length,
  };
}

export default function handler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const traceId = url.searchParams.get('trace') || '';
  const asHtml = url.searchParams.get('format') === 'html';

  res.setHeader('access-control-allow-origin', '*');

  if (!traceId) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.end(
      JSON.stringify({
        ok: false,
        error: 'missing ?trace= — every paid answer carries audit.trace_id; pass it here',
      })
    );
  }

  const records = loadRecords(traceId);
  const body = {
    ok: true,
    trace_id: traceId,
    found: records.length > 0,
    turn: turnSummary(records),
    records,
    note:
      'These records were written by the SharedOS kernel as the turn ran — not by the product after the fact. Ground cannot show you a turn that never happened, and the same trace id is in the audit chain the organizers hold.',
  };

  if (asHtml) {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(renderAuditHtml(body));
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(body, null, 2));
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderAuditHtml(body) {
  const rows = body.records
    .map(
      (r) =>
        `<tr><td style="padding:6px 14px 6px 0;white-space:nowrap;color:#6b7280;font-size:13px">${esc(r.at)}</td>` +
        `<td style="padding:6px 14px 6px 0;font-weight:600;white-space:nowrap">${esc(r.type)}</td>` +
        `<td style="padding:6px 0;color:#374151">${esc([r.tool, r.outcome, r.reason].filter(Boolean).join(' · ') || '—')}</td></tr>`
    )
    .join('');
  const table = rows
    ? `<table style="border-collapse:collapse;font-size:14px">${rows}</table>`
    : `<p style="color:#92400e">No records found for this trace id. Either the id is wrong, or the turn predates this audit file.</p>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Ground — kernel audit chain</title></head>
<body style="margin:0;background:#fff;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif">
<main style="max-width:860px;margin:0 auto;padding:40px 24px 80px;color:#111827;line-height:1.55">
<header style="border-bottom:2px solid #111827;padding-bottom:14px">
  <div style="font-size:22px;font-weight:700">Ground — SharedOS kernel audit chain</div>
  <div style="color:#6b7280;margin-top:4px">trace ${esc(body.trace_id)} · ${body.records.length} record${body.records.length === 1 ? '' : 's'}</div>
</header>
<p style="margin-top:20px">This turn was executed by the SharedOS kernel running inside Ground. Each line below was appended by the kernel as the turn ran — authority resolved, grant checked, tool invoked — before the answer was allowed to exist. It is the kernel's own record, not the product's claim about itself.</p>
${table}
<p style="margin-top:24px;color:#6b7280;font-size:13px">Check it yourself: the same trace id appears in the audit chain the organizers hold. If the two ever disagree, that is the story.</p>
</main></body></html>`;
}
