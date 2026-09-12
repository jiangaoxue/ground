// ============================================================
// page.js — really read a page, then hand back exactly what we read.
//
// No dependencies. Node 20+ built-in fetch + built-in zlib.
//
// Design rule: never dress up a failure.
//   * unreachable      -> reachable:false + the error
//   * fetched but unreadable (PDF with no text layer, image, JS-only shell)
//                      -> readable:false + unreadable_reason
//   The empty string is NEVER used to mean "we could not read it". A buyer
//   who is told "0 characters" cannot tell that apart from "the page really
//   says nothing", and for a product that sells truth that difference is
//   the whole point.
//
// Second rule: the receipt must name the URL the text actually came from.
//   Redirects are followed, so `final_url` is the landing URL, not the one
//   that was typed. A receipt that cites the wrong source is worse than none.
// ============================================================

import { createHash } from 'node:crypto';
import { inflateSync, inflateRawSync, gunzipSync } from 'node:zlib';

const UA = 'Ground/1.0 (agent extraction service)';

// "fetch failed" tells a buyer nothing, and a buyer who cannot tell
// "their server is down" from "my network cannot reach them" cannot act on
// the result. Every failure gets a name.
function describeFetchError(e, timeoutMs) {
  if (e?.name === 'AbortError') return `timeout (no response within ${timeoutMs}ms)`;
  const code = e?.cause?.code || e?.code || '';
  const map = {
    UND_ERR_CONNECT_TIMEOUT: 'connect_timeout (could not open a connection — often a blocked or unreachable host)',
    UND_ERR_HEADERS_TIMEOUT: 'headers_timeout (server accepted the connection but never answered)',
    UND_ERR_BODY_TIMEOUT: 'body_timeout (server started answering then stalled)',
    UND_ERR_SOCKET: 'connection_reset (the socket dropped mid-response)',
    ENOTFOUND: 'dns_failure (the host name does not resolve)',
    EAI_AGAIN: 'dns_failure (name resolution timed out)',
    ECONNREFUSED: 'connection_refused',
    ECONNRESET: 'connection_reset',
    ETIMEDOUT: 'connect_timeout',
  };
  if (map[code]) return map[code];
  if (/certificate|CERT_|TLS|SSL/i.test(String(code) + String(e?.message || ''))) return 'tls_error (the certificate could not be validated)';
  return `network_error (${code || String(e?.message || e).slice(0, 80)})`;
}

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

// ------------------------------------------------------------
// Reading a response without trusting its size.
// A 2 MB Wikipedia article used to kill the whole call because the
// body was buffered whole and the socket gave up. We now stop reading
// at a hard byte budget and say so, instead of failing.
// ------------------------------------------------------------
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length') || 0) || 0;
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf: buf.subarray(0, maxBytes), bytes: buf.length, capped: buf.length > maxBytes, declared };
  }
  const chunks = [];
  let total = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total >= maxBytes) {
      chunks.push(Buffer.from(value).subarray(0, Math.max(0, maxBytes - (total - value.length))));
      capped = true;
      try {
        await reader.cancel();
      } catch {
        /* the socket is going away anyway */
      }
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return { buf: Buffer.concat(chunks), bytes: total, capped, declared };
}

