// ============================================================
// ground.js — the grounding engine.
//
// The product in one sentence:
//   you give a URL and a list of fields; you get back JSON where
//   every non-null value carries the verbatim span of the page that
//   proves it, and that span was checked by code — not by the model.
//
// Why that matters to a buyer: the result is checkable in one second
// without trusting the seller. Values that cannot be proven come back
// as null with a reason. We never guess, and we never dress up a miss
// as a hit.
// ============================================================

import { createHash } from 'node:crypto';
import { fetchPage, normalizeText, alnum } from './page.js';
import { chatJson, modelReady, modelInfo } from './model.js';

const MAX_FIELDS = 12;
const MIN_QUOTE_ALNUM = 8;

function fieldList(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('input.fields (non-empty array of names, or {name,type,hint}) is required');
  }
  return fields.slice(0, MAX_FIELDS).map((f) => {
    if (typeof f === 'string') return { name: f.slice(0, 60), type: 'auto', hint: null };
    const name = String(f?.name || '').slice(0, 60);
    if (!name) throw new Error('every field needs a name');
    return {
      name,
      type: String(f?.type || 'auto').slice(0, 20),
      hint: f?.hint ? String(f.hint).slice(0, 160) : null,
    };
  });
}

// Code-side verification of a quote against the page we already fetched.
// Tolerance: punctuation, quote style, whitespace, separators.
// Intolerance: any character sequence that is not actually on the page.
export function verifyQuote(quote, pageText) {
  const q = String(quote || '').trim();
  if (!q) return { verified: false, reason: 'no_quote' };
  const aq = alnum(q);
  if (aq.length < MIN_QUOTE_ALNUM) return { verified: false, reason: 'quote_too_short' };
  const hay = alnum(pageText);
  if (hay.includes(aq)) return { verified: true, reason: 'verbatim_in_source' };
  return { verified: false, reason: 'quote_not_in_source' };
}

function valuePresent(value, pageText) {
  const av = alnum(value);
  if (av.length < 2) return false;
  return alnum(pageText).includes(av);
}

const EXTRACT_SYSTEM = `You are a strict field extractor. You are given the plain text of one web page and a list of fields.

Rules you must follow exactly:
1. For each field, find the value IN THE GIVEN TEXT ONLY. You have no other knowledge of this page.
2. You must also copy a "quote": a VERBATIM consecutive span copied character-for-character from the given text, at least 20 characters long, that contains the value. Do not paraphrase, do not fix spelling, do not merge two separate places in the text.
3. If the field is not stated in the given text, return {"value": null, "quote": null}. Do not infer, do not estimate, do not use typical values.
4. Preserve the value as written (keep currency symbols, units, original date format). Do not translate.
5. Replies are JSON only, no prose, no markdown fences.

Output shape:
{"fields":{"<name>":{"value":"<string or null>","quote":"<verbatim span or null>"}}}`;

function userPrompt(page, fields) {
  const spec = fields
    .map((f) => `- ${f.name} (type: ${f.type}${f.hint ? `, hint: ${f.hint}` : ''})`)
    .join('\n');
  return `PAGE URL: ${page.final_url}${page.redirected ? ` (redirected from ${page.requested_url})` : ''}
PAGE TITLE: ${page.title || '(none)'}

PAGE TEXT:
"""
${page.text}
"""

FIELDS TO EXTRACT:
${spec}

Return the JSON object now.`;
}

