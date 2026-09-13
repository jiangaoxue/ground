// ============================================================
// proof.js — ground.proof: the empirical capability audit.
//
// What it is: the only service in this market that TESTS a seller's
// claims instead of grading its prose. Yuzu scores how checkable a
// listing reads; this pokes the endpoint itself.
//
// Everything here is deterministic — no model in the loop, so the
// same endpoint measures the same way for every buyer:
//   1. REACH the advertised URL three times; measure latency.
//   2. PARSE what it serves (agent-card / catalog / MCP tools/list).
//   3. CROSS-CHECK the listing's own words against what was measured:
//      tools it names vs tools it actually exposes, prices it states
//      vs prices its catalog states, latency it promises vs latency
//      we measured, "free" tiers vs a priced inventory.
//
// Every finding carries the measurement that produced it. A finding
// that quotes nothing measurable is not shipped.
// ============================================================

import { fetchPage } from './page.js';

const MCP_TIMEOUT_MS = 15000;

async function timedFetch(url, { method = 'GET', body = null, headers = {}, timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, body, headers, signal: ctrl.signal, redirect: 'follow' });
    const ms = Date.now() - t0;
    let text = '';
    if (method === 'GET') {
      const buf = await res.arrayBuffer();
      if (buf.byteLength <= 2_000_000) text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    }
    return { ok: res.ok, status: res.status, ms, contentType: res.headers.get('content-type') || '', text };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, contentType: '', text: '', error: String(e?.cause?.code || e?.message || e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Try MCP tools/list against a URL. Returns inventory or null. */
async function mcpInventory(url) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const r = await timedFetch(url, {
    method: 'POST', body, timeoutMs: MCP_TIMEOUT_MS,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  });
  if (!r.ok || !r.text) return null;
  let payload = r.text.trim();
  if (payload.startsWith('event:')) { // SSE framing — take the data line
    const line = payload.split('\n').find((l) => l.startsWith('data:'));
    payload = line ? line.slice(5).trim() : '';
  }
  try {
    const j = JSON.parse(payload);
    const tools = j?.result?.tools;
    if (Array.isArray(tools)) {
      return {
        via: 'mcp_tools_list',
        tools: tools.map((t) => ({
          name: String(t?.name || '').slice(0, 80),
          description: String(t?.description || '').slice(0, 200),
        })),
        ms: r.ms,
      };
    }
  } catch { /* not MCP */ }
  return null;
}

/** Extract a service/tool inventory from a discovery document. */
function inventoryFromJson(j) {
  const inv = [];
  const push = (name, credits) => {
    const n = String(name || '').trim();
    if (n) inv.push({ name: n.slice(0, 80), credits: credits === null || credits === undefined ? null : Number(credits) });
  };
  for (const s of j?.services || []) push(s?.name || s?.tool, s?.credits);
  for (const s of j?.free || []) push(s?.name || s?.tool, 0);
  for (const s of j?.tools || []) push(typeof s === 'string' ? s : s?.name, typeof s === 'object' ? s?.credits : null);
  if (Array.isArray(j?.capabilities)) for (const c of j.capabilities) push(typeof c === 'string' ? c : c?.name, null);
  for (const [k, v] of Object.entries(j?.tools || {})) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) push(k, v?.credits ?? null);
  }
  const seen = new Set();
  return inv.filter((x) => (seen.has(x.name) ? false : (seen.add(x.name), true)));
}

// Deterministic claim extraction from listing prose.
const CLAIM_RE = {
  dotted_name: /([a-z][a-z0-9_]{1,30}[._][a-z0-9_.]{1,40})/gi,
  price: /([a-z][a-z0-9_.]{1,40})\s+(?:for\s+)?(\d[\d,]*)\s*credits?/gi,
  latency: /(?:under|within|<|less than)\s*(\d[\d,]*)\s*(ms|milliseconds|s|seconds?)/gi,
  free: /\bfree\b/gi,
};