// ------------------------------------------------------------
// PDF text, with no dependencies.
//
// A PDF is a container of objects; the words live in content streams,
// usually Flate-compressed. `node:zlib` is built in, so this is a
// self-contained reader: inflate each stream, pull the text-showing
// operators (Tj / TJ / ' / "), decode the string escapes.
//
// Honest limits, enforced below rather than hidden: a scanned PDF has
// no text layer at all, and a PDF using a CID font can inflate into
// bytes that are not words. Both are reported as unreadable, never as
// "the document says nothing".
// ------------------------------------------------------------
function inflateAny(buf) {
  for (const fn of [inflateSync, inflateRawSync, gunzipSync]) {
    try {
      const out = fn(buf);
      if (out?.length) return out;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

// --- the stream table ---
// `indexOf('stream')` is wrong: "endstream" contains "stream", so half the
// hits are bogus and the slices pair up wrong. A real stream keyword is a
// standalone token, i.e. not preceded by a letter.
function pdfStreams(buf) {
  const raw = buf.toString('latin1');
  const out = [];
  const re = /[^A-Za-z]stream[\r\n]+/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    let stop = end;
    if (raw[stop - 1] === '\n') stop -= 1;
    if (raw[stop - 1] === '\r') stop -= 1;
    if (stop > start) out.push(buf.subarray(start, stop));
    re.lastIndex = end + 'endstream'.length;
  }
  return out;
}

// --- ToUnicode CMap ---
// A subset font numbers its glyphs; the page shows glyph 3, not the letter
// "m". The mapping back to real characters lives in a ToUnicode CMap stream.
// Without it the reader produces control bytes — which is exactly the kind
// of output that would let a model "quote" nonsense.
function hexToUnicode(hex) {
  let s = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    const cp = parseInt(hex.slice(i, i + 4), 16);
    if (!Number.isFinite(cp)) break;
    s += String.fromCharCode(cp);
  }
  return s;
}

function parseCMap(text) {
  const map = new Map();
  // How many bytes one glyph code occupies is declared in the code space
  // range, NOT inferable from the mapping values. A subset font commonly
  // uses one-byte codes and we would otherwise split them wrong and decode
  // nothing at all.
  let cidBytes = 0;
  const cs = text.match(/begincodespacerange([\s\S]*?)endcodespacerange/);
  if (cs) {
    const seg = cs[1].match(/<([0-9A-Fa-f]+)>/);
    if (seg) cidBytes = Math.max(1, Math.round(seg[1].length / 2));
  }

  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    for (const p of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const cid = parseInt(p[1], 16);
      const u = hexToUnicode(p[2]);
      if (Number.isFinite(cid) && u) map.set(cid, u);
    }
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    for (const p of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      const dst = parseInt(p[3], 16);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) continue;
      for (let c = lo; c <= hi; c += 1) map.set(c, String.fromCharCode(dst + (c - lo)));
    }
  }
  return { map, cidBytes };
}

const isCMap = (t) => t.includes('beginbfchar') || t.includes('beginbfrange');

// Merge the per-font maps. Where two fonts disagree about a code we refuse
// to guess that code — a wrong letter inside a quote is the one output this
// product must never produce. If a document is mostly ambiguous the
// language check below rejects it outright instead of shipping noise.
function mergeCMaps(parsed) {
  if (!parsed.length) return { map: new Map(), cidBytes: 0 };
  const cidBytes = parsed.find((p) => p.cidBytes)?.cidBytes || 0;
  if (parsed.length === 1) return { map: parsed[0].map, cidBytes };
  const merged = new Map();
  const keys = new Set();
  for (const { map } of parsed) for (const k of map.keys()) keys.add(k);
  for (const k of keys) {
    const vals = parsed.filter((p) => p.map.has(k)).map((p) => p.map.get(k));
    if (vals.every((v) => v === vals[0])) merged.set(k, vals[0]);
  }
  return { map: merged, cidBytes };
}

