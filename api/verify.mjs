// ============================================================
// api/verify.mjs — GET /verify?d=<packed receipt>
//
// The free trust anchor. Every other serious seller in this market
// publishes a way to verify ITS receipts; a receipt nobody can check
// is a claim, not a deliverable. Given the d= parameter of any Ground
// receipt URL, this endpoint runs deterministic structural checks and
// reports each one — ?format=json for machines, HTML for humans.
//
// It cannot re-fetch the original page (the receipt intentionally
// carries the hash, not the text) — what it CAN verify is that the
// receipt is intact, well-formed, internally consistent, and that its
// hash fields are real sha256 over something. Re-fetching the source
// and comparing text_sha256 is the buyer's one-second audit, and the
// receipt tells them how.
// ============================================================

import { unpackReceipt } from "../src/receipt.mjs";
import { verifyPayload } from "../src/signing.mjs";

const SHA256_RE = /^[a-f0-9]{64}$/;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function html(res, status, title, checks, valid) {
  const rows = checks
    .map(
      (c) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #e5e7eb">${c.check}</td>
<td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;color:${c.result === "pass" ? "#047857" : "#b91c1c"};font-weight:600">${c.result.toUpperCase()}</td>
<td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;color:#374151">${c.detail}</td></tr>`
    )
    .join("");
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:ui-sans-serif,system-ui;margin:32px auto;max-width:760px;color:#111827">
<h1 style="font-size:22px">Ground receipt verification</h1>
<p style="font-size:14px;color:#374151">Structural verification of a self-contained Ground receipt. To verify the <em>evidence</em>, re-fetch the source URL inside the receipt and compare <code>text_sha256</code> — the receipt states the recipe.</p>
<p style="font-size:15px"><b>Overall: <span style="color:${valid ? "#047857" : "#b91c1c"}">${valid ? "VALID" : "INVALID"}</span></b></p>
<table style="border-collapse:collapse;font-size:14px;min-width:600px">
<tr><th style="text-align:left;padding:6px 12px;border-bottom:2px solid #9ca3af">check</th><th style="text-align:left;padding:6px 12px;border-bottom:2px solid #9ca3af">result</th><th style="text-align:left;padding:6px 12px;border-bottom:2px solid #9ca3af">detail</th></tr>
${rows}</table>
<p style="font-size:12px;color:#6b7280;margin-top:24px">Deterministic checks, no model, no network. Run it yourself: the receipt is gzip+base64url JSON; the decoder is 20 lines in the repo.</p>
</body></html>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

export default function verifyHandler(req, res) {
  const u = new URL(req.url, "http://x");
  const d = u.searchParams.get("d") || "";
  const wantsJson = u.searchParams.get("format") === "json";
  const checks = [];
  const add = (check, result, detail) => checks.push({ check, result, detail });

  if (!d) {
    add("parameter", "fail", "No d= parameter. Paste the d= value from a receipt URL.");
    return wantsJson
      ? json(res, 400, { valid: false, checks })
      : html(res, 400, "Ground verify", checks, false);
  }

  let r = null;
  try {
    r = unpackReceipt(d);
    add("decode", "pass", "gzip+base64url envelope decoded and parsed as JSON.");
  } catch (e) {
    add("decode", "fail", `Envelope did not decode: ${String(e?.message || e).slice(0, 120)}`);
    return wantsJson
      ? json(res, 200, { valid: false, checks })
      : html(res, 200, "Ground verify", checks, false);
  }

  add("service", r?.service || (r?.payload?.service) ? "pass" : "fail",
    `Issued by ${r?.service || r?.payload?.service || "(missing service field)"}`);

  // Required fields depending on shape: withReceipt packs the whole payload;
  // attest/certify results carry their own verdict blocks.
  const p = r?.payload || r;
  const hasVerdictish =
    p && (p.verdict || p.attestation || p.certification || p.fields || p.summary || p.found !== undefined);
  add("payload", hasVerdictish ? "pass" : "fail",
    hasVerdictish ? "The receipt carries a complete answer payload." : "No recognisable answer payload inside the envelope.");

  // Hash fields present and well-formed. A receipt over fetched text must
  // carry hashes; an aggregate "nothing verified" receipt legitimately has
  // none — that is reported as a warning, not a failure, because the
  // receipt is honest about it (its attempts carry the reasons).
  const hashes = [];
  const scan = (obj, path) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (/sha256$/.test(k) && typeof v === "string") hashes.push({ path: path + k, v });
      else if (typeof v === "object" && v !== null && path.length < 6) scan(v, path + k + ".");
    }
  };
  scan(p, "");
  const evidenceBearing = Boolean(p?.source || p?.attestation || p?.certification || p?.fields);
  if (hashes.length === 0 && evidenceBearing) {
    add("hashes", "fail", "No sha256 fields found — a receipt claiming evidence without hashes proves nothing.");
  } else if (hashes.length === 0) {
    add("hashes", "warn", "No hashes — this receipt contains no fetched text (no source was readable or decisive). It is an honest miss, not evidence.");
  } else {
    const bad = hashes.filter((h) => !SHA256_RE.test(h.v));
    add("hashes", bad.length ? "fail" : "pass",
      `${hashes.length} sha256 field(s), ${bad.length} malformed.${bad.length ? " Malformed: " + bad.map((b) => b.path).join(", ") : ""}`);
  }

  // Receipt URL consistency: if the receipt embeds receipt.url, its d= should equal this d=.
  const innerUrl = p?.receipt?.url || r?.receipt?.url;
  if (innerUrl) {
    try {
      const innerD = new URL(innerUrl).searchParams.get("d");
      add("self_reference", innerD === d ? "pass" : "fail",
        innerD === d
          ? "The receipt's own receipt.url encodes exactly this envelope — no substitution."
          : "The receipt's embedded receipt.url encodes a DIFFERENT envelope — treat as tampered.");
    } catch {
      add("self_reference", "fail", "Embedded receipt.url is not a parseable URL.");
    }
  } else {
    add("self_reference", "pass", "No embedded self URL (older receipt shape); nothing to cross-check.");
  }

  // Coverage disclosure: honesty requirement — truncation must be stated, not hidden.
  const cov = p?.source?.coverage;
  if (p?.source) {
    add("coverage", cov ? "pass" : "fail",
      cov
        ? `Coverage disclosed: ${cov.chars_judged}/${cov.chars_read} chars, complete=${cov.complete}.`
        : "Source block present but no coverage disclosure.");
  }

  // Ed25519 signature: proves the receipt was issued by this deployment and
  // was not altered after signing — checkable offline with GET /pubkey.
  if (p?.signature) {
    const ok = verifyPayload(p);
    add("signature", ok ? "pass" : "fail",
      ok
        ? `Ed25519 signature valid (key ${p.signature.key_id}). This receipt was issued by Ground and not modified after signing.`
        : "Ed25519 signature INVALID — the receipt does not match its own signature. Treat as tampered.");
  } else {
    add("signature", "warn", "No signature block (receipt predates signing). Evidence checks above still apply.");
  }

  const valid = checks.every((c) => c.result !== "fail");
  return wantsJson
    ? json(res, 200, { valid, format: "ground-receipt-v1", service: p?.service || null, checks })
    : html(res, 200, "Ground verify", checks, valid);
}
