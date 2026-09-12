// ============================================================
// page.js — really read a page, then hand back exactly what we read.
//
// No dependencies. Node 20+ built-in fetch.
//
// Design rule: never dress up a failure. An unreachable page is
// reported as unreachable. A truncated page says it was truncated.
// Every payload is timestamped so the buyer can tell how fresh it is.
// ============================================================

import { createHash } from 'node:crypto';

const UA = 'Ground/1.0 (agent extraction service)';

// Fresh controller per request. Reusing an aborted signal makes every
// retry fail instantly — a bug worth never repeating.
function deadline(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

export function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, '-')
    .replace(/[ \t\u2009\u202f]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

function titleOf(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]).slice(0, 200) || null : null;
}

// Comparison primitives used for grounding. Deliberately tolerant of
// punctuation, quote style and whitespace — intolerant of invention.
export function normalizeText(s) {
  return String(s)
    .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u00a0\u2009\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function alnum(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff]+/g, '');
}

// --- the primitive: really read a page ---
export async function fetchPage(url, { timeoutMs = 9000, maxChars = 14000 } = {}) {
  const started = Date.now();
  const fetched_at = new Date().toISOString();
  let status = null;
  let ok = false;
  let html = '';
  let contentType = null;

  // HEAD first: cheap reachability probe. Some hosts block it, so a
  // failure here is not fatal — the GET below decides.
  try {
    const h = deadline(timeoutMs);
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: h.signal, headers: { 'user-agent': UA } });
      status = res.status;
      ok = res.ok;
      contentType = res.headers.get('content-type');
    } finally {
      h.clear();
    }
  } catch {
    /* fall through to GET */
  }

  try {
    const g = deadline(timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: g.signal,
        headers: { 'user-agent': UA, accept: 'text/html,application/json,text/plain;q=0.8,*/*;q=0.5' },
      });
      status = res.status;
      ok = res.ok;
      contentType = res.headers.get('content-type') || contentType;
      const ct = String(contentType || '').toLowerCase();
      if (!ct || ct.includes('text') || ct.includes('html') || ct.includes('json') || ct.includes('xml')) {
        html = (await res.text()).slice(0, 500000);
      }
    } finally {
      g.clear();
    }
  } catch (e) {
    return {
      url,
      status,
      ok: false,
      reachable: false,
      title: null,
      text: '',
      text_sha256: null,
      chars_read: 0,
      bytes: 0,
      truncated: false,
      error: e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(e?.message || e).slice(0, 160),
      fetched_at,
      elapsed_ms: Date.now() - started,
    };
  }

  const fullText = stripHtml(html);
  const text = fullText.slice(0, maxChars);
  const doc = normalizeText(text);

  return {
    url,
    final_url: url,
    status,
    ok,
    reachable: true,
    content_type: contentType ? String(contentType).slice(0, 80) : null,
    title: titleOf(html),
    text,
    text_sha256: createHash('sha256').update(doc).digest('hex'),
    chars_read: fullText.length,
    bytes: html.length,
    truncated: fullText.length > maxChars,
    error: ok ? null : `HTTP ${status}`,
    fetched_at,
    elapsed_ms: Date.now() - started,
  };
}
