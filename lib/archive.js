// dsh-session-manager — archive host half.
// 提供归档会话管理 API：
//   GET  /api/session-manager/archives/list         -> { ok, archived: [...] }
//   POST /api/session-manager/archives/unarchive    -> { ok }
//   POST /api/session-manager/archives/delete       -> { ok }
//   POST /api/session-manager/archives/delete-all   -> { ok, results: [...] }
//
// 说明：
// - “归档”本身只是 workspace.json 中 archivedSessionIds 的一个 id；
//   本模块的 unarchive 通过 workspaceRegistry 的内部持久化链把它移除，
//   因此会同时广播 host/archived-sessions-changed，让其它标签页同步。
// - delete 会删除磁盘上的 session.jsonl.zstd 会话目录，并从 workspace
//   记账、archivedSessionIds、session_projcache 中移除；正在运行的会话拒绝删除。
// - 该模块针对当前 dsh JSONL 存储布局实现；如果部署使用了其它持久化后端，
//   文件删除部分可能需要按后端调整。

import { rm, stat, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const name = "dsh-session-manager/archive";

function defaultHomePath(...segments) {
  const root = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), ".dsh");
  return join(root, ...segments);
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() === "" ? {} : JSON.parse(raw);
}

async function removeProjectionCacheRow(ctx, homePath, sessionId) {
  const cache = ctx.get?.("sessionProjectionCache");
  if (cache && cache.table) {
    await cache.table.delete(sessionId);
    return;
  }
  // 兜底：直接编辑 JSON 缓存文件（仅在 sessionProjectionCache 不可用时使用）。
  const file = homePath("storages", "session_projcache.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return;
  }
  if (parsed?.tables?.sessions && typeof parsed.tables.sessions[sessionId] === "object") {
    delete parsed.tables.sessions[sessionId];
    const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
    await writeFile(tmp, JSON.stringify(parsed, null, 2), "utf8");
    await rename(tmp, file);
  }
}

async function listArchived(ctx) {
  const archived = [...ctx.workspaceRegistry.archivedSessionIds];
  const headers = new Map();
  try {
    for (const header of await ctx.sessionPersistence.list()) headers.set(header.id, header);
  } catch {
    // 列表失败不阻断：仍返回归档 id 与可用的 workspace 信息。
  }
  const sessions = ctx.get?.("sessions");
  const agents = ctx.get?.("agents");
  const projectionCache = ctx.get?.("sessionProjectionCache");
  const workspaces = ctx.workspaceRegistry.list();
  const items = [];

  for (const id of archived) {
    const live = sessions?.get?.(id);
    const agent = agents?.get?.(id);
    const header = live?.header ?? headers.get(id);
    let title = null;
    let size = null;
    let fileExists = false;

    if (header) {
      try {
        const loc = ctx.sessionPersistence.locate(header);
        const st = await stat(loc.path);
        size = st.size;
        fileExists = true;
      } catch {
        fileExists = false;
      }
    }

    const record = projectionCache?.table?.get?.(id);
    if (record && record.rows && record.rows.title && typeof record.rows.title.val === "string") {
      title = record.rows.title.val;
    }

    // 旧会话可能没有 projection cache 行，导致标题缺失；用 coldSnapshot 补齐。
    if (!title && projectionCache && typeof projectionCache.coldSnapshot === "function") {
      try {
        const snapshot = await projectionCache.coldSnapshot(id);
        const projectedTitle = snapshot?.values?.title;
        if (typeof projectedTitle === "string") title = projectedTitle;
      } catch {
        // 单条补齐失败不应让整个归档列表失败。
      }
    }

    const workspace = workspaces.find((w) => w.path === header?.cwd || w.record?.sessionIds?.includes(id));
    items.push({
      id,
      title,
      cwd: header?.cwd ?? null,
      createdAt: header?.createdAt ?? null,
      size,
      exists: fileExists,
      live: live !== undefined,
      running: agent?.status === "running",
      workspaceId: workspace?.id ?? null,
      workspaceTitle: workspace?.title ?? null
    });
  }

  return { ok: true, archived: items };
}

async function unarchiveSession(ctx, sessionId) {
  const registry = ctx.workspaceRegistry;
  await registry.enqueueOperation(async () => {
    const state = registry.state;
    if (!state.archivedSessionIds.includes(sessionId)) return;
    await registry.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)
    });
  });
  return { ok: true };
}

// 删除“已打开但空闲”的 live 会话时，光删磁盘文件不够：内存 session store 里
// 仍保留这个会话对象，客户端 session.list 还会看到它，workspace 记账被移除后
// 它就会被投影到“未分组”。这里直接从内存 store 摘除 session/agent 条目，
// 触发 session/disposed -> host/session-removed，让客户端立即移除该行。
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

