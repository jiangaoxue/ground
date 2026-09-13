// policy.mjs —— 这张表就是评委要看的「谁可以碰什么」的地图。
//
// 规则：每个格子是一条 grant。**空格子不是"没人想过"，是"没人给过授权"** —— 默认拒绝。
// 改权限 = 改这张表，别的地方都不用动。

import {
  agentExecutionCapability,
  ESCALATION_TOOL_NAMESPACE,
  ESCALATION_RESOURCE_PATH,
  ESCALATION_ACTION,
  MESSAGING_NAMESPACE,
} from "@aicoo/sharedos";

/** 一个 purpose 串起整条工作流。提交时要交给主办方，他们靠这个在审计链里找我们的 turn。 */
export const PURPOSE = "arena-service-probe";

/** 租户边界（SharedOS 里叫 namespaceId）。 */
export const NAMESPACE = "ground";

/** 谁拥有这些资源 —— 授权都从这个人发出。 */
export const owner = { kind: "human", userId: "jiang-aoxue" };

/** 产品里的两个 agent。提交时要交的"agent address"就是这两个。 */
export const agents = {
  probe: { kind: "agent", agentId: "ground-probe" },
  reporter: { kind: "agent", agentId: "ground-reporter" },
};

/**
 * 记忆即文件。
 * 一个 agent 该记住的、该分享的、该被挡在外面的，全都是一条路径。
 */
export const TREE = {
  "Work/probe/inbox": "待探测的服务地址（probe 读）",
  "Work/probe/out": "原始探测记录（probe 写 → reporter 读）",
  "Work/private/probe": "probe 的私人草稿（reporter 无权）",
  "Work/receipts": "对外的回执（reporter 写）",
  "Work/finance": "谁都不给 —— 默认拒绝的活证据",
};

const file = (id, subject, path, actions, scope = "descendants") => ({
  id,
  namespaceId: NAMESPACE,
  subject,
  issuer: owner,
  capabilities: [
    {
      resource: { namespace: "files", path: path.split("/"), owner },
      actions,
      scope,
    },
  ],
  constraints: {
    purposes: [PURPOSE],
    expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
  },
  issuedAt: new Date(Date.now() - 60_000).toISOString(), // 回拨1分钟：内核要求 issuedAt <= admittedAt，执行时才生成会踩毫秒竞态
});

const exec = (id, agent) => ({
  id,
  namespaceId: NAMESPACE,
  subject: agent,
  issuer: owner,
  capabilities: [agentExecutionCapability(agent, owner)],
  constraints: {
    purposes: [PURPOSE],
    expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
  },
  issuedAt: new Date(Date.now() - 60_000).toISOString(), // 回拨1分钟：内核要求 issuedAt <= admittedAt，执行时才生成会踩毫秒竞态
});

/**
 * 全部 grant。注意 Work/finance 一行也没有 —— 那是故意的。
 */
export function buildGrants() {
  return [
    // 运行授权：没有这条，turn 在动手之前就会被拒
    exec("g-exec-probe", agents.probe),
    exec("g-exec-reporter", agents.reporter),

    // 服务授权：probe 可以调的 ground.* 动作。
    // 这张列表就是"后厨能出的菜"——只有列在这里的，agent 才敢在外面报价。
    // Work/finance 一行授权都没有，默认拒绝仍然可复现。
    {
      id: "g-ground-probe",
      namespaceId: NAMESPACE,
      subject: agents.probe,
      issuer: owner,
      capabilities: [
        {
          // 实测（scope 矩阵）：工具目录发现要求 grant 资源不带 owner、scope=exact
          resource: { namespace: "ground", path: [] },
          actions: ["check", "extract", "batch", "attest", "proof", "certify", "selfcheck"],
          scope: "exact",
        },
      ],
      constraints: {
        purposes: [PURPOSE],
        expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
      },
      issuedAt: new Date(Date.now() - 60_000).toISOString(), // 回拨1分钟：内核要求 issuedAt <= admittedAt，执行时才生成会踩毫秒竞态
    },

    // probe
    file("g-probe-inbox", agents.probe, "Work/probe/inbox", ["search", "read", "grep"]),
    file("g-probe-out", agents.probe, "Work/probe/out", ["create", "append", "replace", "read"]),
    file("g-probe-private", agents.probe, "Work/private/probe", ["create", "read"]),

    // reporter
    file("g-reporter-read-out", agents.reporter, "Work/probe/out", ["search", "read", "grep"]),
    file("g-reporter-receipts", agents.reporter, "Work/receipts", ["create", "append", "read"]),

    // 消息授权：probe 可以给 reporter 发消息（一对发送者→接收者一条）
    // 注意：消息**永远不携带权限**。
    {
      id: "g-msg-probe-to-reporter",
      namespaceId: NAMESPACE,
      subject: agents.probe,
      issuer: owner,
      capabilities: [
        {
          resource: { namespace: MESSAGING_NAMESPACE, path: [], owner },
          actions: ["send"],
          scope: "descendants",
        },
      ],
      constraints: { purposes: [PURPOSE], expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() },
      issuedAt: new Date(Date.now() - 60_000).toISOString(), // 回拨1分钟：内核要求 issuedAt <= admittedAt，执行时才生成会踩毫秒竞态
    },

    // 升级授权：只有 reporter 可以在"这事我做不了"时停下来问人。
    // 升级是它自己的结局（escalated），不是拒绝。
    {
      id: "g-escalate-reporter",
      namespaceId: NAMESPACE,
      subject: agents.reporter,
      issuer: owner,
      capabilities: [
        {
          resource: { namespace: ESCALATION_TOOL_NAMESPACE, path: ESCALATION_RESOURCE_PATH, owner },
          actions: [ESCALATION_ACTION],
          scope: "exact",
        },
      ],
      constraints: { purposes: [PURPOSE], expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() },
      issuedAt: new Date(Date.now() - 60_000).toISOString(), // 回拨1分钟：内核要求 issuedAt <= admittedAt，执行时才生成会踩毫秒竞态
    },
  ];
}

/** 给某个 actor + 某个 authority 的 grant 子集。trusted store 的职责就在这里。 */
export function grantsFor({ namespaceId, actor, authority }) {
  const key = (a) => JSON.stringify(a);
  return buildGrants().filter(
    (g) =>
      g.namespaceId === namespaceId &&
      key(g.subject) === key(actor) &&
      key(g.issuer) === key(authority)
  );
}

/** 组装一个可信上下文。这些值必须来自服务端状态，绝不能来自请求体/消息/模型输出。 */
export function contextFor(agent, purpose = PURPOSE) {
  return {
    namespaceId: NAMESPACE,
    actor: agent,
    authority: owner,
    owner,
    purpose,
    traceId: crypto.randomUUID(),
    enabledToolNamespaces: ["files", ESCALATION_TOOL_NAMESPACE],
    now: new Date().toISOString(),
  };
}