// --- Service: ground.extract (1 credit) ---
export async function extract(input) {
  const url = input?.url;
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('input.url (http/https string) is required');
  }
  const fields = fieldList(input?.fields);
  const page = await fetchPage(url, { maxChars: Math.min(Math.max(Number(input?.max_chars) || 14000, 1000), 40000) });

  const base = {
    ok: true,
    service: 'ground.extract',
    source: {
      url: page.final_url,
      final_url: page.final_url,
      requested_url: page.requested_url,
      redirected: page.redirected,
      status: page.status,
      reachable: page.reachable,
      readable: page.readable,
      unreadable_reason: page.unreadable_reason,
      title: page.title,
      content_type: page.content_type,
      bytes: page.bytes,
      chars_read: page.chars_read,
      truncated: page.truncated,
      coverage: {
        chars_read: page.chars_read,
        chars_judged: String(page.text || '').length,
        complete: !page.truncated,
        note: page.truncated
          ? `Only the first ${String(page.text || '').length} of ${page.chars_read} characters were read into the extraction. A field returned as null was not found in that part.`
          : 'The whole document was read.',
      },
      text_sha256: page.text_sha256,
      fetched_at: page.fetched_at,
      fetched_by: page.fetched_by,
      elapsed_ms: page.elapsed_ms,
      error: page.error,
    },
    fields: {},
  };

  if (!page.readable) {
    const why = page.unreadable_reason || (page.reachable ? 'no_readable_text' : 'source_unreachable');
    for (const f of fields) {
      base.fields[f.name] = { value: null, grounded: false, reason: why };
    }
    base.grounding = { verified: 0, not_found: 0, ungrounded: fields.length, total: fields.length, ratio: 0 };
    base.note = `The source was not read (${why}). Nothing was extracted. This is a miss, not a result — no field is null because the page omits it.`;
    return base;
  }

  let raw = null;
  let modelFailed = false;
  const info = modelInfo();
  if (!modelReady()) {
    modelFailed = true;
  } else {
    try {
      raw = await chatJson(
        [
          { role: 'system', content: EXTRACT_SYSTEM },
          { role: 'user', content: userPrompt(page, fields) },
        ],
        { timeoutMs: Number(input?.model_timeout_ms) || 30000, maxTokens: 1600 }
      );
    } catch {
      modelFailed = true;
    }
  }

  const rawFields = raw && typeof raw.fields === 'object' && raw.fields ? raw.fields : {};
  let verified = 0;
  let notFound = 0;
  let ungrounded = 0;

  for (const f of fields) {
    if (modelFailed) {
      base.fields[f.name] = { value: null, grounded: false, reason: 'extractor_unavailable' };
      ungrounded++;
      continue;
    }
    const entry = rawFields[f.name] || {};
    const value = entry.value === null || entry.value === undefined ? null : String(entry.value).slice(0, 500);
    const quote = entry.quote === null || entry.quote === undefined ? null : String(entry.quote).slice(0, 600);

    if (value === null && !quote) {
      base.fields[f.name] = { value: null, grounded: false, reason: 'not_stated_on_page' };
      notFound++;
      continue;
    }

    const check = verifyQuote(quote, page.text);
    if (!check.verified) {
      base.fields[f.name] = {
        value: null,
        grounded: false,
        reason: check.reason,
        rejected_value: value,
        value_text_found_on_page: value ? valuePresent(value, page.text) : false,
        note: 'A value was proposed but could not be proven with a verbatim span, so it is withheld.',
      };
      ungrounded++;
      continue;
    }

    base.fields[f.name] = {
      value,
      grounded: true,
      quote,
      quote_check: check.reason,
      verified_at: new Date().toISOString(),
    };
    verified++;
  }

  base.grounding = {
    verified,
    not_found: notFound,
    ungrounded,
    total: fields.length,
    ratio: Number((verified / fields.length).toFixed(3)),
  };
  base.extractor = info;
  base.note =
    'Every non-null value carries a quote that code checked against the fetched text. Null means we did not find it or could not prove it — we never guess. Re-fetch the URL and compare source.text_sha256 to audit this payload.';
  return base;
}

