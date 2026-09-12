// ============================================================
// receipt.mjs — turn a receipt into a thing that has an address.
//
// The problem this solves: a receipt that exists only inside one response is
// not a deliverable. A buyer cannot cite it, attach it, or hand it to a human.
// It is a fee, not a product.
//
// So every paid answer comes back with `receipt_url`. The receipt travels in
// the URL itself (gzipped + base64url), which means:
//   * no server-side store, so it works on a stateless host and cannot 404;
//   * the address is immutable by construction — the same receipt always has
//     the same URL, and no one can edit it on the way;
//   * a third party can open it in a browser with nothing installed.
//
// Heavy fields (the fetched page text) are dropped before packing: the receipt
// carries the hash of the page, not the page, and the hash is what is checkable.
// ============================================================

import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import './env.mjs';

const MAX_STRING = 700;
const MAX_ARRAY = 40;
const MAX_DEPTH = 7;

function slim(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return value.length;
    return value.slice(0, MAX_ARRAY).map((v) => slim(v, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '[depth]';
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'text' || k === 'page_text') continue; // the hash stands in for this
      out[k] = slim(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function packReceipt(payload) {
  const json = JSON.stringify(slim(payload));
  return gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url');
}

export function unpackReceipt(d) {
  try {
    return JSON.parse(gunzipSync(Buffer.from(String(d), 'base64url')).toString('utf8'));
  } catch {
    return null;
  }
}

export function publicBase() {
  const raw = process.env.PUBLIC_BASE_URL || process.env.GROUND_PUBLIC_BASE_URL || '';
  return raw ? raw.replace(/\/+$/, '') : '';
}

/** Attach a stable, self-contained address to any tool payload. */
export function withReceipt(payload) {
  try {
    const packed = packReceipt(payload);
    const id = createHash('sha256').update(packed).digest('hex').slice(0, 16);
    const base = publicBase();
    const url = base ? `${base}/receipt?d=${packed}` : null;
    return {
      ...payload,
      receipt: {
        id,
        url,
        note: 'Self-contained: the receipt travels inside this link, so it cannot be edited after the fact and it will still open after the Arena. Drop the /receipt.json suffix for a human-readable page.',
        json_url: url ? `${url}&format=json` : null,
      },
    };
  } catch {
    return payload;
  }
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function verdictBadge(v) {
  const colors = {
    supported: ['#0f5132', '#d1e7dd'],
    contradicted: ['#842029', '#f8d7da'],
    not_mentioned: ['#41464b', '#e2e3e5'],
    unverified: ['#664d03', '#fff3cd'],
    source_unavailable: ['#664d03', '#fff3cd'],
    extractor_unavailable: ['#664d03', '#fff3cd'],
  };
  const [fg, bg] = colors[v] || ['#41464b', '#e2e3e5'];
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-weight:600;font-size:13px;color:${fg};background:${bg}">${esc(v || 'n/a')}</span>`;
}

function row(k, v) {
  return `<tr><th style="text-align:left;padding:6px 12px 6px 0;font-weight:600;color:#374151;white-space:nowrap;vertical-align:top">${esc(k)}</th><td style="padding:6px 0;color:#111827;word-break:break-word">${v}</td></tr>`;
}

function section(title, inner) {
  return `<section style="margin:26px 0"><h2 style="font-size:15px;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;margin:0 0 10px">${esc(title)}</h2>${inner}</section>`;
}

export function renderReceiptHtml(receipt) {
  const r = receipt || {};
  const src = r.source || {};
  const parts = [];

  parts.push(`<header style="border-bottom:2px solid #111827;padding-bottom:14px">
    <div style="font-size:22px;font-weight:700">Ground — evidence receipt</div>
    <div style="color:#6b7280;margin-top:4px">${esc(r.service || 'receipt')}${r.credits === 0 ? ' · free' : r.credits ? ` · ${esc(r.credits)} credits` : ''}</div>
  </header>`);

  if (r.statement) parts.push(section('The claim that was tested', `<blockquote style="margin:0;padding:12px 16px;background:#f9fafb;border-left:3px solid #9ca3af;font-size:15px">${esc(r.statement)}</blockquote>`));

  if (r.verdict) {
    const quoteBlock = r.quote
      ? `<blockquote style="margin:14px 0 0;padding:12px 16px;background:#f0fdf4;border-left:3px solid #16a34a;font-size:15px;white-space:pre-wrap">${esc(r.quote)}</blockquote>
         <div style="color:#6b7280;font-size:12px;margin-top:6px">↑ the words on the page, checked by code against the text that was actually fetched — quote_check: ${esc(r.quote_check || 'n/a')}</div>`
      : '';
    const understanding = r.understanding
      ? `<div style="margin-top:10px;color:#374151;font-size:14px">${esc(r.understanding)}</div>`
      : '';
    const notRead = r.unreadable_reason
      ? `<div style="margin-top:10px;color:#92400e;font-size:14px">Not read: ${esc(r.unreadable_reason)}</div>`
      : '';
    parts.push(section('Verdict', verdictBadge(r.verdict) + quoteBlock + understanding + notRead));
  }

  const srcRows = [
    src.url ? row('Source read', esc(src.url)) : '',
    src.requested_url && src.redirected ? row('Requested', esc(src.requested_url)) : '',
    row('HTTP status', esc(src.status ?? 'n/a')),
    row('Readable', src.readable ? 'yes' : `no${src.unreadable_reason ? ` — ${esc(src.unreadable_reason)}` : ''}`),
    src.text_sha256 ? row('sha256 of text', `<code style="font-size:12px;background:#f3f4f6;padding:2px 6px;border-radius:4px">${esc(src.text_sha256)}</code>`) : '',
    row('Read at', esc(src.fetched_at || 'n/a')),
    src.fetched_by ? row('Read by', esc(src.fetched_by)) : '',
  ].filter(Boolean).join('');
  parts.push(section('Source', `<table style="border-collapse:collapse;font-size:14px;width:100%">${srcRows}</table>`));

  let grounded = r.grounding;
  if (!grounded && r.check && r.extract) {
    grounded = r.extract.grounding;
  }
  if (grounded) {
    parts.push(section('Grounding summary', `<div style="font-size:14px;color:#111827">${esc(grounded.verified)} verified · ${esc(grounded.not_found)} not found · ${esc(grounded.ungrounded)} ungrounded · ${esc(grounded.total)} total</div>`));
  }

  if (r.fields && Object.keys(r.fields).length) {
    const rows = Object.entries(r.fields).map(([k, f]) => row(k, f && f.value !== null && f.value !== undefined
      ? `${esc(typeof f.value === 'object' ? JSON.stringify(f.value) : f.value)} <span style="color:#6b7280;font-size:12px">${f.grounded ? '· grounded' : `· ${esc(f.reason || 'not grounded')}`}</span>`
      : `<em style="color:#6b7280">null — ${esc(f?.reason || 'not stated on the page')}</em>`)).join('');
    parts.push(section('Extracted fields', `<table style="border-collapse:collapse;font-size:14px;width:100%">${rows}</table>`));
  }

  if (r.claims && Array.isArray(r.claims) && r.claims.length) {
    const rows = r.claims.slice(0, 40).map((c, i) => row(
      `#${i + 1}`,
      `${verdictBadge(c.verdict)} <span style="font-size:14px">${esc(String(c.statement || '').slice(0, 300))}</span>${c.quote ? `<div style="color:#374151;font-size:13px;margin-top:6px;white-space:pre-wrap">“${esc(String(c.quote).slice(0, 300))}”</div>` : ''}`
    )).join('');
    parts.push(section(`Claims (${r.claims.length})`, `<table style="border-collapse:collapse;font-size:14px;width:100%">${rows}</table>`));
  }

  if (r.packet_sha256) parts.push(section('Packet hash', `<code style="font-size:12px;background:#f3f4f6;padding:4px 8px;border-radius:4px">${esc(r.packet_sha256)}</code>`));
  if (r.deliverable_line) parts.push(section('One-line summary for your own deliverable', `<div style="font-size:14px;background:#f9fafb;padding:12px 16px;border-radius:6px">${esc(r.deliverable_line)}</div>`));

  parts.push(`<footer style="margin-top:36px;border-top:1px solid #e5e7eb;padding-top:14px;color:#6b7280;font-size:12px">
    To check this yourself: re-fetch the source URL, normalise the text the same way, hash it, and compare with the sha256 above. If it matches, none of this was invented.
    ${r.receipt && r.receipt.id ? `<br>Receipt ${esc(r.receipt.id)}.` : ''}
  </footer>`);

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ground receipt${r.verdict ? ` — ${esc(r.verdict)}` : ''}</title></head>
<body style="margin:0;background:#fff;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif">
<main style="max-width:820px;margin:0 auto;padding:40px 24px 80px;color:#111827;line-height:1.55">${parts.join('')}</main>
</body></html>`;
}