// A PDF can inflate into bytes that are not words. Say so instead of
// returning noise that the model would then try to quote. Short documents
// are fine ("Dummy PDF file" is a legitimate 12-character answer), so this
// measures character quality, not length.
function looksLikeLanguage(s) {
  const t = String(s || '').replace(/\s+/g, '');
  if (t.length < 3) return false;
  const good = (t.match(/[A-Za-z0-9\u4e00-\u9fff\u3040-\u30ff.,;:'"()\-%/@#$&+=?!*[\]]/g) || []).length;
  return good / t.length >= 0.85;
}

function decodePdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = raw[i + 1];
    if (n === undefined) break;
    if (n === 'n') { out += '\n'; i += 1; }
    else if (n === 'r') { out += '\r'; i += 1; }
    else if (n === 't') { out += '\t'; i += 1; }
    else if (n === 'b' || n === 'f') { i += 1; }
    else if (n === '(' || n === ')' || n === '\\') { out += n; i += 1; }
    else if (n >= '0' && n <= '7') {
      let oct = '';
      let k = i + 1;
      while (k < raw.length && oct.length < 3 && raw[k] >= '0' && raw[k] <= '7') {
        oct += raw[k];
        k += 1;
      }
      out += String.fromCharCode(parseInt(oct, 8));
      i = k - 1;
    } else {
      out += n;
      i += 1;
    }
  }
  return out;
}

function mapHexString(hex, cmap, twoByte) {
  const clean = hex.replace(/\s+/g, '');
  const width = twoByte ? 4 : 2;
  let out = '';
  let glyphs = 0;
  let unmapped = 0;
  for (let i = 0; i + width <= clean.length; i += width) {
    const code = parseInt(clean.slice(i, i + width), 16);
    if (!Number.isFinite(code)) break;
    glyphs += 1;
    if (cmap.size) {
      const u = cmap.get(code);
      // An unknown glyph is counted, not silently dropped: a quote with a
      // hole in it is worse than no quote, and the caller is told.
      if (u === undefined) unmapped += 1;
      else out += u;
    } else if (code >= 32 && code < 127) {
      out += String.fromCharCode(code);
    } else {
      unmapped += 1;
    }
  }
  return { out, glyphs, unmapped };
}

function textFromContentStream(s, cmap, twoByte) {
  const pieces = [];
  // The Td/TD alternative comes first so the operands are captured: a
  // horizontal nudge (ty = 0) continues the same line, a vertical one
  // starts a new line. Treating every Td as a line break chopped words
  // into "Dumm\ny" — technically recoverable, but a quote the buyer can
  // no longer grep for is a worse product.
  const re = /([-\d.]+)\s+([-\d.]+)\s+(?:Td|TD)|\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\[(?:[^\][\\]|\\.)*\]|\bTJ\b|\bTj\b|\bT\*\b|\bET\b/g;
  let m;
  let line = '';
  let glyphs = 0;
  let unmapped = 0;
  const flush = () => {
    if (line.trim()) pieces.push(line.trim());
    line = '';
  };
  while ((m = re.exec(s)) !== null) {
    const tok = m[0];
    if (tok === 'ET' || tok === 'T*') {
      flush();
      continue;
    }
    if (m[1] !== undefined) {
      // Td / TD: new line only if the vertical component moved.
      if (parseFloat(m[2]) !== 0) flush();
      continue;
    }
    if (tok === 'TJ' || tok === 'Tj') continue;
    if (tok.startsWith('(')) {
      const raw = decodePdfString(tok.slice(1, -1));
      // Literal strings are only trustworthy when they are already readable;
      // with a subset font they are glyph numbers wearing quotes.
      line += cmap.size ? raw.replace(/[^\x20-\x7e\u00a0-\uffff]/g, '') : raw;
      glyphs += raw.length;
    } else if (tok.startsWith('<')) {
      const r = mapHexString(tok.slice(1, -1), cmap, twoByte);
      line += r.out;
      glyphs += r.glyphs;
      unmapped += r.unmapped;
    } else if (tok.startsWith('[')) {
      const strs = tok.slice(1, -1).match(/\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>/g) || [];
      for (const st of strs) {
        if (st.startsWith('(')) line += decodePdfString(st.slice(1, -1));
        else {
          const r = mapHexString(st.slice(1, -1), cmap, twoByte);
          line += r.out;
          glyphs += r.glyphs;
          unmapped += r.unmapped;
        }
      }
    }
    if (line.length > 4000) flush();
  }
  flush();
  return { text: pieces.join('\n'), glyphs, unmapped };
}

export function pdfToText(buf) {
  const decoded = [];
  for (const st of pdfStreams(buf)) {
    const inf = inflateAny(st);
    decoded.push((inf || st).toString('latin1'));
  }

  const { map: cmap, cidBytes } = mergeCMaps(decoded.filter(isCMap).map(parseCMap));

  const chunks = [];
  let glyphs = 0;
  let unmapped = 0;
  for (const d of decoded) {
    if (isCMap(d)) continue;
    if (!/\bBT\b/.test(d) && !/\bTj\b/.test(d) && !/\bTJ\b/.test(d)) continue;
    const r = textFromContentStream(d, cmap, cidBytes === 2);
    glyphs += r.glyphs;
    unmapped += r.unmapped;
    if (r.text.trim()) chunks.push(r.text);
  }

  return {
    text: chunks
      .join('\n')
      .replace(/\u0000/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    glyphs,
    unmapped,
    fonts: decoded.filter(isCMap).length,
  };
}

function classify(ctStruct, head) {
  const ct = String(ctStruct || '').toLowerCase();
  // Some servers label a PDF as octet-stream or even text/html. The file
  // signature is the authority, not the header.
  if (head.includes('%PDF-')) return 'pdf';
  if (ct.includes('application/pdf') || ct.includes('application/x-pdf')) return 'pdf';
  if (!ct || ct.includes('text') || ct.includes('html') || ct.includes('json') || ct.includes('xml') || ct.includes('javascript') || ct.includes('csv')) {
    return 'text';
  }
  return 'binary';
}

// --- the primitive: really read a page ---
// The GET deadline is deliberately generous: a hosted seller on a cold
// serverless start (Vercel, Fly) routinely needs more than nine seconds, and
// reporting a live page as unreachable would be a false negative — the one
// failure this product cannot afford. The HEAD probe is the opposite: it is
// only a hint, so it fails fast instead of holding the request open.
export async function fetchPage(url, {
  timeoutMs = 30000,
  headTimeoutMs = 4000,
  maxChars = 14000,
  maxBytes = 12 * 1024 * 1024,
} = {}) {
  const started = Date.now();
  const fetched_at = new Date().toISOString();
  let status = null;
  let ok = false;
  let contentType = null;
  let finalUrl = String(url);

  const blank = {
    requested_url: String(url),
    final_url: finalUrl,
    redirected: false,
    // Who did the reading. The point of an independent receipt is that it was
    // not produced on the caller's own machine: a different host sees a
    // different network, a different cache, a different moment.
    fetched_by: 'ground (independent host, not the caller)',
    status,
    ok: false,
    reachable: false,
    readable: false,
    unreadable_reason: null,
    content_type: null,
    title: null,
    text: '',
    text_sha256: null,
    chars_read: 0,
    bytes: 0,
    truncated: false,
    error: null,
    fetched_at,
    elapsed_ms: 0,
  };

  // HEAD first: cheap reachability probe. Some hosts block it, so a
  // failure here is not fatal — the GET below decides.
  try {
    const h = deadline(headTimeoutMs);
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: h.signal, headers: { 'user-agent': UA } });
      status = res.status;
      ok = res.ok;
      contentType = res.headers.get('content-type');
      finalUrl = res.url || finalUrl;
    } finally {
      h.clear();
    }
  } catch {
    /* fall through to GET */
  }

  let buf = null;
  let capped = false;
  try {
    const g = deadline(timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: g.signal,
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/pdf,application/json,text/plain;q=0.8,*/*;q=0.5',
        },
      });
      status = res.status;
      ok = res.ok;
      contentType = res.headers.get('content-type') || contentType;
      finalUrl = res.url || finalUrl;
      const read = await readCapped(res, maxBytes);
      buf = read.buf;
      capped = read.capped;
    } finally {
      g.clear();
    }
  } catch (e) {
    const why = describeFetchError(e, timeoutMs);
    return {
      ...blank,
      final_url: finalUrl,
      status,
      content_type: contentType ? String(contentType).slice(0, 80) : null,
      unreadable_reason: why,
      unreachable_reason: why,
      error: why,
      elapsed_ms: Date.now() - started,
    };
  }

  const head = buf.subarray(0, 1024).toString('latin1');
  const kind = classify(contentType, head);
  const redirected = normalizeText(finalUrl) !== normalizeText(String(url));

  // A non-2xx body is not evidence. Many error pages echo the request, so a
  // 404 page can contain the very words a buyer is asking about — grounding a
  // claim in an error page is the one way this product could manufacture a
  // false "supported". Whatever we read, an HTTP error is unreadable.
  const finish = (over) => {
    const readable = ok && over.readable === true;
    return {
      ...blank,
      ...over,
      requested_url: String(url),
      final_url: finalUrl,
      redirected,
      status,
      ok,
      reachable: true,
      readable,
      unreadable_reason: readable ? null : over.unreadable_reason || `http_error (HTTP ${status})`,
      content_type: contentType ? String(contentType).slice(0, 80) : null,
      bytes: buf.length,
      byte_capped: capped,
      elapsed_ms: Date.now() - started,
      error: ok ? null : `HTTP ${status}`,
    };
  };

  // --- binary we cannot read as words ---
  if (kind === 'binary') {
    return finish({
      readable: false,
      unreadable_reason: `not_a_text_document (${String(contentType || 'unknown').split(';')[0]})`,
      note: `Ground read ${buf.length} bytes but this is ${String(contentType || 'an unknown format').split(';')[0]}, which carries no words to quote. Nothing was judged from it.`,
    });
  }

  // --- PDF ---
  if (kind === 'pdf') {
    // An encrypted PDF inflates into noise. Saying "probably a scan" would be
    // a guess presented as a finding; the /Encrypt marker is the actual fact.
    const encrypted = /\/Encrypt\s+\d+\s+\d+\s+R|\/Filter\s*\/Standard/.test(buf.subarray(0, 20000).toString('latin1'));
    let pdf = { text: '', glyphs: 0, unmapped: 0, fonts: 0 };
    if (!encrypted) {
      try {
        pdf = pdfToText(buf);
      } catch {
        pdf = { text: '', glyphs: 0, unmapped: 0, fonts: 0 };
      }
    }
    const partial = pdf.glyphs >= 20 && pdf.unmapped / pdf.glyphs > 0.02;
    if (encrypted || !pdf.text || !looksLikeLanguage(pdf.text) || partial) {
      const reason = encrypted
        ? 'pdf_encrypted (the document is password-protected; Ground does not decrypt)'
        : partial
          ? `pdf_encoding_incomplete (${Math.round((pdf.unmapped / pdf.glyphs) * 100)}% of glyphs have no character mapping)`
          : pdf.text
            ? 'pdf_text_not_extractable (glyph codes with no readable mapping)'
            : 'pdf_no_readable_text (no text layer — a scan, or compression Ground cannot decode)';
      return finish({
        readable: false,
        unreadable_reason: reason,
        note: 'This PDF was fetched but its words could not be recovered faithfully, so no judgement was made from it. A partial reading would be a quote with holes in it, which is worse than no quote.',
      });
    }
    const text = pdf.text.slice(0, maxChars);
    // The hash covers the WHOLE document, not the excerpt we happen to ship.
    const doc = normalizeText(pdf.text);
    return finish({
      readable: true,
      title: (head.match(/\/Title\s*\(([^)]{1,200})\)/) || [])[1] || null,
      text,
      text_sha256: createHash('sha256').update(doc).digest('hex'),
      chars_read: pdf.text.length,
      truncated: pdf.text.length > maxChars,
      note: `Text layer recovered from a PDF (${pdf.text.length} characters across ${pdf.fonts || 1} embedded font mapping${(pdf.fonts || 1) === 1 ? '' : 's'}). A scanned page has no text layer and is reported as unreadable rather than as empty.`,
    });
  }

  // --- text-ish ---
  const html = buf.toString('utf8');
  const fullText = stripHtml(html);
  if (!fullText) {
    return finish({
      readable: false,
      unreadable_reason: 'no_text_in_document (empty body, or a JavaScript-only page with no server-rendered words)',
      title: titleOf(html),
      note: 'The document was fetched but contains no words Ground can quote — most often a client-side rendered page. Nothing was judged from it.',
    });
  }
  const text = fullText.slice(0, maxChars);
  // The hash covers the WHOLE document, not the excerpt we happen to ship.
  // Hashing the excerpt would make "re-fetch and re-hash it" fail for any
  // buyer on a long page — and re-hashing is the entire promise.
  const doc = normalizeText(fullText);
  return finish({
    readable: true,
    title: titleOf(html),
    text,
    text_sha256: createHash('sha256').update(doc).digest('hex'),
    chars_read: fullText.length,
    truncated: fullText.length > maxChars,
  });
}