function checkListingAgainstReality(listing, reality) {
  const findings = [];
  const add = (code, severity, statement, evidence) =>
    findings.push({ code, severity, statement: String(statement).slice(0, 220), evidence: String(evidence).slice(0, 220) });
  const inv = reality.inventory; // [{name, credits}]
  const invNames = new Set(inv.map((x) => x.name.toLowerCase()));

  if (listing) {
    // 1. Dotted tool/service names the listing names must be exposed.
    const named = new Set();
    for (const m of listing.matchAll(CLAIM_RE.dotted_name)) {
      const n = m[1].toLowerCase().replace(/\.$/, '');
      if (n.length > 4 && !/^https?$/.test(n.split(/[._]/)[0])) named.add(n);
    }
    for (const n of named) {
      const hit = [...invNames].some((x) => x === n || x.includes(n) || n.includes(x));
      if (invNames.size > 0 && !hit) {
        add('NAMED_CAPABILITY_NOT_LISTED', 'high',
          `The listing names "${n}", but the endpoint's own discovery document exposes: ${inv.map((x) => x.name).join(', ').slice(0, 160) || '(nothing parseable)'}.`,
          `listing says "${n}"; discovery exposes ${invNames.size} capabilities, none matching`);
      }
    }

    // 2. Priced services: does the catalog agree?
    for (const m of listing.matchAll(CLAIM_RE.price)) {
      const name = m[1].toLowerCase();
      const claimed = Number(m[2].replace(/,/g, ''));
      const actual = inv.find((x) => x.name.toLowerCase().includes(name) || name.includes(x.name.toLowerCase()));
      if (actual && actual.credits !== null && !Number.isNaN(actual.credits) && actual.credits !== claimed) {
        add('PRICE_MISMATCH', 'critical',
          `The listing prices ${m[1]} at ${claimed} credits; the endpoint's own catalog says ${actual.credits}.`,
          `listing "${claimed}" vs catalog "${actual.credits}"`);
      }
    }

    // 3. Latency promises vs measured.
    for (const m of listing.matchAll(CLAIM_RE.latency)) {
      const n = Number(m[1].replace(/,/g, ''));
      const promisedMs = /^m/i.test(m[2]) ? n : n * 1000;
      const p50 = reality.latency_ms.p50;
      if (p50 !== null && p50 > promisedMs) {
        add('LATENCY_CLAIM_FAILED', 'high',
          `The listing promises responses ${m.input.replace(/^\s*(?:under|within|<|less than)\s*/i, '')}, but this probe measured p50 ${p50}ms over ${reality.latency_ms.probes} requests.`,
          `promised <=${promisedMs}ms; measured p50=${p50}ms`);
      } else if (p50 !== null) {
        add('LATENCY_CLAIM_HELD', 'info',
          `Latency promise verified: measured p50 ${p50}ms against a promise of <=${promisedMs}ms.`,
          `measured p50=${p50}ms over ${reality.latency_ms.probes} probes`);
      }
    }

    // 4. "Free" claims vs a priced inventory.
    if (CLAIM_RE.free.test(listing) && inv.length > 0) {
      const freeCount = inv.filter((x) => x.credits === 0).length;
      if (freeCount === 0) {
        add('FREE_TIER_NOT_VISIBLE', 'medium',
          'The listing advertises a free tier, but the endpoint\'s own discovery document exposes no capability priced at 0 credits.',
          `inventory of ${inv.length} capabilities, 0 marked free`);
      } else {
        add('FREE_TIER_VERIFIED', 'info',
          `Free tier verified in the endpoint's own document: ${freeCount} of ${inv.length} capabilities priced at 0.`,
          `${freeCount}/${inv.length} free`);
      }
    }
  }
  return findings;
}

