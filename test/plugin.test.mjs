import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as plugin from '../lib/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('package.json is a public scoped plugin package', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@the-heart-fickle/dsh-session-manager');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.scripts['package:registry'], 'node scripts/package-registry.mjs');
});

test('dsh.plugin.json declares the registry manifest and client entry', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dsh.plugin.json'), 'utf8'));
  assert.equal(manifest.id, 'the-heart-fickle/dsh-session-manager');
  assert.equal(manifest.main, './lib/index.js');
  assert.equal(manifest.client.main, './lib/client.js');
  assert.ok(Array.isArray(manifest.contributes.tools));
  assert.ok(Array.isArray(manifest.contributes.skills));
});

test('cordis.patch.yml mounts the plugin row', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: session-manager/);
  assert.match(patch, /name: '@the-heart-fickle\/dsh-session-manager'/);
});

test('client bundle registers the scoped module id', async () => {
  const client = await readFile(join(root, 'lib/client.js'), 'utf8');
  assert.match(client, /id: "@the-heart-fickle\/dsh-session-manager"/);
});

test('rewind entries are served by the host scan (BUGS.md S1) and read via the 0.1.5 handle API (S5)', async () => {
  const client = await readFile(join(root, 'lib/client.js'), 'utf8');
  assert.match(client, /entries: function \(sessionId\) \{ return postJson\("rewind\/entries"/);
  assert.ok(!client.includes('collectEntries'), '分页窗口读投影的旧路径已删除');
  const entries = await readFile(join(root, 'lib/rewind-entries.js'), 'utf8');
  assert.ok(!entries.includes('readRaw'), '0.1.5 的 sessionPersistence 没有 readRaw');
  assert.match(entries, /persistence\.open\(sessionId, "read"\)/);
  assert.match(entries, /handle\.read\(\)/);
  // 回退后清理 fork 子会话继承的排队消息（BUGS.md S7）
  assert.match(client, /postJson\("rewind\/drain"/);
});

test('S10: client half 只经适配层触碰官方服务，并适配 0.1.6 的会话导航', async () => {
  const client = await readFile(join(root, 'lib/client.js'), 'utf8');
  assert.match(client, /function createClientAdapter\(ctx\)/);
  assert.match(client, /exports\.__test = \{ createClientAdapter: createClientAdapter \}/, '适配层工厂必须有测试出口');
  // 0.1.6 的 ISessions 没有 open 方法：打开会话是会话导航服务的职责
  //（适配层的映射与「组件不碰 ctx」边界见 test/client-adapter.test.mjs）
  assert.ok(!client.includes('sessions.open'), 'ISessions 在 0.1.6 没有 open 方法');
  assert.match(client, /uiWorkspace\.openSession\(sessionId\)/);
  // 当前会话不再有 list 快照上的 current；判据与官方 ui-agent-preset 一致
  assert.ok(!client.includes('getSnapshot().current'), '会话列表快照没有 current');
  assert.match(client, /summary\.retainedBy\.mainView/);
  // 草稿写进输入框要求会话已被 retain（open 之后）
  const openAt = client.indexOf('props.rewind.open(childId)');
  const draftAt = client.indexOf('props.rewind.restoreDraft(childId, selected.text)');
  assert.ok(openAt > 0 && draftAt > openAt, '必须先打开（retain）子会话再回填草稿');
  // 删除/恢复由 host 事件驱动视图，不再触发整库 session.list 刷新
  assert.ok(!client.includes('sessions.refresh('), '删除不再触发整库会话列表刷新');
  assert.ok(!client.includes('workspaces.refresh'), '0.1.6 的 workspaces 服务没有 refresh()');
});

test('host 半边：官方服务触点只出现在适配层模块里', async () => {
  // 官方通道入口、命令面、标准通道入口必须零官方服务触点，只经
  // lib/dsh-adapter.js 取得后端（BUGS.md S10「适配层」）。
  for (const file of ['lib/index.js', 'lib/commands.js', 'lib/std-host.js']) {
    const source = await readFile(join(root, file), 'utf8');
    for (const touch of ['ctx.sessionPersistence', 'ctx.workspaceRegistry', "ctx.get('agents')", 'ctx.sessions']) {
      assert.ok(!source.includes(touch), `${file} 不得直连官方服务（${touch}）`);
    }
  }
  // 适配层领域模块自身必须写明触点（改动时按文件头核对）
  const dshAdapter = await readFile(join(root, 'lib/dsh-adapter.js'), 'utf8');
  assert.match(dshAdapter, /官方服务适配层（host 半边，mini-adapter）/);
  const archive = await readFile(join(root, 'lib/archive.js'), 'utf8');
  assert.match(archive, /官方触点（0\.1\.6/);
});

test('S10: footer 动作容器按槽位锚点定位，不再依赖构建哈希类名', async () => {
  const client = await readFile(join(root, 'lib/client.js'), 'utf8');
  assert.ok(!client.includes('hHd-Xa_footerActions'), 'CSS-Modules 哈希类名在桌面包上不匹配');
  assert.ok(client.includes('[data-slot=\\"sidebar.footer.action\\"]'), '必须锚定渲染器给出的稳定槽位锚点');
  assert.match(client, /div:has\(> \[data-slot=\\"sidebar\.footer\.action\\"\]\)\{flex-direction:column/);
});

test('S9: 回退提示只在会连带撤销未闭合回合时出现', async () => {
  const client = await readFile(join(root, 'lib/client.js'), 'utf8');
  // 服务端逐条下发标记 → 客户端透传到条目，并在列表项与预览区各渲染一次提示
  assert.match(client, /dropsOpenTurns: inputs\[j\]\.dropsOpenTurns === true/);
  assert.match(client, /entry\.dropsOpenTurns && React\.createElement\("span"/);
  assert.match(client, /selected\.dropsOpenTurns && React\.createElement\("div", \{ className: "dsh-rewind-preview-warn"/);
  assert.match(client, /dsh-rewind-item-warn\{/);
  assert.match(client, /dsh-rewind-preview-warn\{/);
  // zh/en 词典各一份文案 + toEntries 一处透传
  assert.equal((client.match(/dropsOpenTurns:/g) || []).length, 3);
  const entries = await readFile(join(root, 'lib/rewind-entries.js'), 'utf8');
  assert.match(entries, /if \(boundary !== null && closedTurn < turn - 1\) entry\.dropsOpenTurns = true/);
});

test('plugin exports follow the Cordis plugin shape', () => {
  assert.equal(plugin.name, 'dsh-session-manager');
  assert.ok(Array.isArray(plugin.inject));
  assert.equal(typeof plugin.apply, 'function');
});
