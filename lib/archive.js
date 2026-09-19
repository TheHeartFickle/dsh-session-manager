// dsh-session-manager — archive host half（适配层领域模块）。
// 提供归档会话管理 API：
//   GET  /api/session-manager/archives/list         -> { ok, archived: [...] }
//   POST /api/session-manager/archives/unarchive    -> { ok }
//   POST /api/session-manager/archives/delete       -> { ok }
//   POST /api/session-manager/archives/delete-all   -> { ok, results: [...] }
//
// 说明：
// - “归档”本身只是 workspace.json 中 archivedSessionIds 的一个 id；
//   本模块用官方公开的 workspaceRegistry.archiveSession/unarchiveSession
//   增删它，registry 自己会广播 workspace 状态，让其它标签页同步。
// - delete 会删除磁盘上的会话目录，并从 live store、workspace 记账、
//   archivedSessionIds、session_projcache 中移除；正在运行的会话拒绝删除。
// - 该模块针对当前 dsh JSONL 存储布局实现；如果部署使用了其它持久化后端，
//   文件删除部分可能需要按后端调整。
//
// 官方触点（0.1.6，仅本模块与 lib/dsh-adapter.js 允许出现）：
// - sessionPersistence.stat(id) 是单会话观察入口（list() 是整库扫描）；
// - sessionPersistence.locate(header) 取自 JSONL 后端（上游无公开的
//   「会话目录在哪」API），用于把 header 换成磁盘路径；
// - sessions/agents 的 store + detachEntered 是上游私有成员，上游没有
//   公开的「摘掉一个 live 会话」API；
// - api-session/removed 是官方声明并转发给客户端的「会话离开宿主注册表」事件。

import { rm } from "node:fs/promises";
import { dirname } from "node:path";

const name = "dsh-session-manager/archive";

async function removeProjectionCacheRow(ctx, sessionId) {
  const cache = ctx.get?.("sessionProjectionCache");
  if (cache?.table) await cache.table.delete(sessionId);
}

// 单条观察失败不得让整份归档列表失败（storage 故障在删除路径上仍会照常抛出）。
async function storedSnapshot(ctx, sessionId) {
  try {
    return await ctx.sessionPersistence.stat(sessionId);
  } catch {
    return undefined;
  }
}

function liveHeader(ctx, sessionId) {
  return ctx.get?.("sessions")?.get?.(sessionId)?.header;
}

async function listArchived(ctx) {
  const archived = [...ctx.workspaceRegistry.archivedSessionIds];
  const snapshots = await Promise.all(archived.map((id) => storedSnapshot(ctx, id)));
  const sessions = ctx.get?.("sessions");
  const agents = ctx.get?.("agents");
  const workspaces = ctx.workspaceRegistry.list();

  const items = archived.map((id, index) => {
    const snapshot = snapshots[index];
    const live = sessions?.get?.(id);
    const header = live?.header ?? snapshot?.header;
    const workspace = workspaces.find((w) => w.path === header?.cwd || w.record?.sessionIds?.includes(id));
    return {
      id,
      cwd: header?.cwd ?? null,
      createdAt: header?.createdAt ?? null,
      size: snapshot?.sizeBytes ?? null,
      exists: snapshot !== undefined,
      live: live !== undefined,
      running: agents?.get?.(id)?.status === "running",
      workspaceId: workspace?.id ?? null,
      workspaceTitle: workspace?.title ?? null
    };
  });

  return { ok: true, archived: items };
}

async function unarchiveSession(ctx, sessionId) {
  await ctx.workspaceRegistry.unarchiveSession(sessionId);
  return { ok: true };
}

// 删除「已打开但空闲」的 live 会话时，光删磁盘文件不够：内存 session store 里
// 仍保留这个会话对象，客户端 session.list 还会看到它。这里直接从内存 store
// 摘除 session/agent 条目，触发 session/disposed -> api-session/removed，
// 让客户端立即移除该行。
function detachLiveSession(ctx, sessionId) {
  const agents = ctx.get?.("agents");
  const agentEntry = agents?.store?.get?.(sessionId);
  if (agentEntry && typeof agents.detachEntered === "function") {
    agents.detachEntered(agentEntry);
  }

  const sessions = ctx.get?.("sessions");
  const sessionEntry = sessions?.store?.get?.(sessionId);
  if (sessionEntry && typeof sessions.detachEntered === "function") {
    sessions.detachEntered(sessionEntry);
  }
}

