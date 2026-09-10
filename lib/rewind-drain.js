// dsh-session-manager — 回退子会话的继承队列清理（host 侧）。
//
// 0.1.x 的 fork 以「种子回放」重建子会话：日志里的 agent/inbox/spliced 是
// 普通日志事件，会把父会话未消费的 durable 排队消息（agent 忙时入队、从未
// 被回合认领的输入）一并带进子会话。后果（BUGS.md S7）：回退后用户发送的
// 消息按 FIFO 排到陈旧队列尾部，新回合却认领队头 —— 把陈旧消息当成输入发
// 出，用户的消息滞留排队；反复回退时同一文本逐代累加。
//
// 处理：客户端在 sessions.open(childId) 之后调用本模块；这里等 fork 子会话
// 的 agent 上线（resume 在 open 时异步发生），随后用官方 agent.inbox.clear()
// 把继承的排队输入全部作废。回合只在 prompt 投递时开启，activate 本身不认
// 领队列，因此清空发生在用户可发送之前。
const POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 15000;

export async function drainInheritedInbox(ctx, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const agent = ctx.get("agents")?.get?.(sessionId);
    const inbox = agent?.inbox;
    if (inbox) {
      const cleared = inbox.nextTurn.length + inbox.nextStep.length;
      if (cleared > 0) inbox.clear();
      return { ok: true, cleared };
    }
    if (Date.now() >= deadline) {
      return { ok: false, error: "agent-not-live", message: "forked session agent did not come live in time" };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
