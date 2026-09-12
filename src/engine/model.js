// ============================================================
// model.js — OpenAI-compatible chat adapter.
//
// Loads ../env.mjs first so MODEL_API_KEY / MODEL_BASE_URL / MODEL_NAME can
// come from a .env file next to package.json. The import must stay the first
// statement: KEY and BASE below are read at module load, so a later load would
// arrive too late. A real environment variable still takes precedence.
//
// The model only ever sees text we already fetched. It is used for
// reading comprehension ("which span of this text says the price?"),
// never as the authority. Its output is checked by code afterwards,
// and anything it cannot support with a verbatim quote is discarded.
//
// Env:
//   MODEL_BASE_URL  default https://api.deepseek.com/v1
//   MODEL_API_KEY   required at runtime
//   MODEL_NAME      default deepseek-chat
// ============================================================

import "../env.mjs";

const BASE = (process.env.MODEL_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const KEY = process.env.MODEL_API_KEY || '';
const MODEL = process.env.MODEL_NAME || 'deepseek-chat';

export function modelReady() {
  return Boolean(KEY);
}

export function modelInfo() {
  return { base: BASE, model: MODEL, key_present: Boolean(KEY) };
}

function extractJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('model returned no JSON object');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function chat(messages, { timeoutMs = 30000, maxTokens = 1600, temperature = 0 } = {}) {
  if (!KEY) throw new Error('MODEL_API_KEY is not set');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`model HTTP ${res.status}: ${String(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('model returned empty content');
    return { text, json: () => extractJson(text), usage: data?.usage || null };
  } finally {
    clearTimeout(t);
  }
}

// Ask for JSON, tolerate one malformed reply, then give up honestly.
export async function chatJson(messages, opts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await chat(messages, opts);
      return r.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('model call failed');
}
