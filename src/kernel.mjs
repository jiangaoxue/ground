// kernel.mjs —— 把 SharedOS 内核装起来。
//
// 关键点：内核跑在我们的进程里；权威（grants）来自我们自己的可信存储；
// 每一次调用都会被重新授权一次（discovery 不等于 permission）。

import {
  CapabilityAuthorizer,
  SharedOSKernel,
  InMemoryGrantUsageStore,
  registerStandardOsTools,
  createEscalationTool,
} from "@aicoo/sharedos";

import { grantsFor, NAMESPACE } from "./policy.mjs";
import { createMemoryFiles } from "./memory.mjs";
import { createJsonlAuditSink } from "./audit.mjs";

export function buildKernel({ auditPath = "audit/audit.jsonl", seed = {} } = {}) {
  const files = createMemoryFiles({ seed });
  const audit = createJsonlAuditSink(auditPath);

  const kernel = new SharedOSKernel({
    // 唯一的权威入口：每次 turn 从这个可信 store 重新读一遍
    grantSource: {
      async load(access) {
        return grantsFor(access);
      },
    },
    // maxUses 这类"有界授权"必须有地方计数，否则内核直接拒绝（fail closed）
    authorizer: new CapabilityAuthorizer({ usageStore: new InMemoryGrantUsageStore() }),
    audit,
  });

  // 注册文件能力（暴露 ≠ 授权；授权只来自 grant）
  kernel.registerResourceProvider(files);
  registerStandardOsTools(kernel, { files });

  // 升级工具：agent 遇到"我不能做"时，停下来问人，而不是硬闯
  kernel.registerTool(createEscalationTool());

  return { kernel, files, audit, namespaceId: NAMESPACE };
}
