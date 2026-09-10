// 针对 DSH 0.1.5 API 漂移与 fork 队列继承的回归测试（BUGS.md S5/S6/S7）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listUserInputs } from '../lib/rewind-entries.js';
import { drainInheritedInbox } from '../lib/rewind-drain.js';
import { createArchive } from '../lib/archive.js';

const userMessage = (seq, text, time) => ({
  type: 'user/message',
  seq,
  time,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const synthetic = (seq, kind) => ({
  type: 'user/message',
  seq,
  time: 0,
  data: { source: { kind }, content: [{ type: 'text', text: 'synthetic' }] },
});
const turnStart = (seq) => ({ type: 'turn/start', seq, time: 0, data: { turn: 0 } });
const compactionEnd = (seq) => ({ type: 'compaction/end', seq, time: 0, data: {} });

function handlePersistence(events) {
  const reads = [];
  return {
    stat: async () => ({ header: { id: 's1' }, revision: 1 }),
    open: async (id, access) => {
      assert.equal(id, 's1');
      assert.equal(access, 'read');
      reads.push(access);
      return {
        read: async () => ({ eventState: 'owned', events }),
        close: async () => { reads.push('closed'); },
      };
    },
    reads,
  };
}

test('S5: rewind/entries 经 open+read 扫描全部真实用户输入，排除合成消息', async () => {
  const events = [
    turnStart(0),
    userMessage(1, '第一轮输入', 111),
    synthetic(2, 'agent-instructions'),
    turnStart(3),
    userMessage(4, '第二轮输入', 222),
    synthetic(5, 'skill-catalog'),
  ];
  const persistence = handlePersistence(events);
  const result = await listUserInputs({ sessionPersistence: persistence }, 's1');
  assert.deepEqual(result, {
    ok: true,
    inputs: [
      { seq: 1, turn: 1, text: '第一轮输入', time: 111, boundary: null },
      { seq: 4, turn: 2, text: '第二轮输入', time: 222, boundary: 1 },
    ],
  });
  assert.deepEqual(persistence.reads, ['read', 'closed'], '读句柄必须关闭');
});

test('S8: 有压缩的会话不列出压缩之前的输入，压缩后首条边界 = 压缩底线', async () => {
  const events = [
    turnStart(0),
    userMessage(1, '压缩前第一轮', 100),
    userMessage(2, '压缩前第二轮', 101),
    // 压缩组：start → summary → 检查点 user/message(plugin) → end
    { type: 'compaction/start', seq: 3, time: 0, data: {} },
    { type: 'compaction/summary', seq: 4, time: 0, data: {} },
    synthetic(5, 'plugin'),
    compactionEnd(6),
    turnStart(7),
    userMessage(8, '压缩后第一轮', 200),
    userMessage(9, '压缩后第二轮', 201),
  ];
  const result = await listUserInputs({ sessionPersistence: handlePersistence(events) }, 's1');
  assert.deepEqual(result, {
    ok: true,
    inputs: [
      // 压缩前两条（seq 1/2）被剔除；压缩后首条可回退（回到压缩点），边界 = 底线
      { seq: 8, turn: 2, text: '压缩后第一轮', time: 200, boundary: 6 },
      { seq: 9, turn: 2, text: '压缩后第二轮', time: 201, boundary: 8 },
    ],
  });
});

test('S8: 多次压缩取最后一次 compaction/end 为底线', async () => {
  const events = [
    turnStart(0),
    userMessage(1, '第一次压缩前', 100),
    compactionEnd(2),
    turnStart(3),
    userMessage(4, '两次压缩之间', 150),
    compactionEnd(5),
    turnStart(6),
    userMessage(7, '最后一次压缩后', 200),
  ];
  const result = await listUserInputs({ sessionPersistence: handlePersistence(events) }, 's1');
  assert.deepEqual(result, {
    ok: true,
    inputs: [{ seq: 7, turn: 3, text: '最后一次压缩后', time: 200, boundary: 5 }],
  });
});

test('S8: 压缩后无新输入 → 列表为空（无任何可回退点）', async () => {
  const events = [
    turnStart(0),
    userMessage(1, '压缩前', 100),
    compactionEnd(2),
  ];
  const result = await listUserInputs({ sessionPersistence: handlePersistence(events) }, 's1');
  assert.deepEqual(result, { ok: true, inputs: [] });
});

test('S5: 会话不存在 → session-not-found；读失败 → session-log-unreadable', async () => {
  const missing = await listUserInputs(
    { sessionPersistence: { stat: async () => undefined } },
    'gone',
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'session-not-found');

  const broken = await listUserInputs(
    { sessionPersistence: { stat: async () => { throw new Error('disk on fire'); } } },
    's1',
  );
  assert.equal(broken.ok, false);
  assert.equal(broken.error, 'session-log-unreadable');
  assert.match(broken.message, /disk on fire/);
});

test('S7: drainInheritedInbox 等 agent 上线后用 inbox.clear() 作废继承队列', async () => {
  const cleared = [];
  let live = false;
  const agent = { inbox: { nextTurn: [1, 2], nextStep: [3], clear: () => { cleared.push(true); } } };
  const ctx = {
    get: () => ({
      get: (id) => (live ? agent : undefined),
    }),
  };
  setTimeout(() => { live = true; }, 150);
  const result = await drainInheritedInbox(ctx, 'fork-child', 5000);
  assert.deepEqual(result, { ok: true, cleared: 3 });
  assert.equal(cleared.length, 1);
});

test('S7: 队列为空时 drain 不写事件；agent 始终不上线则超时', async () => {
  const agent = { inbox: { nextTurn: [], nextStep: [], clear: () => assert.fail('空队列不应 clear') } };
  const idle = await drainInheritedInbox(
    { get: () => ({ get: () => agent }) },
    'fork-child',
    1000,
  );
  assert.deepEqual(idle, { ok: true, cleared: 0 });

  const timeout = await drainInheritedInbox(
    { get: () => ({ get: () => undefined }) },
    'fork-child',
    200,
  );
  assert.equal(timeout.ok, false);
  assert.equal(timeout.error, 'agent-not-live');
});

// ── S6: sessionPersistence.list() 快照形状 ─────────────────────────────
// 0.1.5 的 list() 返回 { header, revision, sizeBytes? }；旧实现按 h.id 匹配
// 永远落空：磁盘删除被静默跳过，冷会话的 cwd/size/exists 全部失真。

async function buildArchiveFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sm-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = [
    { id: 'session-aaaa', cwd: root },
    { id: 'session-bbbb', cwd: root },
  ];
  for (const session of sessions) {
    const dir = join(root, session.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session.v3.jsonl.zstd'), 'x'.repeat(10), 'utf8');
  }
  const state = { archivedSessionIds: sessions.map((s) => s.id) };
  const registry = {
    get archivedSessionIds() { return [...state.archivedSessionIds]; },
    state,
    list: () => [{
      record: { sessionIds: ['session-aaaa'] },
      detachSession: async (id) => {
        state.removed ??= [];
        state.removed.push(id);
      },
    }],
    enqueueOperation: async (fn) => fn(),
    setState: async (next) => { state.archivedSessionIds = next.archivedSessionIds; },
  };
  const persistence = {
    // 0.1.5 形状：快照携带 header，id 只在 header 里
    list: async () => sessions.map((s) => ({
      header: { id: s.id, cwd: s.cwd, createdAt: 42 },
      revision: { file: 1 },
      sizeBytes: 10,
    })),
    locate: (header) => ({ path: join(root, header.id, 'session.v3.jsonl.zstd') }),
  };
  const ctx = {
    get: (service) => (service === 'dshHomePath' ? (...segments) => join(root, ...segments) : undefined),
    workspaceRegistry: registry,
    sessionPersistence: persistence,
  };
  return { root, ctx, state, sessions };
}

test('S6: listArchived 为冷会话恢复 cwd/size/exists（不再整体失真）', async (t) => {
  const { root, ctx } = await buildArchiveFixture(t);
  const archive = createArchive(ctx);
  const { body } = await archive.list();
  assert.equal(body.ok, true);
  const byId = new Map(body.archived.map((item) => [item.id, item]));
  for (const id of ['session-aaaa', 'session-bbbb']) {
    assert.equal(byId.get(id).exists, true, `${id} 的文件在磁盘上，exists 不得失真`);
    assert.equal(byId.get(id).size, 10);
    assert.equal(byId.get(id).cwd, root, 'cwd 必须来自 list() 快照的 header');
  }
});

test('S6: deleteSession 真正删除磁盘会话目录并完成全部记账', async (t) => {
  const { root, ctx, state } = await buildArchiveFixture(t);
  const archive = createArchive(ctx);
  const { body } = await archive.del('session-aaaa');
  assert.deepEqual(body, { ok: true });

  // 磁盘目录必须消失 —— 旧实现按 h.id 匹配 list() 快照永远找不到，
  // rm 被静默跳过，文件残留并被客户端投影为“未分组”。
  assert.equal(existsSync(join(root, 'session-aaaa')), false);
  assert.equal(existsSync(join(root, 'session-bbbb')), true, '其他会话不受影响');

  // 记账：workspace 摘除 + archivedSessionIds 移除
  assert.deepEqual(state.removed, ['session-aaaa']);
  assert.deepEqual(state.archivedSessionIds, ['session-bbbb']);
});

test('S6: 未归档会话拒绝删除（not-archived）', async (t) => {
  const { ctx } = await buildArchiveFixture(t);
  const archive = createArchive(ctx);
  const { status, body } = await archive.del('session-nope');
  assert.equal(status, 500);
  assert.equal(body.error, 'not-archived');
});
