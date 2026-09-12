// memory.mjs —— "文件即记忆"。
//
// SharedOS 不存你的数据，它只决定"能不能碰"。所以必须由我们提供一个 ResourceProvider
// 来真正读写。这里用一棵内存树代替磁盘，方便演示和测试；生产换成真文件系统/SQLite 即可。

export function createMemoryFiles({ seed = {} } = {}) {
  /** path 形如 "Work/probe/inbox/a.txt" */
  const files = new Map(Object.entries(seed));
  const events = [];

  const key = (path) => (Array.isArray(path) ? path.join("/") : String(path));

  return {
    namespace: "files",

    /** 只读快照，给外部检查用 */
    snapshot: () => Object.fromEntries(files),
    events: () => events.slice(),

    async invoke(operation, signal) {
      signal?.throwIfAborted?.();
      const p = key(operation.resource?.path ?? []);
      const action = operation.action;
      const input = operation.input ?? {};
      events.push({ action, path: p });

      const done = (output) => ({
        operationId: operation.operationId,
        completedAt: new Date().toISOString(),
        status: "succeeded",
        output,
      });

      switch (action) {
        case "search": {
          const q = String(input.query ?? "").toLowerCase();
          const hits = [...files.entries()]
            .filter(([k, v]) => k.startsWith(p) && (!q || `${k}\n${v}`.toLowerCase().includes(q)))
            .map(([k, v]) => ({ path: k, text: v }));
          return done({ hits });
        }
        case "grep": {
          const pat = String(input.pattern ?? "");
          let re = null;
          try { re = new RegExp(pat, input.caseSensitive ? "" : "i"); } catch { re = null; }
          const matches = [...files.entries()]
            .filter(([k, v]) => k.startsWith(p) && (re ? re.test(v) : v.includes(pat)))
            .map(([k, v]) => ({ path: k, text: v }));
          return done({ matches });
        }
        case "read": {
          if (!files.has(p)) return done({ path: p, text: null, found: false });
          return done({ path: p, text: files.get(p), found: true });
        }
        case "create":
        case "replace": {
          files.set(p, String(input.content ?? ""));
          return done({ path: p, bytes: String(input.content ?? "").length, written: true });
        }
        case "append": {
          files.set(p, (files.get(p) ?? "") + String(input.content ?? ""));
          return done({ path: p, bytes: files.get(p).length, written: true });
        }
        default:
          return done({ path: p, action, accepted: true });
      }
    },
  };
}