// --- Service: ground.quotecheck (1 credit) — the fast lane.
//
// The room's broker rule is "cheapest whose proof held", and the one real
// brokered deal was lost on latency, not capability. quotecheck removes
// the model entirely: the buyer names the page AND the words, and this
// returns whether those exact words are on that page — pure fetch + code
// match, typically 1-3s. Verifying a given quote is also the single most
// reused job in this market (buyers checking a seller's citations).
export async function quoteCheck(input) {
  const url = input?.url;
  const quote = String(input?.quote || input?.span || '').trim().slice(0, 600);
  if (!url || !/^https?:\/\//i.test(String(url))) throw new Error('input.url (http/https string) is required');
  if (!quote) throw new Error('input.quote (the exact words to verify) is required');

  const t0 = Date.now();
  const page = await fetchPage(String(url), { maxChars: 60000 });
  const base = {
    ok: true,
    service: 'ground.quotecheck',
    requested_quote: quote,
    source: {
      url: page.final_url,
      final_url: page.final_url,
      requested_url: page.requested_url,
      redirected: page.redirected,
      status: page.status,
      reachable: page.reachable,
      readable: page.readable,
      unreadable_reason: page.unreadable_reason,
      title: page.title,
      text_sha256: page.text_sha256,
      chars_read: page.chars_read,
      coverage: {
        chars_read: page.chars_read,
        chars_searched: Math.min(60000, String(page.text || '').length),
        complete: !page.truncated,
        note: page.truncated
          ? `Only the first ${Math.min(60000, String(page.text || '').length)} characters were searched.`
          : 'The whole document was searched.',
      },
      fetched_at: page.fetched_at,
      elapsed_ms: page.elapsed_ms,
    },
  };
  if (!page.readable) {
    return {
      ...base,
      found: null,
      reason: page.unreadable_reason || (page.reachable ? 'no_readable_text' : 'source_unreachable'),
      note: 'The page could not be read, so no verification was made. Nothing was judged — and under our SLA a miss this size is disclosed, not billed as a result.',
    };
  }
  const v = verifyQuote(quote, page.text);
  if (v.verified) {
    const aq = alnum(quote);
    const hay = alnum(page.text);
    const offset = hay.indexOf(aq);
    return {
      ...base,
      found: true,
      reason: v.reason,
      match: { normalized_offset: offset, quote_alnum_chars: aq.length, tolerance: 'punctuation/quotes/whitespace-insensitive; character sequence must exist verbatim' },
      total_elapsed_ms: Date.now() - t0,
      model_used: false,
      note: 'Code found the exact character sequence in the fetched text. No model was involved. Re-fetch the page and compare text_sha256 to audit.',
    };
  }
  return {
    ...base,
    found: false,
    reason: v.reason === 'quote_too_short' ? 'quote_too_short' : 'quote_not_in_source',
    total_elapsed_ms: Date.now() - t0,
    model_used: false,
    note: v.reason === 'quote_too_short'
      ? 'The quote is shorter than the 8-word-characters minimum this check requires; nothing was judged.'
      : 'The exact words are not on the page (code search, no model). If the seller paraphrased, ground.check tests the paraphrase against the page instead.',
  };
}

// --- Service: ground.check (2 credits) — claim-only capable ---
// The buyer wants to know whether a specific statement is actually
// supported by a specific source. We fetch, ask, then verify the
// model's own evidence. An unprovable judgement is returned as such.
//
// Claim-only: buyers in a live market type "verify: X" without a URL.
// The room's own shootout proved the old proposal flow loses to live
// search ("the sky is blue" -> not_found while a search rival answered
// supported). Fix: candidate discovery no longer depends on the model
// alone. Wikipedia's open search API runs FIRST (deterministic, no key,
// ~300ms), and the model proposal is a fallback, not the foundation.
// Candidates are then fetched in PARALLEL, so total latency is one
// page-fetch, not N.
const SOURCE_FINDER_SYSTEM = `You propose canonical public web pages that would state a given claim.

Reply JSON only: {"candidates":["https://...", "..."]}
Rules:
1. At most 3 URLs. Fewer is fine.
2. Only stable, well-known, public pages you are confident exist (encyclopedia entries, official documentation, standards bodies, government pages). Never guess a URL pattern you have not seen.
3. Primary source beats aggregator. Prefer the page a careful person would cite.
4. If you cannot name any page you are confident exists, return {"candidates":[]}.`;

// Wikipedia's open search API: deterministic candidate discovery, no key,
// no model. This is what lets a bare claim like "the sky is blue" resolve
// from a live encyclopedia instead of failing because a language model
// could not name a URL it was sure exists.
async function wikiCandidates(statement) {
  const q = encodeURIComponent(statement.replace(/[?!.]+$/, '').slice(0, 240));
  const api = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&format=json&srlimit=3&origin=*`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(api, { signal: ctrl.signal, headers: { 'user-agent': 'Ground/1.0 (claim sourcing)' } });
    clearTimeout(t);
    if (!r.ok) return [];
    const j = await r.json();
    return (j?.query?.search || [])
      .map((s) => s?.title)
      .filter(Boolean)
      .slice(0, 3)
      .map((title) => `https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`);
  } catch {
    return [];
  }
}

// Bing HTML search: the channel that works from hosts whose egress blocks
// Wikipedia (measured: sandbox reaches bing.com in ~2s, en.wikipedia.org
// never). Parse the server-rendered organic results; no key, no model.
async function bingCandidates(statement) {
  const q = encodeURIComponent(statement.replace(/[?!.]+$/, '').slice(0, 200));
  const url = `https://www.bing.com/search?q=${q}&count=10`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; Ground/1.0; claim sourcing)' } });
    clearTimeout(t);
    if (!r.ok) return [];
    const html = await r.text();
    const out = [];
    const re = /<h2[^>]*><a[^>]+href="(https?:\/\/[^"]+)"/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 3) {
      let u = m[1];
      try {
        // Bing wraps some results: /ck/a?...&u=a1<base64> — unwrap when present.
        if (/bing\.com\/ck\/a/.test(u)) {
          const um = /[&?]u=a1(aHR0[\w-]+)/.exec(u) || /[&?]u=a1(aHR0[^&"]+)/.exec(u);
          if (um) u = Buffer.from(um[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        }
      } catch { /* keep original */ }
      if (/^https?:\/\//i.test(u) && !/bing\.com|microsoft\.com\/bing/i.test(u)) out.push(u);
    }
    return [...new Set(out)].slice(0, 3);
  } catch {
    return [];
  }
}

export async function claimCheck(input) {
  const url = input?.url;
  const statement = String(input?.statement || input?.claim || '').slice(0, 600);
  if (!statement) throw new Error('input.statement (or input.claim) is required');
  if (url && /^https?:\/\//i.test(String(url))) {
    const r = await check({ url: String(url), statement });
    return { ...r, service: 'ground.check' };
  }

  // Candidate discovery: three channels in parallel — Wikipedia open search,
  // Bing organic results, and the extractor model — deduped. The sourcing
  // block discloses exactly which channels produced what was tried.
  const t0 = Date.now();
  const [wiki, bing, modelOut] = await Promise.all([
    wikiCandidates(statement),
    bingCandidates(statement),
    (async () => {
      if (!modelReady()) return { candidates: [], available: false };
      try {
        const out = await chatJson(
          [
            { role: 'system', content: SOURCE_FINDER_SYSTEM },
            { role: 'user', content: `Claim: ${statement}\n\nReturn the JSON object now.` },
          ],
          { timeoutMs: 30000, maxTokens: 300 }
        );
        return {
          candidates: (Array.isArray(out?.candidates) ? out.candidates : [])
            .map((u) => String(u || '').trim())
            .filter((u) => /^https?:\/\//i.test(u))
            .slice(0, 3),
          available: true,
        };
      } catch {
        return { candidates: [], available: false };
      }
    })(),
  ]);

  const candidates = [...new Set([...wiki, ...bing, ...modelOut.candidates])].slice(0, 6);
  const channels = [];
  if (wiki.length) channels.push('wikipedia_search');
  if (bing.length) channels.push('bing_search');
  if (modelOut.candidates.length) channels.push('model_proposed_urls');
  const sourcing = {
    method: channels.join('+') || (modelOut.available ? 'none_found' : 'model_unavailable'),
    channels: {
      wikipedia_search: wiki.length,
      bing_search: bing.length,
      model_proposed_urls: modelOut.candidates.length,
      model_proposer_available: modelOut.available,
    },
    candidates,
    discovery_ms: Date.now() - t0,
  };

  if (candidates.length === 0) {
    return {
      ok: true, service: 'ground.check', statement,
      verdict: 'no_source_proposed', quote: null,
      sourcing: { ...sourcing, candidates: [], tried: 0 },
      note: 'No source page could be proposed with confidence (Wikipedia search found nothing, model proposed nothing), so nothing was fetched and nothing was judged. Provide input.url to test the claim against a page you name — that path never depends on source proposal.',
    };
  }

  // Fetch and judge every candidate IN PARALLEL — total latency is one
  // page-fetch, not N sequential round-trips. First decisive verdict wins.
  let decisiveFull = null;
  const judged = await Promise.all(candidates.map(async (candidate) => {
    try {
      const r = await check({ url: candidate, statement });
      if ((r.verdict === 'supported' || r.verdict === 'contradicted') && !decisiveFull) decisiveFull = r;
      return {
        url: r.source?.final_url || candidate,
        verdict: r.verdict,
        quote: r.quote || null,
        quote_check: r.quote_check || null,
        understanding: r.understanding || null,
        text_sha256: r.source?.text_sha256 || null,
        fetched_at: r.source?.fetched_at || null,
        status: r.source?.status ?? null,
        readable: r.source?.readable ?? null,
        unreadable_reason: r.unreadable_reason || r.source?.unreadable_reason || null,
      };
    } catch (e) {
      return { url: candidate, verdict: 'source_unavailable', quote: null,
               unreadable_reason: String(e?.message || e).slice(0, 120) };
    }
  }));

  const decisive = judged.find((a) => a.verdict === 'supported' || a.verdict === 'contradicted');
  if (decisive && decisiveFull) {
    return {
      ...decisiveFull,
      service: 'ground.check',
      sourcing: { ...sourcing, tried: judged.length, note: 'No URL was supplied with the claim. Candidates came from the channels named in sourcing.method (Wikipedia open search and/or the extractor model), were fetched and judged in parallel by this host, and the verdict was earned exactly as a URL-supplied check: a verbatim span, code-matched against fetched text. Re-fetch the URL and compare text_sha256 to audit it.' },
      attempts: judged,
    };
  }

  const allUnreachable = judged.every((a) => a.verdict === 'source_unavailable');
  return {
    ok: true, service: 'ground.check', statement,
    verdict: 'not_found_in_proposed_sources', quote: null,
    sourcing: { ...sourcing, tried: judged.length },
    attempts: judged,
    note: allUnreachable
      ? `All ${judged.length} proposed source(s) could not be fetched from this host (${judged.map((a) => a.unreadable_reason || 'unreachable').join(', ')}). Nothing was judged. Note: the proposal itself was sound — retry from a host with different network reach, or supply input.url you know is reachable.`
      : `Every proposed source (${judged.length}, discovered via ${sourcing.method}) was fetched and none states the claim. That is what was measured — not a finding that the claim is false, and not a search of the whole web. Provide input.url to test one page you choose.`,
  };
}

const CHECK_SYSTEM = `You decide whether a page SUPPORTS, CONTRADICTS, or does NOT MENTION a statement.

Answer only from the given text. Reply JSON only:
{"verdict":"supported"|"contradicted"|"not_mentioned","quote":"<verbatim span from the text, >=20 chars, that justifies the verdict, or null if not_mentioned>","understanding":"<one short sentence, <=25 words, on what the page actually says about this>"}

Rules: if you cannot find a verbatim span that justifies a verdict of supported or contradicted, you must answer "not_mentioned". Never use outside knowledge.`;

export async function check(input) {
  const url = input?.url;
  const statement = String(input?.statement || input?.claim || '').slice(0, 600);
  if (!url || !/^https?:\/\//i.test(String(url))) throw new Error('input.url (http/https string) is required');
  if (!statement) throw new Error('input.statement is required');

  // A standards document runs to half a million characters and the model can
  // only judge what fits in one call. The cap is disclosed in `coverage`
  // rather than hidden, because on a truncated document "not mentioned"
  // means "not in the part I read" — and a buyer who reads that as "the
  // document never says it" has been misled by omission.
  const JUDGE_CHARS = 48000;
  const page = await fetchPage(String(url), { maxChars: JUDGE_CHARS });
  const base = {
    ok: true,
    service: 'ground.check',
    statement,
    source: {
      url: page.final_url,
      final_url: page.final_url,
      requested_url: page.requested_url,
      redirected: page.redirected,
      status: page.status,
      reachable: page.reachable,
      readable: page.readable,
      unreadable_reason: page.unreadable_reason,
      title: page.title,
      content_type: page.content_type,
      text_sha256: page.text_sha256,
      chars_read: page.chars_read,
      truncated: page.truncated,
      coverage: {
        chars_read: page.chars_read,
        chars_judged: Math.min(JUDGE_CHARS, String(page.text || '').length),
        complete: !page.truncated,
        note: page.truncated
          ? `Only the first ${Math.min(JUDGE_CHARS, String(page.text || '').length)} of ${page.chars_read} characters were judged. A verdict of not_mentioned covers that part only.`
          : 'The whole document was judged.',
      },
      fetched_at: page.fetched_at,
      fetched_by: page.fetched_by,
      elapsed_ms: page.elapsed_ms,
      error: page.error,
    },
  };

  if (!page.readable) {
    const why = page.unreadable_reason || (page.reachable ? 'no_readable_text' : 'source_unreachable');
    return {
      ...base,
      verdict: 'source_unavailable',
      unreadable_reason: why,
      quote: null,
      note: `The source was not read (${why}). No judgement was made — this is a miss, not a finding that the page omits the statement.`,
    };
  }
  if (!modelReady()) {
    return { ...base, verdict: 'extractor_unavailable', quote: null, note: 'No extractor configured; nothing was judged.' };
  }

  let out = null;
  try {
    out = await chatJson(
      [
        { role: 'system', content: CHECK_SYSTEM },
        { role: 'user', content: `STATEMENT: ${statement}\n\nPAGE TEXT:\n"""\n${page.text}\n"""\n\nReturn the JSON object now.` },
      ],
      { timeoutMs: 30000, maxTokens: 700 }
    );
  } catch {
    return { ...base, verdict: 'extractor_unavailable', quote: null, note: 'The extractor call failed; nothing was judged.' };
  }

  const verdict = ['supported', 'contradicted', 'not_mentioned'].includes(out?.verdict) ? out.verdict : 'not_mentioned';
  const quote = out?.quote ? String(out.quote).slice(0, 600) : null;

  if (verdict === 'not_mentioned') {
    return {
      ...base,
      verdict,
      quote: null,
      understanding: out?.understanding ? String(out.understanding).slice(0, 200) : null,
      note: page.truncated
        ? `The document does not state this in the ${base.source.coverage.chars_judged} characters that were judged, out of ${page.chars_read}. That is not a finding that the document never states it — the rest was not read into the judgement.`
        : 'The page does not state this. That is not the same as the statement being false.',
    };
  }

  const v = verifyQuote(quote, page.text);
  if (!v.verified) {
    return {
      ...base,
      verdict: 'unverified',
      proposed_verdict: verdict,
      quote: null,
      reason: v.reason,
      note: 'A judgement was proposed but its own evidence could not be found in the fetched text, so it is withheld.',
    };
  }

  return {
    ...base,
    verdict,
    quote,
    quote_check: 'verbatim_in_source',
    understanding: out?.understanding ? String(out.understanding).slice(0, 200) : null,
    verified_at: new Date().toISOString(),
    note: 'The verdict is backed by a span that code found in the fetched text.',
  };
}

// --- Service: ground.attest (2 credits) ---
//
// The one thing a buyer cannot produce for itself, no matter how capable
// it is: a third party's word about its own work. Self-attestation is
// worth nothing. So a seller hands us its finished deliverable plus the
// sources it cites; we fetch each source, check each claim, and return a
// signed-by-hash packet it can attach to what it ships.
export async function attest(input) {
  const claims = Array.isArray(input?.claims) ? input.claims.slice(0, 8) : null;
  if (!claims || claims.length === 0) {
    throw new Error('input.claims (non-empty array of {statement, url}) is required');
  }

  const results = await Promise.all(
    claims.map(async (c, i) => {
      const statement = String(c?.statement || c?.claim || '').slice(0, 400);
      const url = c?.url ? String(c.url) : null;
      try {
        const r = url ? await check({ url, statement }) : await claimCheck({ statement });
        return {
          index: i,
          statement,
          url: r.source?.final_url || url,
          url_supplied: Boolean(url),
          verdict: r.verdict,
          quote: r.quote || null,
          understanding: r.understanding || null,
          source_status: r.source?.status ?? null,
          fetched_at: r.source?.fetched_at || null,
          text_sha256: r.source?.text_sha256 || null,
        };
      } catch (e) {
        return { index: i, statement, url, verdict: 'error', error: String(e?.message || e).slice(0, 200) };
      }
    })
  );

  const tally = results.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] || 0) + 1), a), {});
  const total = results.length;
  const grounded = tally.supported || 0;
  const packet = results.map((r) => ({ statement: r.statement, url: r.url, verdict: r.verdict, quote: r.quote }));
  const packet_sha256 = createHash('sha256').update(JSON.stringify(packet)).digest('hex');

  return {
    ok: true,
    service: 'ground.attest',
    attestation: {
      grounded,
      contradicted: tally.contradicted || 0,
      not_mentioned: tally.not_mentioned || 0,
      unverified: tally.unverified || 0,
      unavailable: (tally.source_unavailable || 0) + (tally.extractor_unavailable || 0) + (tally.error || 0),
      total,
      ratio: Number((grounded / total).toFixed(3)),
      packet_sha256,
      issued_at: new Date().toISOString(),
    },
    deliverable_line: `Independently checked ${total} claim${total === 1 ? '' : 's'} against the cited sources: ${grounded} grounded verbatim, ${tally.not_mentioned || 0} not stated by the source cited, ${tally.contradicted || 0} contradicted, ${tally.unverified || 0} unprovable. Attestation ${packet_sha256.slice(0, 12)}.`,
    claims: results,
    note: 'This attests only that the statements do or do not appear in the sources cited, as fetched at the timestamps above. It says nothing about quality, price or intent. Re-fetch the sources and hash the packet to verify this document.',
  };
}

