// 针对 DSH 0.1.5 API 漂移与 fork 边界/队列继承的回归测试（BUGS.md S5/S6/S7/S8/S9）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listUserInputs } from '../lib/rewind-entries.js';
import { drainInheritedInbox } from '../lib/rewind-drain.js';
import { createArchive } from '../lib/archive.js';

const userMessage = (seq, text, time, id) => ({
  type: 'user/message',
  seq,
  time,
  data: { id: id ?? `msg-${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const synthetic = (seq, kind) => ({
  type: 'user/message',
  seq,
  time: 0,
  data: { id: `synthetic-${seq}`, source: { kind }, content: [{ type: 'text', text: 'synthetic' }] },
});
const turnStart = (seq) => ({ type: 'turn/start', seq, time: 0, data: { turn: 0 } });
const turnEnd = (seq) => ({ type: 'turn/end', seq, time: 0, data: { turn: 0 } });
const compactionEnd = (seq) => ({ type: 'compaction/end', seq, time: 0, data: {} });
/** next-step（steering）队列：先入队，再被内核认领成 user/message。 */
const enqueueSteering = (seq, id) => ({
  type: 'agent/inbox/spliced',
  seq,
  time: 0,
  data: { target: 'next-step', start: 0, inserted: [{ id }] },
});
const claimSteering = (seq) => ({
  type: 'agent/inbox/spliced',
  seq,
  time: 0,
  data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
});

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
    turnEnd(3),
    turnStart(4),
    userMessage(5, '第二轮输入', 222),
    synthetic(6, 'skill-catalog'),
    turnEnd(7),
  ];
  const persistence = handlePersistence(events);
  const result = await listUserInputs({ sessionPersistence: persistence }, 's1');
  assert.deepEqual(result, {
    ok: true,
    inputs: [
      // 首条没有已闭合回合可作边界 → null（客户端剔除：回退到它之前 = 空会话）
      { seq: 1, turn: 1, text: '第一轮输入', time: 111, boundary: null },
      { seq: 5, turn: 2, text: '第二轮输入', time: 222, boundary: 3 },
    ],
  });
  assert.deepEqual(persistence.reads, ['read', 'closed'], '读句柄必须关闭');
});

test('S8: 有压缩的会话不列出压缩之前的输入；压缩后首条边界仍让种子携带压缩段', async () => {
  const events = [
    turnStart(0),
    userMessage(1, '压缩前第一轮', 100),
    turnEnd(2),
    turnStart(3),
    userMessage(4, '压缩前第二轮', 101),
    turnEnd(5),
    // 压缩组：start → summary → 检查点 user/message(plugin) → end
    { type: 'compaction/start', seq: 6, time: 0, data: {} },
    { type: 'compaction/summary', seq: 7, time: 0, data: {} },
    synthetic(8, 'plugin'),
    compactionEnd(9),
    turnStart(10),
    userMessage(11, '压缩后第一轮', 200),
    turnEnd(12),
    turnStart(13),
    userMessage(14, '压缩后第二轮', 201),
    turnEnd(15),
  ];
  const result = await listUserInputs({ sessionPersistence: handlePersistence(events) }, 's1');
  assert.deepEqual(result, {
    ok: true,
    inputs: [
      // 压缩前两条（seq 1/4）被剔除；边界 = 选中 turn 之前最后一个 turn/end，
      // fork 前推切片到 seq 10 → 种子含 compaction/*(6-9)，选中输入不入种子
      { seq: 11, turn: 3, text: '压缩后第一轮', time: 200, boundary: 5 },
      { seq: 14, turn: 4, text: '压缩后第二轮', time: 201, boundary: 12 },
    ],
  });
});

test('S8: 多次压缩取最后一次 compaction/end 为底线', async () => {
  const events = [
    turnStart(0),
    userMessage(1, '第一次压缩前', 100),
    turnEnd(2),
    compactionEnd(3),
    turnStart(4),
    userMessage(5, '两次压缩之间', 150),
    turnEnd(6),
    compactionEnd(7),
    turnStart(8),
    userMessage(9, '最后一次压缩后', 200),
    turnEnd(10),
  ];
  const result = await listUserInputs({ sessionPersistence: handlePersistence(events) }, 's1');
  assert.deepEqual(result, {
    ok: true,
    inputs: [{ seq: 9, turn: 3, text: '最后一次压缩后', time: 200, boundary: 6 }],
  });
});

test('S8: 压缩后无新输入 → 列表为空（无任何可回退点）', async () => {
  const events = [
    turnStart(0),
    userMessage(1, '压缩前', 100),
    turnEnd(2),
    compactionEnd(3),
  ];
  const result = await listUserInputs({ sessionPersistence: handlePersistence(events) }, 's1');
  assert.deepEqual(result, { ok: true, inputs: [] });
});

test('S9: steering 插话（next-step 认领的 user/message）不进回退列表', async () => {
  const events = [
    turnStart(0),
    userMessage(1, '输入一', 100),
    turnEnd(2),
    turnStart(3),
    userMessage(4, '输入二', 200),
    // 运行中插话：next-step 入队 → 内核认领 → 以 user/message 落到回合中间
    enqueueSteering(5, 'steer-1'),
    claimSteering(6),
    userMessage(7, '插话', 300, 'steer-1'),
    turnEnd(8),
    turnStart(9),
    userMessage(10, '输入三', 400),
    turnEnd(11),
  ];
  const result = await listUserInputs({ sessionPersistence: handlePersistence(events) }, 's1');
  assert.deepEqual(result, {
    ok: true,
    inputs: [
      { seq: 1, turn: 1, text: '输入一', time: 100, boundary: null },
      { seq: 4, turn: 2, text: '输入二', time: 200, boundary: 2 },
      // 插话（seq 7）被剔除；输入三仍在列表里，边界是插话所在 turn 的 turn/end
      { seq: 10, turn: 3, text: '输入三', time: 400, boundary: 8 },
    ],
  });
});

test('S9: 前序 turn 未闭合（缺 turn/end）时边界回落到最后一个已闭合 turn', async () => {
  const events = [
    turnStart(0),
    userMessage(1, '第一轮', 100),
    turnEnd(2),
    turnStart(3),
    userMessage(4, '第二轮（回合未闭合）', 200),
    // 第二轮被中断，没有 turn/end，日志里直接开下一回合
    turnStart(5),
    userMessage(6, '第三轮', 300),
    turnEnd(7),
  ];
  const result = await listUserInputs({ sessionPersistence: handlePersistence(events) }, 's1');
  assert.deepEqual(result, {
    ok: true,
    inputs: [
      { seq: 1, turn: 1, text: '第一轮', time: 100, boundary: null },
      { seq: 4, turn: 2, text: '第二轮（回合未闭合）', time: 200, boundary: 2 },
      // 未闭合的第二轮不能作为 fork 种子结尾，回退到第三轮之前时一并撤销：
      // 边界仍是 seq 2（fork 切到 seq 3 的 turn/start）——绝不能退化成整段复制；
      // 该条目带 dropsOpenTurns，客户端据此在弹窗里提示
      { seq: 6, turn: 3, text: '第三轮', time: 300, boundary: 2, dropsOpenTurns: true },
    ],
  });
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
