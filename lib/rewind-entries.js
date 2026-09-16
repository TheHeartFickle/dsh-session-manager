// dsh-session-manager — rewind 条目扫描（host 侧）。
// 从会话日志提取全部真实用户输入，供回退选择器在「聊天窗口未加载早期轮次」
// 时仍能列出全部回退点（BUGS.md S1 / SPEC.md §1.2）。
//
// 过滤规则（按真实日志普查 + 官方投影实现确定）：
// - 只保留 data.source.kind === "user" 的 user/message 事件；合成消息
//   （agent-instructions / skill-catalog / plugin / system-reminder 包装）的
//   source.kind 均非 "user"，自然排除。
// - steering 插话（内核从 next-step 队列认领的输入）同样是 source.kind
//   === "user"，聊天投影里是独立的 steering kind，必须按队列轨迹识别后剔除
//   （BUGS.md S9 / SPEC.md §1.2）；判定算法与官方 UI 的 SteeringHistory 一致。
// - turn 号按 turn/start 顺序推导（user/message 行自身不携带 turn）。
// - 压缩底线（BUGS.md S8）：最后一个 compaction/end 之前的真实输入不进入列表。
//
// fork 边界（BUGS.md S9）：0.1.5 的 sessions.fork 把 atSeq 向前吸附到首个
// turn/end，再把切片推进到其后的 turn/start。因此边界只能取「已闭合 turn 的
// turn/end seq」——取选中输入所在 turn 之前最后一个 turn/end，切片正好停在
// 该 turn 的 turn/start 之前（选中输入不入种子）；压缩段若位于该 turn 之前，
// 也会被切片完整携带。前序 turn 未闭合（日志里缺 turn/end，例如 agent 被杀）
// 时边界回落到更早的已闭合 turn：未闭合 turn 不能作为合法种子结尾
// （_forkSeed 拒绝停在未闭合 turn），只能连同选中输入一起撤销。这种“会连带
// 撤销未闭合回合”的条目带 `dropsOpenTurns: true`，客户端在弹窗里给出提示
// （SPEC.md §1.4）。
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

// 重放 agent/inbox/spliced 队列，取出被 next-step 队列认领过的输入 id：
// 这些 user/message 是插话（聊天投影 kind === "steering"），不是用户发起的
// 回合输入。算法与官方 SteeringHistory（ui-chat）逐句对应。
function collectSteeringIds(events) {
  const queues = { "next-turn": [], "next-step": [] };
  const claimed = new Set();
  const steering = new Set();
  for (const event of events) {
    if (event.type === "agent/inbox/spliced") {
      const { target, start = 0, removedCount = 0, inserted = [], outcome } = event.data ?? {};
      const queue = queues[target];
      if (queue === undefined) continue;
      const removed = queue.splice(start, removedCount, ...inserted);
      for (const identity of inserted) claimed.delete(identity?.id);
      if (target !== "next-step" || outcome === "canceled") continue;
      for (const identity of removed) claimed.add(identity?.id);
    } else if (event.type === "user/message") {
      const id = event.data?.id;
      if (!claimed.delete(id)) continue;
      if (event.data?.source?.kind === "user") steering.add(id);
    }
  }
  return steering;
}

function collectUserInputs(events) {
  // 压缩底线：最后一个 compaction/end 的 seq。压缩之前的真实输入不再是回退点
  // （BUGS.md S8）；压缩之后的输入，其边界落在底线之前一格，fork 前推切片时
  // 完整携带 compaction/* 段，子会话投影重放后仍是压缩检查点状态。
  let floor = -1;
  for (const event of events) {
    if (event.type === "compaction/end") floor = event.seq;
  }

  const steering = collectSteeringIds(events);

  const inputs = [];
  let turn = 0;
  // 回退边界：最近一个已闭合回合的 turn/end seq（见文件头说明）。
  let boundary = null;
  // boundary 所属的回合号：用于判断选中条目与它之间是否夹着未闭合回合。
  let closedTurn = 0;
  for (const event of events) {
    if (event.type === "turn/start") {
      turn += 1;
      continue;
    }
    if (event.type === "turn/end") {
      boundary = event.seq;
      closedTurn = turn;
      continue;
    }
    if (event.type !== "user/message" || event.seq <= floor) continue;
    const data = event.data ?? {};
    if ((data.source ?? {}).kind !== "user") continue;
    if (steering.has(data.id)) continue;
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    // boundary === null：此前没有任何已闭合回合（会话第一条输入，且它所在的
    // turn 也没闭合过）；回退到它之前等于空会话，客户端按既有约定剔除该条目。
    const entry = { seq: event.seq, turn, text, time: event.time ?? null, boundary };
    // 边界与选中回合之间夹着未闭合回合（缺 turn/end）：fork 只能切到边界的
    // 下一个 turn/start，那些未闭合回合会被一并撤销 —— 客户端据此给用户提示。
    if (boundary !== null && closedTurn < turn - 1) entry.dropsOpenTurns = true;
    inputs.push(entry);
  }
  return inputs;
}
