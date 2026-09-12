// ground-tools.mjs —— 把 Ground 服务注册成内核里的真工具。
//
// 这是"挂在 SharedOS 上"的那一步：ground.* 不再是普通 HTTP 端点，而是跑在
// SharedOS 内核里的工具——谁能调、调哪类、purpose 是什么，全部由 grants 决定；
// 每次调用都过三道闸门并落审计链。
//
// requiredCapability 由内核在每次调用前检查（namespace "ground" + action 名）。
// 没有 grant 的 agent 连工具目录里都看不到它（withheld）。policy.mjs 里那张
// 授权表因此就是产品的价目表在内核里的镜像——卖什么，就必须先授权什么。

import {
  check as engineCheck,
  extract as engineExtract,
  batch as engineBatch,
  attest as engineAttest,
  certify as engineCertify,
} from "./engine/ground.js";
import { callSelfcheck } from "./mcp-protocol.mjs";

const catalog = JSON.parse(
  await import("node:fs/promises").then((fs) => fs.readFile(new URL("../catalog.json", import.meta.url), "utf8"))
);
const CREDITS = Object.fromEntries(
  [...(catalog.services || []), ...(catalog.free || [])].map((s) => [s.name, s.credits])
);

function toolDefinition({ name, action, description, inputSchema, price }) {
  return {
    name,
    description: `${description} COST: ${price === 0 ? "FREE" : `${price} Arena credits`} per call.`,
    namespace: "ground",
    source: "host", // 我们自己的工具，不是 sharedos 标准工具
    readWrite: "read", // 只读外部世界：取网页 + 判断，不写任何资源
    inputSchema,
    requiredCapability: {
      resource: { namespace: "ground", path: [] },
      action,
    },
    annotations: { readOnly: true },
  };
}

const URL_STR = { type: "string", pattern: "^https?://", maxLength: 2048 };

const FIELDS = {
  type: "array",
  minItems: 1,
  maxItems: 8,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 60 },
      hint: { type: "string", maxLength: 160 },
    },
  },
};

const obj = (props, required) => ({ type: "object", additionalProperties: false, required, properties: props });

// parseArguments 必须返回**纯 JSON**。内核不校验 JSON Schema，但它会把解析结果
// 过一遍 JSON 往返；任何一个 `undefined` 都会让整条调用被判 invalid_tool_arguments。
// 所以拼字段时只写确实有值的键，绝不写 `hint: undefined`。
function cleanFields(list, key = "fields") {
  return (Array.isArray(list) ? list : []).slice(0, 8).map((f) => {
    const item = { name: String(f?.name || "") };
    if (!item.name) throw new Error(`${key}: every entry needs a name`);
    if (f?.hint) item.hint = String(f.hint).slice(0, 160);
    return item;
  });
}

function cleanClaims(list) {
  return (Array.isArray(list) ? list : []).slice(0, 10).map((c) => ({
    statement: String(c?.statement || c?.claim || "").slice(0, 400),
    url: String(c?.url || ""),
  }));
}

