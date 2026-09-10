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
  assert.match(client, /function fetchEntries\(sessionId\)/);
  assert.match(client, /\/api\/session-manager\/rewind\/entries/);
  assert.ok(!client.includes('collectEntries'), '分页窗口读投影的旧路径已删除');
  const entries = await readFile(join(root, 'lib/rewind-entries.js'), 'utf8');
  assert.ok(!entries.includes('readRaw'), '0.1.5 的 sessionPersistence 没有 readRaw');
  assert.match(entries, /persistence\.open\(sessionId, "read"\)/);
  assert.match(entries, /handle\.read\(\)/);
  // 回退后清理 fork 子会话继承的排队消息（BUGS.md S7）
  assert.match(client, /\/api\/session-manager\/rewind\/drain/);
  assert.match(client, /drainInheritedQueue\(childId\)/);
  // 0.1.2 的 workspaces 服务不再暴露 refresh()
  assert.match(client, /workspaces\.refresh\?\.\(\)/);
});

test('plugin exports follow the Cordis plugin shape', () => {
  assert.equal(plugin.name, 'dsh-session-manager');
  assert.ok(Array.isArray(plugin.inject));
  assert.equal(typeof plugin.apply, 'function');
});
