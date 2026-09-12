// audit.mjs —— 审计落地。
//
// 官方把审计链当作"你到底有没有建在 SharedOS 上"的判据：
//   "We check the audit trail: if your turns aren't there, it isn't built on SharedOS."
// 所以这里把每一条决策（允许 / 拒绝 / 升级）都追加写进 JSONL，一行一条，不覆盖。

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function createJsonlAuditSink(filePath) {
  const abs = resolve(filePath);
  mkdirSync(dirname(abs), { recursive: true });
  let count = 0;

  return {
    /** SharedOS 的 AuditSink 只有一个方法：record(event) */
    async record(event) {
      appendFileSync(abs, JSON.stringify(event) + "\n", "utf8");
      count += 1;
    },
    path: abs,
    count: () => count,
  };
}