export async function proof(input) {
  const url = String(input?.url || '');
  const listing = input?.listing ? String(input.listing).slice(0, 4000) : null;
  if (!/^https?:\/\//i.test(url)) throw new Error('input.url (http/https) is required');

  // 1. Reach: three timed probes of the advertised address.
  const probes = [];
  for (let i = 0; i < 3; i++) {
    probes.push(await timedFetch(url, { timeoutMs: 20000 }));
    if (i < 2) await new Promise((r) => setTimeout(r, 250));
  }
  const good = probes.filter((p) => p.ok);
  const times = good.map((p) => p.ms).sort((a, b) => a - b);
  const reachable = good.length > 0;

  const base = {
    ok: true,
    service: 'ground.proof',
    target: { url, reachable, status: good[0]?.status ?? probes[0]?.status ?? null, content_type: good[0]?.contentType || null },
    latency_ms: {
      probes: probes.length, ok_probes: good.length,
      p50: percentile(times, 50), p100: times.length ? times[times.length - 1] : null,
      failures: probes.filter((p) => !p.ok).map((p) => p.error || `http_${p.status}`).slice(0, 3),
    },
    inventory: [],
    checks: [],
    checked_at: new Date().toISOString(),
    note: 'Every finding is a measurement taken during this call: probes against the advertised URL, its own discovery document, and the listing text it published. No model graded any prose. Re-run the same audit and the measurements will differ only as the target differs.',
  };

  if (!reachable) {
    base.checks.push({
      code: 'ENDPOINT_UNREACHABLE', severity: 'critical',
      statement: 'The advertised endpoint did not answer any of 3 probes. No capability claim in the listing can be considered tested.',
      evidence: probes.map((p) => p.error || `http_${p.status}`).join('; ').slice(0, 200),
    });
    base.verdict = 'unreachable';
    base.deliverable_line = `Endpoint unreachable on 3/3 probes — the listing was not tested, and that is the audit result.`;
    return base;
  }

  // 2. Parse its own words about itself (discovery document / catalog).
  let parsed = null;
  try { parsed = JSON.parse(good[0].text); } catch { /* not JSON */ }
  if (parsed && typeof parsed === 'object') {
    base.inventory = inventoryFromJson(parsed);
  }

  // 3. MCP tools/list — the capability surface another agent actually sees.
  //    Try the URL as given, then /mcp on the origin (a card URL and an MCP
  //    endpoint usually share the host but not the path).
  const candidates = [url];
  try {
    const o = new URL(url).origin + "/mcp";
    if (!candidates.includes(o)) candidates.push(o);
  } catch { /* unreachable above anyway */ }
  let mcp = null;
  for (const c of candidates) {
    mcp = await mcpInventory(c);
    if (mcp) break;
  }
  if (mcp) {
    for (const t of mcp.tools) if (!base.inventory.some((x) => x.name === t.name)) base.inventory.push({ name: t.name, credits: null });
    base.checks.push({
      code: 'MCP_SURFACE_LISTED', severity: 'info',
      statement: `MCP tools/list answered in ${mcp.ms}ms exposing ${mcp.tools.length} tool(s): ${mcp.tools.map((t) => t.name).join(', ').slice(0, 160)}.`,
      evidence: `tools/list -> ${mcp.tools.length} tools`,
    });
  } else {
    base.checks.push({
      code: 'MCP_NOT_DETECTED', severity: listing ? 'medium' : 'info',
      statement: 'No MCP tools/list answered at the probed address. If MCP access is advertised elsewhere, the probe could not confirm it here.',
      evidence: 'POST tools/list did not return a tool array',
    });
  }

  if (base.inventory.length > 0) {
    base.checks.push({
      code: 'DISCOVERY_PARSED', severity: 'info',
      statement: `The endpoint's own document exposes ${base.inventory.length} capabilit${base.inventory.length === 1 ? 'y' : 'ies'}: ${base.inventory.map((x) => `${x.name}${x.credits === null ? '' : `(${x.credits}cr)`}`).join(', ').slice(0, 300)}.`,
      evidence: 'parsed from the endpoint response',
    });
  } else {
    base.checks.push({
      code: 'NO_PARSEABLE_INVENTORY', severity: 'medium',
      statement: 'The endpoint answered but its response contains no parseable capability inventory (no services/tools block). A buyer cannot check prices or surface against it.',
      evidence: `content-type ${base.target.content_type || 'unknown'}`,
    });
  }

  // 4. Cross-check the listing's words against measured reality.
  if (listing) {
    base.checks.push(...checkListingAgainstReality(listing, { inventory: base.inventory, latency_ms: base.latency_ms }));
  } else {
    base.note += ' No listing text was supplied, so only the endpoint itself was audited — supply input.listing to cross-check its claims.';
  }

  // 5. Verdict: how many checks HELD vs failed, among checkable ones.
  const failed = base.checks.filter((c) => /_NOT_LISTED|_MISMATCH|_FAILED|_NOT_VISIBLE|UNREACHABLE|NOT_DETECTED|NO_PARSEABLE/.test(c.code) && c.severity !== 'info');
  const held = base.checks.filter((c) => /_HELD|_VERIFIED|_LISTED|_PARSED/.test(c.code));
  base.verdict = failed.length === 0 ? 'held' : held.length > 0 ? 'partial' : 'failed';
  base.summary = {
    checks: base.checks.length,
    held: held.length,
    failed: failed.length,
    critical: base.checks.filter((c) => c.severity === 'critical').length,
  };
  base.deliverable_line =
    `Empirical audit of ${url}: reachable ${good.length}/3 probes, p50 ${base.latency_ms.p50}ms, ` +
    `${base.inventory.length} capabilities exposed, ${held.length} claim(s) verified, ${failed.length} failed. ` +
    `Verdict: ${base.verdict}.`;
  return base;
}
