// dsh-session-manager — rewind 条目扫描（host 侧）。
// 从会话日志提取全部真实用户输入，供回退选择器在「聊天窗口未加载早期轮次」
// 时仍能列出全部回退点（BUGS.md S1 / SPEC.md §1.2）。
//
// 过滤规则（按真实日志普查确定）：
// - 只保留 data.source.kind === "user" 的 user/message 事件；
//   steering 插话不会生成 user/message 行，合成消息（agent-instructions /
//   skill-catalog / plugin / system-reminder 包装）的 source.kind 均非 "user"，
//   自然排除。
// - turn 号按 turn/start 顺序推导（user/message 行自身不携带 turn）。
// - 压缩底线（BUGS.md S8）：有压缩的会话不能回退到压缩之前 —— 最后一个
//   compaction/end 之前的真实输入不进入回退列表。
//
// 数据面（DSH 0.1.5）：sessionPersistence 已无整段明文日志读取接口；
// 读取改为 handle 模型 —— open(id, "read") + handle.read() 返回结构化事件
// （BUGS.md S5）。

export async function listUserInputs(ctx, sessionId) {
  const persistence = ctx.sessionPersistence;
  try {
    const snapshot = await persistence.stat(sessionId);
    if (!snapshot) {
      return { ok: false, error: "session-not-found", message: "session log not found" };
    }
    const handle = await persistence.open(sessionId, "read");
    let events;
    try {
      ({ events } = await handle.read());
    } finally {
      await handle.close();
    }
    return { ok: true, inputs: collectUserInputs(events) };
  } catch (error) {
    return { ok: false, error: "session-log-unreadable", message: error instanceof Error ? error.message : String(error) };
  }
}

function collectUserInputs(events) {
  // 压缩底线：最后一个 compaction/end 的 seq。回退不得早于压缩（BUGS.md S8）
  // —— 压缩之前的真实输入不再是回退点；压缩后第一条输入的边界取该底线，
  // fork 种子完整携带压缩段（compaction/* + 检查点 user/message），子会话
  // 投影重放时折叠回压缩检查点状态。
  let floor = -1;
  for (const event of events) {
    if (event.type === "compaction/end") floor = event.seq;
  }

  const anchors = [];
  let turn = 0;
  for (const event of events) {
    if (event.type === "turn/start") {
      turn += 1;
      continue;
    }
    if (event.type !== "user/message" || event.seq <= floor) continue;
    const data = event.data ?? {};
    if ((data.source ?? {}).kind !== "user") continue;
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    anchors.push({ seq: event.seq, turn, text, time: event.time ?? null });
  }

  // 每条输入自带 fork 边界（回退到它之前 = 种子切到 boundary 含）：
  // - 无压缩：跳过首条（回退到首条之前 = 空会话，无意义），boundary 为 null，
  //   由客户端剔除；其余边界 = 上一条输入的 seq。
  // - 有压缩：压缩后首条也可回退（回到压缩点重新开始），边界 = 压缩底线；
  //   其余 = 上一条压缩后输入的 seq。
  const inputs = [];
  let prev = floor >= 0 ? floor : null;
  for (const anchor of anchors) {
    inputs.push({ ...anchor, boundary: prev });
    prev = anchor.seq;
  }
  return inputs;
}