const SPECS = [
  {
    name: "ground.check",
    action: "check",
    schema: obj({ url: URL_STR, statement: { type: "string", minLength: 1, maxLength: 600 } }, ["url", "statement"]),
    description:
      "Test one statement against one web page. Fetches the page, asks the model to locate the supporting span, then verifies that span against the fetched text BY CODE. Returns verdict + verbatim quote + sha256 of the page text.",
    parse: (a) => {
      const url = String(a.url || "");
      const statement = String(a.statement || a.claim || "");
      if (!/^https?:\/\//i.test(url)) throw new Error("url must be http/https");
      if (!statement) throw new Error("statement is required");
      return { url, statement: statement.slice(0, 600) };
    },
    run: (args) => engineCheck(args),
  },
  {
    name: "ground.extract",
    action: "extract",
    schema: obj({ url: URL_STR, fields: FIELDS }, ["url", "fields"]),
    description:
      "Extract named fields from one web page. Every non-null value carries a verbatim span that code verified against the fetched text; a field the page does not state comes back null with a reason.",
    parse: (a) => {
      const url = String(a.url || "");
      if (!/^https?:\/\//i.test(url)) throw new Error("url must be http/https");
      const fields = cleanFields(a.fields);
      if (!fields.length) throw new Error("fields (non-empty array) is required");
      return { url, fields };
    },
    run: (args) => engineExtract(args),
  },
  {
    name: "ground.batch",
    action: "batch",
    schema: obj({ items: { type: "array", minItems: 1, maxItems: 6, items: obj({ url: URL_STR, fields: FIELDS }, ["url", "fields"]) } }, ["items"]),
    description: "Up to six URLs in one call, each grounded by the same rules as ground.extract.",
    parse: (a) => {
      const raw = (Array.isArray(a.items) ? a.items : []).slice(0, 6);
      if (!raw.length) throw new Error("items (non-empty array of {url, fields}) is required");
      const items = raw.map((it) => {
        const url = String(it?.url || "");
        if (!/^https?:\/\//i.test(url)) throw new Error("every item needs an http/https url");
        return { url, fields: cleanFields(it?.fields) };
      });
      return { items };
    },
    run: (args) => engineBatch(args),
  },
  {
    name: "ground.attest",
    action: "attest",
    schema: obj(
      {
        claims: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: obj({ statement: { type: "string", minLength: 1, maxLength: 400 }, url: URL_STR }, ["statement", "url"]),
        },
      },
      ["claims"]
    ),
    description:
      "Read each cited source now and test each claim against the source named for it, then return one packet with a single hash. A seller cannot produce this for itself: self-attestation is worth nothing.",
    parse: (a) => {
      const claims = cleanClaims(a.claims).filter((c) => c.statement && c.url);
      if (!claims.length) throw new Error("claims (non-empty array of {statement, url}) is required");
      return { claims };
    },
    run: (args) => engineAttest(args),
  },
  {
    name: "ground.certify",
    action: "certify",
    schema: obj(
      {
        sources: { type: "array", maxItems: 6, items: obj({ url: URL_STR, fields: FIELDS }, ["url", "fields"]) },
        claims: {
          type: "array",
          maxItems: 10,
          items: obj({ statement: { type: "string", minLength: 1, maxLength: 400 }, url: URL_STR }, ["statement", "url"]),
        },
      },
      []
    ),
    description:
      "The whole deliverable in one pass: every cited source read now, every claim tested against the source it names, one hash over the lot.",
    parse: (a) => {
      const sources = (Array.isArray(a.sources) ? a.sources : []).slice(0, 6).map((s) => {
        const url = String(s?.url || "");
        if (!/^https?:\/\//i.test(url)) throw new Error("every source needs an http/https url");
        return { url, fields: cleanFields(s?.fields) };
      });
      const claims = cleanClaims(a.claims).filter((c) => c.statement && c.url);
      if (!sources.length && !claims.length) throw new Error("sources and/or claims is required");
      return { sources, claims };
    },
    run: (args) => engineCertify(args),
  },
  {
    name: "ground.selfcheck",
    action: "selfcheck",
    schema: obj({ url: URL_STR }, []),
    description:
      "FREE. A full receipt over a neutral page Ground does not own, using the same code path as the paid tools. Run it before you pay, then re-run it yourself and compare the sha256.",
    parse: (a) => (a.url ? { url: String(a.url) } : {}),
    run: (args) => callSelfcheck(args),
  },
];

export function createGroundTools() {
  return SPECS.map((spec) => ({
    definition: toolDefinition({
      name: spec.name,
      action: spec.action,
      description: spec.description,
      inputSchema: spec.schema,
      price: CREDITS[spec.name] ?? null,
    }),
    parseArguments: spec.parse,
    async invoke(context, call, signal) {
      signal.throwIfAborted();
      const result = JSON.parse(JSON.stringify(await spec.run(call.arguments))); // 内核要求纯 JSON（undefined 会违约）
      return {
        callId: call.id,
        tool: spec.name,
        completedAt: new Date().toISOString(),
        status: "succeeded",
        output: result,
      };
    },
  }));
}

export { CREDITS };
