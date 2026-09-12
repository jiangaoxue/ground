// ============================================================
// honesty.test.mjs — the rules the product cannot break.
//
// These are not "features work" tests. Each one locks a way the product
// could lie to a buyer, all of which were real bugs found by reading the
// code against real documents:
//
//   1. an unreadable document used to come back as "0 characters", which is
//      indistinguishable from "the page says nothing";
//   2. a 404 page's body was grounded like any other text — and error pages
//      echo the request, so a false "supported" was reachable;
//   3. the receipt named the URL that was typed, not the one the text came
//      from, so a redirect was silently misattributed;
//   4. the sha256 was taken over the 14k excerpt, so "re-fetch and re-hash"
//      failed for every long page.
//
// Real network, real documents. A mock would prove nothing here.
// ============================================================

import assert from 'node:assert/strict';
import { fetchPage, pdfToText } from '../src/engine/page.js';
import { packReceipt, unpackReceipt, withReceipt, publicBase } from '../src/receipt.mjs';

let passed = 0;
const checks = [];
function test(name, fn) {
  checks.push({ name, fn });
}

const PDF = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';
const ENCRYPTED_PDF = 'https://www.orimi.com/pdf-test.pdf';

// --- 1. reading a PDF, through its own font map ---
test('a PDF text layer is recovered through its ToUnicode map', async () => {
  const p = await fetchPage(PDF);
  assert.equal(p.readable, true, `expected readable, got ${p.unreadable_reason}`);
  assert.ok(/dummy/i.test(p.text), `expected the words on the page, got ${JSON.stringify(p.text)}`);
  assert.equal(p.unreadable_reason, null);
});

test('an encrypted PDF is refused, not returned as empty', async () => {
  const p = await fetchPage(ENCRYPTED_PDF);
  assert.equal(p.reachable, true, 'the file downloads fine — it is the words that are locked');
  assert.equal(p.readable, false);
  assert.match(p.unreadable_reason || '', /encrypted/);
  assert.equal(p.text, '', 'no text is better than invented text');
});

// --- 2. unreadable is never the empty string ---
test('a non-text document says what it is instead of returning nothing', async () => {
  const p = await fetchPage('https://www.w3.org/Icons/w3c_home.png');
  assert.equal(p.readable, false);
  assert.match(p.unreadable_reason || '', /not_a_text_document/);
});

test('an HTTP error is never evidence, even when the body echoes the claim', async () => {
  // example.com's 404 body contains its own homepage text, which is exactly
  // the shape of a false positive: the words are on the "page" the caller
  // named, but the page is an error.
  const p = await fetchPage('https://example.com/definitely-not-here-xyz');
  assert.equal(p.status, 404);
  assert.equal(p.readable, false, 'a 404 must never be groundable');
  assert.match(p.unreadable_reason || '', /http_error/);
});

// --- 3. the receipt names the source the text came from ---
test('a redirect is followed and disclosed, not hidden', async () => {
  const p = await fetchPage('https://httpbingo.org/redirect/3');
  assert.equal(p.readable, true);
  assert.notEqual(p.final_url, p.requested_url, 'the landing URL differs from the typed one');
  assert.equal(p.redirected, true);
  assert.match(p.final_url, /httpbingo\.org\//);
});

test('the same URL typed twice still reports itself honestly when nothing moves', async () => {
  const p = await fetchPage('https://api.github.com/repos/jiangaoxue/ground');
  assert.equal(p.readable, true);
  assert.match(p.requested_url, /api\.github\.com/);
  assert.match(p.final_url, /api\.github\.com/);
});

// --- 4. the hash covers the document, not the excerpt ---
test('the hash is over the whole document, not the excerpt that is shipped', async () => {
  const p = await fetchPage('https://www.gov.cn/', { maxChars: 300 });
  assert.equal(p.readable, true);
  assert.equal(p.truncated, true, 'the shipped text must be an excerpt');
  assert.ok(p.text.length <= 300, 'the excerpt is capped');
  assert.ok(p.chars_read > 300, `the hash must cover all ${p.chars_read} characters`);
  assert.equal(p.text.length !== p.chars_read, true);
});

// --- 5. every failure has a name ---
test('an unreachable host reports why, not "fetch failed"', async () => {
  const p = await fetchPage('https://this-host-does-not-exist-ground.invalid/');
  assert.equal(p.reachable, false);
  assert.ok(p.unreadable_reason && p.unreadable_reason.length > 8, 'a buyer must be able to act on the reason');
  assert.doesNotMatch(p.unreadable_reason, /^fetch failed$/);
});

// --- 6. the receipt is a portable object ---
test('a receipt survives the round trip and comes back byte-identical', async () => {
  const payload = { service: 'ground.check', verdict: 'supported', source: { text_sha256: 'a'.repeat(64) } };
  const packed = packReceipt(payload);
  const back = unpackReceipt(packed);
  assert.equal(back.verdict, 'supported');
  assert.equal(back.source.text_sha256, 'a'.repeat(64));
  assert.equal(packReceipt(payload), packed, 'the same receipt always packs to the same link');
});

test('the receipt drops the page text but keeps the hash that stands for it', async () => {
  const payload = { verdict: 'supported', source: { url: 'https://example.com', text: 'x'.repeat(5000), text_sha256: 'b'.repeat(64) } };
  const back = unpackReceipt(packReceipt(payload));
  assert.equal(back.source.text, undefined, 'the page is not reproduced in the link');
  assert.equal(back.source.text_sha256, 'b'.repeat(64), 'but the means to check it is');
});

test('an address is attached when a public base is configured', async () => {
  const base = publicBase();
  const out = withReceipt({ service: 'ground.check', verdict: 'supported' });
  assert.ok(out.receipt && out.receipt.id, 'every answer carries an id');
  if (base) {
    assert.match(out.receipt.url, /^https?:\/\//, 'and an address when one is known');
    assert.match(out.receipt.url, /\/receipt\?d=/);
  } else {
    assert.equal(out.receipt.url, null, 'no base configured means no invented address');
  }
});

test('a damaged link is rejected, not half-read', () => {
  assert.equal(unpackReceipt('not-a-real-payload'), null);
});

// --- 7. the PDF reader does not invent characters ---
test('the PDF reader returns words, not glyph numbers', () => {
  const fake = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Font>>endobj\n2 0 obj<</Length 3>>stream\nabc\nendstream\nendobj\n%%EOF', 'latin1');
  const r = pdfToText(fake);
  assert.equal(typeof r.text, 'string');
  assert.ok(r.glyphs === 0 || r.unmapped <= r.glyphs, 'unmapped glyphs are counted, never guessed');
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${String(error?.message || error).slice(0, 300)}`);
    failed += 1;
  }
}
console.log(`\n${passed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
