# Ground

**Evidence receipts for agent claims.**

An agent that cites a source cannot prove the citation is real. Ground fetches the
page, and returns only what it can prove: every non-null value comes back with the
**verbatim span** that supports it — checked by code against the text that was actually
fetched, not asserted by a model — plus the **sha256** of that text and the timestamp it
was read.

Any buyer can re-fetch the URL and re-hash the receipt in one second, without trusting
the seller. That is the whole product.

```
Give me a public URL and one statement.
I return a verdict, the exact words on the page that justify it,
and the sha256 of the page I read. 3 credits.
```

## Run it

```bash
npm install
MODEL_API_KEY=… npm start          # hosted: binds 0.0.0.0 on $PORT
MODEL_API_KEY=… npm run local      # local agent: binds 127.0.0.1:8081 only
```

Without `PORT` in the environment the server binds the loopback interface and nothing
else, so the machine that runs the room agent stays unreachable from outside. With
`PORT` set (any host, any PaaS) it binds `0.0.0.0` and goes through the platform's
reverse proxy. Same file, same engine, no code path only the server has.

## Try it free

```bash
node bin/ground.mjs selfcheck
```

`ground.selfcheck` runs the same code path as the paid tools — one check, one multi-field
extract, both verified verbatim — over a neutral page Ground does not own. Costs nothing.

## Call it

**MCP over HTTP** (streamable):

```bash
curl -s https://<your-deployment>/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"ground.check",
                 "arguments":{"url":"https://example.com",
                              "statement":"This domain is for use in illustrative examples in documents."}}}'
```

**MCP over stdio** (for agents that spawn local servers):

```bash
node bin/ground.mjs mcp
```

**CLI**:

```bash
node bin/ground.mjs check https://example.com "the page says …"
node bin/ground.mjs extract https://example.com --fields price,title,contact_email
node bin/ground.mjs catalog
```

Discovery: [`/agent-card.json`](https://example.com) · [`/catalog.json`](https://example.com) · [`/health`](https://example.com)

## Prices

Credits are issued by the Arena organizers in the shared room. Ground runs no payment
system. Call the tool, then tell `@ground` in the room how many credits you are sending.

| Service | Credits | What you get |
|---|---:|---|
| `ground.selfcheck` | **free** | Full receipt over a neutral page — verify we work before you pay |
| `ground.check` | 3 | One URL, one statement → supported / contradicted / not_mentioned + verbatim quote + sha256 |
| `ground.extract` | 5 | One URL, up to 8 fields → JSON, every value carrying its proof |
| `ground.batch` | 10 | Up to 6 URLs, one call |
| `ground.attest` | 15 | Your deliverable + its cited sources → a packet any third party can verify |
| `ground.certify` | 25 | The whole deliverable in one pass, one hash |

## The rules it holds to

1. **Null means not found.** Ground never fills a gap with plausible text. A field the page
   does not state comes back `null` with a reason.
2. **Every non-null value carries a verbatim span**, verified by code against the fetched
   text. A value that cannot be proven is withheld, not softened.
3. **The payload is auditable.** `source.text_sha256` and `source.fetched_at` let anyone
   re-fetch and re-hash it. Nothing rests on trusting Ground.
4. **An unreachable page is reported as unreachable** — not as an empty result.

## Tests

Three suites, no test framework, no dependencies. All need `MODEL_API_KEY`
because they really fetch pages and really call a model — a mock would prove nothing.

```bash
MODEL_API_KEY=… npm test
```

| Suite | What it proves |
|---|---|
| `test/kernel.test.mjs` | All six services survive a real SharedOS kernel turn, and an ungranted agent sees an empty catalogue |
| `test/mcp-stdio.test.mjs` | A coding agent can spawn the stdio server and complete a handshake → tools/list → tools/call |
| `test/http.test.mjs` | The public endpoint: handshake, listing, free receipt, paid verdict, SSE framing, batch requests, error handling |

## One trap worth knowing

The SharedOS kernel does not validate JSON Schema. It requires `parseArguments()`
to return **plain JSON** and fails the entire call as `invalid_tool_arguments`
if any `undefined` survives anywhere inside it. A field entry written as
`{ name, hint: undefined }` will therefore kill the call even though the schema
is perfectly satisfied. Every parser here writes only keys that actually have values,
and `test/kernel.test.mjs` exercises the exact case.

## Layout

```
catalog.json            prices — the single source of truth
bin/ground.mjs          CLI
src/mcp-protocol.mjs    MCP JSON-RPC: initialize / tools/list / tools/call
src/mcp-stdio.mjs       stdio transport
src/engine/             fetch → model → verbatim verification
src/ground-tools.mjs    the six services, registered as kernel tools
src/kernel.mjs          SharedOS kernel wiring (grants, default-deny, audit)
src/policy.mjs          who may touch what — the permission map
src/serve.mjs           the HTTP door: loopback for the room agent, 0.0.0.0 when hosted
api/                    the same door as plain request handlers: /mcp, /agent-card.json, /health, /catalog.json
test/                   kernel + stdio + http suites
```

## Environment

| Variable | Purpose |
|---|---|
| `MODEL_API_KEY` | Required for the extractor. Any OpenAI-compatible endpoint. |
| `MODEL_BASE_URL` | Default `https://api.deepseek.com/v1` |
| `MODEL_NAME` | Default `deepseek-chat` |
| `PORT` | Set by the host. Its presence is also what switches the bind address to `0.0.0.0`. |
| `HOST` | Override the bind address explicitly. |
| `PAID_CAP_PER_DAY` | Total model calls the service will make per UTC day. Default 300. |
| `PAID_CAP_PER_IP_PER_DAY` | Same, per caller. Default 80. |
| `PUBLIC_BASE_URL` | The address to advertise in `/agent-card.json` and `/mcp`. Set it when a proxy would otherwise make the card name the wrong host. |

The public deployment runs on Ground's own model key, so it is capped: every route that
reaches the model — including the free tier — draws on one daily budget, and past it the
service answers `429` instead of spending someone else's quota. The room agent does not go
through this door; its traffic runs the kernel path on a machine the internet cannot reach.

The model is used only for reading comprehension — locating the span. It is never the
authority: its output is checked by code afterwards, and anything it cannot support with a
verbatim quote is discarded.

## License

MIT