// --- Service: ground.batch (2 credits) ---
export async function batch(input) {
  const items = Array.isArray(input?.items) ? input.items.slice(0, 6) : null;
  if (!items || items.length === 0) throw new Error('input.items (non-empty array of {url, fields}) is required');
  const results = await Promise.all(
    items.map(async (it, i) => {
      try {
        return await extract({ ...it, model_timeout_ms: input?.model_timeout_ms });
      } catch (e) {
        return { ok: false, service: 'ground.extract', index: i, url: it?.url || null, error: String(e?.message || e).slice(0, 200) };
      }
    })
  );
  return {
    ok: true,
    service: 'ground.batch',
    count: results.length,
    succeeded: results.filter((r) => r.ok && r.grounding && r.grounding.verified > 0).length,
    results,
    note: 'One call, many sources. Every item is grounded by the same rules as ground.extract.',
  };
}

// --- Service: ground.certify (10 credits) ---
//
// The premium tier. In this market a buyer does not save credits — it must
// spend them all before the round closes. That changes what the largest
// useful purchase looks like: not one more opinion, but the biggest block
// of verifiable work a single call can absorb. certify takes a whole
// deliverable — every source it cites and every claim it makes — reads each
// source now, tests each claim against the source it names, and returns one
// ship-ready packet with a single hash over the lot. Nothing new is
// promised; it composes the same gates as extract and attest, at the size a
// buyer actually needs when it is about to ship.
export async function certify(input) {
  const sources = Array.isArray(input?.sources) ? input.sources.slice(0, 6) : [];
  const claims = Array.isArray(input?.claims) ? input.claims.slice(0, 10) : [];
  if (sources.length === 0 && claims.length === 0) {
    throw new Error('input.sources (array of {url,fields}) and/or input.claims (array of {statement,url}) is required');
  }

  const [extractions, attestation] = await Promise.all([
    sources.length
      ? batch({ items: sources.map((s) => ({ url: s?.url, fields: s?.fields })) })
      : Promise.resolve({ count: 0, succeeded: 0, results: [] }),
    claims.length ? attest({ claims }) : Promise.resolve(null),
  ]);

  const packetBody = {
    sources: extractions.results.map((r) => ({
      url: r?.source?.url || r?.url || null,
      text_sha256: r?.source?.text_sha256 || null,
      grounding: r?.grounding || null,
    })),
    claims: attestation
      ? attestation.claims.map((c) => ({ statement: c.statement, url: c.url, verdict: c.verdict, quote: c.quote }))
      : [],
  };
  const packet_sha256 = createHash('sha256').update(JSON.stringify(packetBody)).digest('hex');

  const values_grounded = extractions.results.reduce((s, r) => s + (r?.grounding?.verified || 0), 0);
  const claims_checked = attestation ? attestation.attestation.total : 0;
  const claims_grounded = attestation ? attestation.attestation.grounded : 0;

  return {
    ok: true,
    service: 'ground.certify',
    certification: {
      sources_read: extractions.count,
      sources_grounded: extractions.succeeded,
      values_grounded,
      claims_checked,
      claims_grounded,
      packet_sha256,
      issued_at: new Date().toISOString(),
    },
    deliverable_line: `Independently read ${extractions.count} cited source${extractions.count === 1 ? '' : 's'} and checked ${claims_checked} claim${claims_checked === 1 ? '' : 's'} against them: ${claims_grounded} grounded verbatim, ${values_grounded} extracted value${values_grounded === 1 ? '' : 's'} each carrying a verifiable quote. Certification ${packet_sha256.slice(0, 12)}.`,
    sources: extractions.results,
    claims: attestation ? attestation.claims : [],
    note: 'The whole deliverable checked in one pass: every cited source read now, every claim tested against the source it names, one hash over the packet. Re-fetch the sources and hash it to verify. It attests appearance in the cited sources, not quality, price or intent.',
  };
}
