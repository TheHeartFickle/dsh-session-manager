// dsh-session-manager — 权威命令面。
// client↔host 通信的唯一权威 API 层：官方 HTTP 通道（lib/index.js 的
// /api/session-manager 薄投影）与标准 Command 通道（lib/std-host.js 经
// @dsh-std/adapter-dsh 发布到 commands.dsh/v1alpha1）都委托到这里。
//
// 命令处理器契约（@dsh-std/command CommandHandler）：
//   execute({ rawInput }, { signal }) -> { kind: 'success' | 'error', text? }
// text 携带 JSON 序列化的结果体，与官方 HTTP 通道的响应体逐字节同形；
// HTTP 状态码不进入命令协议，由 lib/index.js 的错误码映射表还原。
//
// backend 契约（官方通道由 lib/dsh-adapter.js 提供）：
//   getConfig() -> { rewindFileMode }
//   rewindFiles({ sessionId, atSeq, snapshotAtSeq? }) -> { status, body }
//   archivesList() / archivesUnarchive(id) / archivesDelete(id) /
//   archivesDeleteAll() / archivesDeleteUngrouped() -> { status, body }
// 未提供 backend（纯标准通道）时命令以 backend-unavailable 降级失败，
// 绝不静默假装成功。

export const COMMAND_API_VERSION = 'commands.dsh/v1alpha1'
export const COMMAND_KIND = 'Command'

export const COMMAND_PREFIX = 'the-heart-fickle.dsh-session-manager'

// 参数约定：rawInput 为空 = 无参；非空必须是 JSON 对象。
function parseArgs(rawInput) {
  const raw = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (raw === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, body: { ok: false, error: 'bad-request', message: 'arguments must be a JSON object' } };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, body: { ok: false, error: 'bad-json', message: 'arguments must be valid JSON' } };
  }
}

const ok = (body) => ({ kind: 'success', text: JSON.stringify(body) });
const fail = (body) => ({ kind: 'error', text: JSON.stringify(body) });

// backend 操作返回 { status, body }（与旧 HTTP 语义逐字段一致）；
// 命令协议只保留 body，status 由官方通道投影还原。
function project(result) {
  return result && result.status < 400 ? ok(result.body) : fail(result.body);
}

function requireSessionId(args) {
  return typeof args?.sessionId === 'string' && args.sessionId !== ''
    ? { ok: true, value: args.sessionId }
    : { ok: false, body: { ok: false, error: 'bad-session', message: 'sessionId is required' } };
}

const COMMAND_DEFS = [
  {
    id: `${COMMAND_PREFIX}.config`,
    spec: { title: 'Session manager config', description: 'Return the active rewind file mode as JSON' },
    make: (backend) => async function execute(input) {
      const args = parseArgs(input?.rawInput);
      if (!args.ok) return fail(args.body);
      return ok({ ok: true, ...backend.getConfig() });
    },
  },
  {
    id: `${COMMAND_PREFIX}.rewind-rollback-files`,
    spec: {
      title: 'Rewind workspace files',
      description: 'Roll workspace files back to a snapshot or best-effort diff state; body { sessionId, atSeq, snapshotAtSeq? }',
    },
    make: (backend) => async function execute(input) {
      const args = parseArgs(input?.rawInput);
      if (!args.ok) return fail(args.body);
      const { sessionId, atSeq, snapshotAtSeq } = args.value;
      if (typeof sessionId !== 'string' || !Number.isSafeInteger(atSeq)) {
        return fail({ ok: false, error: 'bad-request' });
      }
      if (snapshotAtSeq !== undefined && !Number.isSafeInteger(snapshotAtSeq)) {
        return fail({ ok: false, error: 'bad-request' });
      }
      return project(await backend.rewindFiles({ sessionId, atSeq, snapshotAtSeq }));
    },
  },
  {
    id: `${COMMAND_PREFIX}.archives-list`,
    spec: { title: 'List archived sessions', description: 'Return archived session entries as JSON' },
    make: (backend) => async function execute(input) {
      const args = parseArgs(input?.rawInput);
      if (!args.ok) return fail(args.body);
      return project(await backend.archivesList());
    },
  },
  {
    id: `${COMMAND_PREFIX}.archives-unarchive`,
    spec: {
      title: 'Unarchive a session',
      description: 'Remove a session id from the workspace archive list; body { sessionId }',
    },
    make: (backend) => async function execute(input) {
      const args = parseArgs(input?.rawInput);
      if (!args.ok) return fail(args.body);
      const sessionId = requireSessionId(args.value);
      if (!sessionId.ok) return fail(sessionId.body);
      return project(await backend.archivesUnarchive(sessionId.value));
    },
  },
  {
    id: `${COMMAND_PREFIX}.archives-delete`,
    spec: {
      title: 'Delete an archived session',
      description: 'Delete one archived session from disk and bookkeeping; body { sessionId }',
    },
    make: (backend) => async function execute(input) {
      const args = parseArgs(input?.rawInput);
      if (!args.ok) return fail(args.body);
      const sessionId = requireSessionId(args.value);
      if (!sessionId.ok) return fail(sessionId.body);
      return project(await backend.archivesDelete(sessionId.value));
    },
  },
  {
    id: `${COMMAND_PREFIX}.archives-delete-all`,
    spec: {
      title: 'Delete all archived sessions',
      description: 'Delete every archived session; returns per-id results',
    },
    make: (backend) => async function execute(input) {
      const args = parseArgs(input?.rawInput);
      if (!args.ok) return fail(args.body);
      return project(await backend.archivesDeleteAll());
    },
  },
  {
    id: `${COMMAND_PREFIX}.archives-delete-ungrouped`,
    spec: {
      title: 'Delete ungrouped archived sessions',
      description: 'Delete archived sessions that belong to no workspace; returns per-id results',
    },
    make: (backend) => async function execute(input) {
      const args = parseArgs(input?.rawInput);
      if (!args.ok) return fail(args.body);
      return project(await backend.archivesDeleteUngrouped());
    },
  },
];

export function createSessionManagerCommands({ backend }) {
  if (!backend) {
    return COMMAND_DEFS.map((def) => ({
      id: def.id,
      spec: def.spec,
      execute: async function execute() {
        return fail({
          ok: false,
          error: 'backend-unavailable',
          message: `command ${def.id} has no backend in the standard channel; install through the official channel (cordis.patch.yml) until @dsh-std/adapter-dsh covers session rewind/archive semantics`,
        });
      },
    }));
  }
  return COMMAND_DEFS.map((def) => ({ id: def.id, spec: def.spec, execute: def.make(backend) }));
}
