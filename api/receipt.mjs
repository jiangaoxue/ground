// ============================================================
// api/receipt.mjs — GET /receipt?d=<packed>
//
// The address every paid answer comes back with. The receipt is carried in
// the link itself, so this handler holds no state: it unpacks, checks that
// the bytes are intact, and renders. Nothing to store, nothing to expire,
// nothing that can 404 on a cold instance.
//
//   GET /receipt?d=…              a page a human can read
//   GET /receipt?d=…&format=json  the same receipt as JSON, for a machine
//
// Free, and deliberately so: the receipt is what the buyer already paid for.
// Charging again to look at it would make the "anyone can check it" claim
// hollow.
// ============================================================

import { createHash } from 'node:crypto';
import { unpackReceipt, renderReceiptHtml } from '../src/receipt.mjs';

export default function handler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const packed = url.searchParams.get('d') || '';
  const asJson = url.searchParams.get('format') === 'json';

  res.setHeader('access-control-allow-origin', '*');

  if (!packed) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.end(
      JSON.stringify({
        ok: false,
        error: 'missing ?d= — a Ground receipt carries its own content in the link',
        how: 'call any ground.* service; the response contains receipt.url',
      })
    );
  }

  const receipt = unpackReceipt(packed);
  if (!receipt) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ ok: false, error: 'this link is damaged — the packed receipt did not decompress' }));
  }

  // The id is a hash of the packed bytes, so it identifies the exact receipt a
  // buyer was handed. Two links for the same call are byte-identical; a link
  // that was edited is a different id, which is the whole point.
  const id = createHash('sha256').update(packed).digest('hex').slice(0, 16);
  receipt.receipt = { ...(receipt.receipt || {}), id, url: req.url };

  res.statusCode = 200;
  res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  res.setHeader('x-ground-receipt-id', id);

  if (asJson) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify(receipt, null, 2));
  }

  res.setHeader('content-type', 'text/html; charset=utf-8');
  return res.end(renderReceiptHtml(receipt));
}