async function deleteSession(ctx, sessionId) {
  const registry = ctx.workspaceRegistry;

  if (!registry.archivedSessionIds.includes(sessionId)) {
    return { ok: false, error: "not-archived", message: "session is not archived" };
  }

  // 只有真正在运行的会话才拒绝删除；已打开但空闲的 live 会话允许删除，
  // 否则“归档后仍开着的旧会话”会永远删不掉。
  const agents = ctx.get?.("agents");
  if (agents?.get?.(sessionId)?.status === "running") {
    return { ok: false, error: "running", message: "session is still running; stop it before deleting" };
  }

  // 1) 删除磁盘会话目录（JSONL 后端：<root>/<project>/<session-id>/）。
  const snapshot = await ctx.sessionPersistence.stat(sessionId);
  if (snapshot !== undefined) {
    const loc = ctx.sessionPersistence.locate(snapshot.header);
    await rm(dirname(loc.path), { recursive: true, force: true });
  }

  // 2) 摘掉内存里的 live 会话，并让每个客户端目录丢掉这一行。
  //    客户端的会话目录只由 host 事件维护：live 会话被摘除时会自动发出
  //    api-session/removed，而冷会话没有可 dispose 的对象，只能在这里显式
  //    宣告。顺序是行为契约的一部分 —— 必须先宣告、后改记账：只要客户端
  //    手里还留着这一行，工作区记账或归档集合一变动，它就会被投影成
  //    「未分组」并一直显示到下一次刷新（BUGS.md S10）。重复宣告是幂等的。
  try {
    detachLiveSession(ctx, sessionId);
  } catch (error) {
    ctx.logger?.warn?.(`dsh-session-manager: detach live session failed: ${String(error?.message ?? error)}`);
  }
  ctx.emit("api-session/removed", sessionId);

  // 3) 从 workspace 记账中摘除。
  for (const workspace of registry.list()) {
    const raw = workspace.record?.sessionIds;
    if (Array.isArray(raw) && raw.includes(sessionId)) {
      await workspace.detachSession(sessionId);
    }
  }

  // 4) 从归档集合移除（官方公开 API）。
  await registry.unarchiveSession(sessionId);

  // 5) 移除投影缓存。
  await removeProjectionCacheRow(ctx, sessionId);

  return { ok: true };
}

async function deleteMany(ctx, ids) {
  const results = [];
  for (const id of ids) {
    try {
      const result = await deleteSession(ctx, id);
      results.push({ id, ok: result.ok, error: result.ok ? null : result.error, message: result.ok ? null : result.message ?? null });
    } catch (error) {
      results.push({ id, ok: false, error: "unexpected", message: String(error?.message ?? error) });
    }
  }
  return { ok: true, results };
}

async function ungroupedArchivedIds(ctx) {
  const ids = [...ctx.workspaceRegistry.archivedSessionIds];
  const snapshots = await Promise.all(ids.map((id) => storedSnapshot(ctx, id)));
  const workspaces = ctx.workspaceRegistry.list();
  return ids.filter((id, index) => {
    const header = liveHeader(ctx, id) ?? snapshots[index]?.header;
    return !workspaces.find((w) => w.path === header?.cwd || w.record?.sessionIds?.includes(id));
  });
}

export function createArchive(ctx) {
  // 操作层（官方服务触点：workspaceRegistry / sessionPersistence / agents /
  // sessionProjectionCache / sessions）。返回 { status, body }，
  // HTTP 状态码语义与旧版 handle 分发逐字段一致；由通道层投影
  // （HTTP：lib/index.js；标准命令：lib/commands.js 的 project()）。
  const list = async () => ({ status: 200, body: await listArchived(ctx) });

  const unarchive = async (sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: 400, body: { ok: false, error: "bad-session", message: "sessionId is required" } };
    }
    return { status: 200, body: await unarchiveSession(ctx, sessionId) };
  };

  const del = async (sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: 400, body: { ok: false, error: "bad-session", message: "sessionId is required" } };
    }
    const result = await deleteSession(ctx, sessionId);
    if (!result.ok) {
      return { status: result.error === "running" || result.error === "live" ? 409 : 500, body: result };
    }
    return { status: 200, body: result };
  };

  const deleteAll = async () => {
    const ids = [...ctx.workspaceRegistry.archivedSessionIds];
    return { status: 200, body: await deleteMany(ctx, ids) };
  };

  const deleteUngrouped = async () => {
    const ids = await ungroupedArchivedIds(ctx);
    return { status: 200, body: await deleteMany(ctx, ids) };
  };

  return { list, unarchive, del, deleteAll, deleteUngrouped };
}

export { name };
