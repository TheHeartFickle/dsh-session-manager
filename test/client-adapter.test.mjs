// client 半边适配层契约测试（BUGS.md S10）。
//
// 适配层的存在理由：DSH 客户端服务（sessions / uiWorkspace / conversation）
// 的改名、搬家、换签名只允许在 createClientAdapter 里消化一次，组件与
// apply() 不许直接读 ctx 上的官方服务。本文件同时锁定两件事：
//   1) 适配层出参形状与官方触点的映射（打开会话 = uiWorkspace.openSession；
//      当前会话 = retainedBy.mainView > 0 的行；0.1.6 已无 ISessions.open）；
//   2) 「组件不碰 ctx」这条边界本身（读源码判定，注释里出现也算越界）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadClient } from './helpers/load-client.mjs';

const clientUrl = new URL('../lib/client.js', import.meta.url);

test('适配层把官方 client 服务的形状变化消化在自己的映射里', async () => {
  const client = await loadClient();
  const adapter = client.__test?.createClientAdapter;
  assert.equal(typeof adapter, 'function', '适配层工厂必须可从 __test 取用');

  const calls = [];
  const summaries = {
    's-main': { id: 's-main', title: '当前会话', retainedBy: { mainView: 1 } },
    's-idle': { id: 's-idle', title: '其他会话', retainedBy: { agent: 1 } },
  };
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ ids: ['s-main', 's-idle'], byId: summaries }) },
      fork: async (opts) => { calls.push(['fork', opts]); return 's-child'; },
      scope: (id) => undefined,
    },
    uiWorkspace: {
      openSession: (id) => { calls.push(['openSession', id]); },
    },
    conversation: undefined,
  };

  const kit = adapter(ctx);

  // 打开会话在 0.1.6 是 uiWorkspace 的职责（ISessions 只有 list/retain/…）
  kit.rewind.open('s-child');
  assert.deepEqual(calls, [['openSession', 's-child']]);

  // fork 的 atSeq 与标题递增语义原样透传
  const childId = await kit.rewind.fork('s-main', 42);
  assert.equal(childId, 's-child');
  assert.deepEqual(calls[1], ['fork', { sessionId: 's-main', atSeq: 42, increaseTitle: true }]);

  // 当前会话 = 会话目录里 retainedBy.mainView > 0 的那一行
  assert.equal(kit.rewind.current(), 's-main');

  // 草稿回填要求会话已被 retain（scope 未就绪时静默跳过，不抛给弹窗）
  assert.equal(kit.rewind.restoreDraft('s-child', '原文'), undefined);

  // 归档标题取自客户端会话目录（与官方归档页同源），未知 id 给 null
  assert.equal(kit.archives.title('s-main'), '当前会话');
  assert.equal(kit.archives.title('s-unknown'), null);
});

test('组件与 apply() 只消费适配层，不直接触碰官方 client 服务', async () => {
  const source = await readFile(clientUrl, 'utf8');
  const adapterAt = source.indexOf('function createClientAdapter(ctx)');
  const adapterEnd = source.indexOf('\n\t\t// ── rewind helpers');
  assert.ok(adapterAt > 0, '适配层工厂必须存在');
  assert.ok(adapterEnd > adapterAt, '适配层边界必须可定位');

  // 官方 client 服务只允许在适配层函数体内出现（含注释里的提及）。
  const offenders = [];
  for (const name of ['sessions', 'uiWorkspace', 'conversation']) {
    const pattern = new RegExp(`ctx\\.${name}\\b`, 'g');
    for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
      if (match.index < adapterAt || match.index > adapterEnd) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`lib/client.js:${line} 适配层之外读 ctx.${name}`);
      }
    }
  }
  assert.deepEqual(offenders, [], '适配层之外不得读官方 client 服务');
});
