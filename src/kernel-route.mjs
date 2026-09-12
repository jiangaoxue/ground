// ============================================================
// kernel-route.mjs — run one paid call as one SharedOS kernel turn.
//
// This is the spine of the product, so it has its own module: the HTTP
// door (serve.mjs) calls it, and the tests call it directly, which means
// the exact code path a buyer hits is the code path that gets tested.
//
// Two rules this module exists to enforce:
//
// 1. Every paid call is a kernel turn. Not "the engine runs and the
//    kernel is nearby": the executor resolves the authority, checks the
//    grant against the policy table, and only then invokes the tool —
//    and every one of those decisions lands in the audit chain.
//
// 2. Failures are never swallowed. The kernel reports a failed call as
//    a structured tool result (status: "failed", error: {code, message}).
//    The old version of this file only captured successful outputs, so a
//    buyer who mis-typed the arguments got back the useless word
//    "no_result" while the real reason — invalid_tool_arguments — sat in
//    the audit log where only we could read it. A product that sells
//    truthfulness does not get to hide its own errors.
// ============================================================

import { randomUUID } from "node:crypto";
import { SharedOSExecutor, StandardRuntime } from "@aicoo/sharedos";
import { publicBase } from "./receipt.mjs";
import { findToolSpec } from "./ground-tools.mjs";

/** The kernel's audit records for a trace, at a public address. */
export function auditUrlFor(traceId) {
  const base = publicBase();
  return base && traceId ? `${base}/audit?trace=${traceId}` : null;
}

export function createKernelRoute({ kernel, agents, owner, PURPOSE }) {
  if (!kernel || !agents?.probe || !owner || !PURPOSE) {
    throw new Error("createKernelRoute: kernel, agents.probe, owner and PURPOSE are required");
  }

  /** 跑一个内核 turn 去执行指定工具，返回该工具的原始输出。 */
  return async function runTool(tool, args, requestedBy = "arena-buyer") {
    const traceId = randomUUID();

    // The kernel reports invalid arguments as a fixed sentence ("The
    // requested tool arguments are invalid") and keeps the real reason —
    // e.g. "fields (non-empty array) is required" — to itself. So we run
    // the tool's own parser first, purely to capture the detail, and let
    // the kernel turn proceed anyway: the refusal belongs in the audit
    // chain, and the buyer gets the real message, not the generic one.
    let invalidDetail = null;
    const spec = findToolSpec(tool);
    if (spec) {
      try {
        spec.parse(args);
      } catch (e) {
        invalidDetail = String(e?.message || e);
      }
    }

    const context = {
      namespaceId: "ground",
      actor: agents.probe,
      authority: owner,
      owner,
      purpose: PURPOSE,
      traceId,
      enabledToolNamespaces: ["ground", "files"], // 实测：只写 ground 时目录为空
      now: new Date().toISOString(),
    };

    let captured = null;
    let failure = null;
    let step = 0;
    const driver = {
      async open() {
        return {
          async next(input) {
            if (input?.type === "tool_result") {
              const res = input.result;
              if (res?.status === "succeeded" && res.output && typeof res.output === "object") {
                captured = res.output;
              } else if (res && res.status !== "succeeded") {
                failure = {
                  code: res.error?.code || res.error || "tool_failed",
                  message: res.error?.message || "",
                };
              }
            }
            step += 1;
            if (step === 1) {
              return {
                type: "tool_call",
                call: {
                  id: randomUUID(),
                  tool,
                  arguments: args,
                  traceId,
                  requestedAt: new Date().toISOString(),
                },
              };
            }
            return { type: "complete", output: { done: true } };
          },
        };
      },
    };

    const tools = await kernel.listTools(context);
    const turn = await new SharedOSExecutor(kernel, new StandardRuntime(driver), {
      defaultMaxSteps: 6,
      defaultMaxToolCalls: 4,
      defaultTimeoutMs: 150_000,
    }).execute({
      version: "1",
      executionId: randomUUID(),
      agent: agents.probe,
      context,
      message: {
        version: "1",
        id: randomUUID(),
        sender: { kind: "agent", agentId: requestedBy },
        receiver: agents.probe,
        purpose: PURPOSE,
        payload: { text: `${tool} ${JSON.stringify(args).slice(0, 200)}` },
        traceId,
        createdAt: new Date().toISOString(),
      },
      tools: [...tools],
    });

    if (!captured) {
      return {
        ok: false,
        error: failure?.code || "no_result",
        message:
          (failure?.code === "invalid_tool_arguments" && invalidDetail) ||
          failure?.message ||
          "the kernel turn finished but the tool produced no output — see the audit chain for this trace",
        turn_status: turn.status,
        trace_id: traceId,
        audit_url: auditUrlFor(traceId),
      };
    }
    return { ...captured, trace_id: traceId, audit_url: auditUrlFor(traceId) };
  };
}
