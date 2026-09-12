// api/health.mjs — liveness plus a zero-cost proof that the engine is wired up.
//
// Ground does not call the model here. It only reports what it holds: the
// tool list, the prices, and whether a model key is present in the
// environment. A buyer agent can hit this before it spends anything.

import { catalog, TOOLS, SERVER_INFO } from '../src/mcp-protocol.mjs';
import { modelReady, modelInfo } from '../src/engine/model.js';

export default function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(
    JSON.stringify(
      {
        ok: true,
        ...SERVER_INFO,
        product: catalog.product,
        tagline: catalog.tagline,
        extractor_configured: modelReady(),
        extractor: modelInfo(),
        tools: TOOLS.map((t) => ({ name: t.name, credits: t.credits })),
        free: (catalog.free || []).map((f) => f.name),
        contact: catalog.contact,
      },
      null,
      2
    )
  );
}