async function deleteSession(ctx, homePath, sessionId) {
  const registry = ctx.workspaceRegistry;

  if (!registry.archivedSessionIds.includes(sessionId)) {
    return { ok: false, error: "not-archived", message: "session is not archived" };
  }

  // 只有真正在运行的会话才拒绝删除；已打开但空闲的 live 会话允许删除，
  // 否则“归档后仍开着的旧会话”会永远删不掉。
  const agents = ctx.get?.("agents");
  const agent = agents?.get?.(sessionId);
  if (agent?.status === "running") {
    return { ok: false, error: "running", message: "session is still running; stop it before deleting" };
  }

  // 1) 删除磁盘会话目录（JSONL 后端：<root>/<project>/<session-id>/）。
  const headers = await ctx.sessionPersistence.list();
  const header = headers.find((h) => h.id === sessionId);
  if (header) {
    const loc = ctx.sessionPersistence.locate(header);
    await rm(dirname(loc.path), { recursive: true, force: true });
  }

  // 1.5) 从内存 session/agent store 摘除，避免删除后仍显示在“未分组”。
  try {
    detachLiveSession(ctx, sessionId);
  } catch (error) {
    ctx.logger?.warn?.(`dsh-session-manager: detach live session failed: ${String(error?.message ?? error)}`);
  }

  // 2) 从 workspace 记账中摘除。
  for (const workspace of registry.list()) {
    const raw = workspace.record?.sessionIds;
    if (Array.isArray(raw) && raw.includes(sessionId)) {
      await workspace.detachSession(sessionId);
    }
  }

  // 3) 从归档集合移除。
  await registry.enqueueOperation(async () => {
    const state = registry.state;
    if (!state.archivedSessionIds.includes(sessionId)) return;
    await registry.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)
    });
  });

  // 4) 移除投影缓存。
  await removeProjectionCacheRow(ctx, homePath, sessionId);

  return { ok: true };
}

async function deleteMany(ctx, homePath, ids) {
  const results = [];
  for (const id of ids) {
    try {
      const result = await deleteSession(ctx, homePath, id);
      results.push({ id, ok: result.ok, error: result.ok ? null : result.error, message: result.ok ? null : result.message ?? null });
    } catch (error) {
      results.push({ id, ok: false, error: "unexpected", message: String(error?.message ?? error) });
    }
  }
  return { ok: true, results };
}

async function ungroupedArchivedIds(ctx) {
  const ids = [...ctx.workspaceRegistry.archivedSessionIds];
  const headers = new Map();
  try {
    for (const header of await ctx.sessionPersistence.list()) headers.set(header.id, header);
  } catch {
    // 列表失败时仍按现有 workspace 记录判断未分组。
  }
  const sessions = ctx.get?.("sessions");
  const workspaces = ctx.workspaceRegistry.list();
  return ids.filter((id) => {
    const live = sessions?.get?.(id);
    const header = live?.header ?? headers.get(id);
    return !workspaces.find((w) => w.path === header?.cwd || w.record?.sessionIds?.includes(id));
  });
}

export function createArchive(ctx) {
  const homePath = ctx.get?.("dshHomePath") ?? defaultHomePath;

  const handle = async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const sub = url.pathname.replace(/^\/api\/session-manager\/archives\/?/, "").replace(/\/$/, "");

      if (req.method === "GET" && sub === "list") {
        json(res, 200, await listArchived(ctx));
        return;
      }

      if (req.method !== "POST") {
        json(res, 405, { ok: false, error: "method-not-allowed" });
        return;
      }

      const body = await readJson(req);
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";

      if (sub === "unarchive") {
        if (!sessionId) {
          json(res, 400, { ok: false, error: "bad-session", message: "sessionId is required" });
          return;
        }
        json(res, 200, await unarchiveSession(ctx, sessionId));
        return;
      }

      if (sub === "delete") {
        if (!sessionId) {
          json(res, 400, { ok: false, error: "bad-session", message: "sessionId is required" });
          return;
        }
        const result = await deleteSession(ctx, homePath, sessionId);
        if (!result.ok) {
          json(res, result.error === "running" || result.error === "live" ? 409 : 500, result);
          return;
        }
        json(res, 200, result);
        return;
      }

      if (sub === "delete-all" || sub === "delete-ungrouped") {
        const ids = sub === "delete-all"
          ? [...ctx.workspaceRegistry.archivedSessionIds]
          : await ungroupedArchivedIds(ctx);
        json(res, 200, await deleteMany(ctx, homePath, ids));
        return;
      }

      json(res, 404, { ok: false, error: "unknown-endpoint" });
    } catch (error) {
      json(res, 500, { ok: false, error: "internal", message: String(error?.message ?? error) });
    }
  };

  return { handle };
}

export { name };
