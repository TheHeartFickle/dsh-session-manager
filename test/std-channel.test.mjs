import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COMMAND_API_VERSION, COMMAND_KIND, COMMAND_PREFIX, createSessionManagerCommands } from '../lib/commands.js';
import stdHost, { configureStdHost } from '../lib/std-host.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('dsh-plugin.json is a valid Community v0.15 standard manifest', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dsh-plugin.json'), 'utf8'));
  assert.equal(manifest.manifestVersion, '0.15');
  assert.equal(manifest.id, 'the-heart-fickle.dsh-session-manager');
  assert.match(manifest.id, /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/);
  assert.equal(manifest.facets.host.apiVersion, 'v1alpha1');
  assert.equal(manifest.requires?.services, undefined);
  for (const contract of manifest.requires?.contracts ?? []) {
    if (contract.optional) assert.ok(contract.fallback, `optional contract ${contract.apiVersion} needs fallback`);
  }
  const ids = manifest.contributes.commands.map(c => c.id);
  assert.ok(ids.length > 0);
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(existsSync(join(root, manifest.facets.host.entry)), 'facets.host.entry must exist');
});

function fakeActivationContext(manifest, published) {
  return {
    identity: { component: manifest.id, facet: 'host' },
    scope: { signal: new AbortController().signal, add() { return () => {}; } },
    protocols: { agreement: () => undefined, client: () => undefined, implement: () => () => {} },
    extensions: {
      publish(reference, name, handler) {
        published.push({ reference, name, handler });
        return () => {};
      },
    },
  };
}

test('std-host publishes every declared command under commands.dsh/v1alpha1', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dsh-plugin.json'), 'utf8'));
  const published = [];
  stdHost.activate(fakeActivationContext(manifest, published));

  const declared = manifest.contributes.commands.map(c => c.id);
  assert.deepEqual(published.map(p => p.name).sort(), [...declared].sort());
  for (const p of published) {
    assert.deepEqual(p.reference, { apiVersion: COMMAND_API_VERSION, kind: COMMAND_KIND });
    assert.equal(typeof p.handler.execute, 'function');
  }
});

test('without a backend every command degrades to backend-unavailable', async () => {
  const previous = stdHost;
  assert.equal(typeof previous.activate, 'function');
  // 模块默认无 backend：命令应降级失败而不是静默成功
  const [config] = createSessionManagerCommands({ backend: null });
  const result = await config.execute({ rawInput: '' });
  assert.equal(result.kind, 'error');
  const body = JSON.parse(result.text);
  assert.equal(body.error, 'backend-unavailable');
});

test('config command returns the rewind file mode', async () => {
  const backend = { getConfig: () => ({ rewindFileMode: 'diff' }) };
  const [config] = createSessionManagerCommands({ backend });
  const result = await config.execute({ rawInput: '' });
  assert.deepEqual(JSON.parse(result.text), { ok: true, rewindFileMode: 'diff' });
});

test('rewind-rollback-files validates args and projects the backend result', async () => {
  const calls = [];
  const backend = {
    rewindFiles: async input => { calls.push(input); return { status: 200, body: { ok: true, mode: 'diff', restored: [], deleted: [], skipped: [] } }; },
  };
  const commands = createSessionManagerCommands({ backend });
  const command = commands.find(c => c.id === `${COMMAND_PREFIX}.rewind-rollback-files`);

  const badArgs = await command.execute({ rawInput: '{"sessionId":123}' });
  assert.equal(JSON.parse(badArgs.text).error, 'bad-request');

  const ok = await command.execute({ rawInput: '{"sessionId":"s1","atSeq":4}' });
  assert.deepEqual(JSON.parse(ok.text), { ok: true, mode: 'diff', restored: [], deleted: [], skipped: [] });
  assert.deepEqual(calls[0], { sessionId: 's1', atSeq: 4, snapshotAtSeq: undefined });

  // 后端错误投影：{ status, body } → error + body 原样
  const failing = createSessionManagerCommands({
    backend: { rewindFiles: async () => ({ status: 409, body: { ok: false, error: 'file-rollback-disabled' } }) },
  }).find(c => c.id === `${COMMAND_PREFIX}.rewind-rollback-files`);
  const denied = await failing.execute({ rawInput: '{"sessionId":"s1","atSeq":1}' });
  assert.equal(denied.kind, 'error');
  assert.deepEqual(JSON.parse(denied.text), { ok: false, error: 'file-rollback-disabled' });
});

test('archives commands validate sessionId and project backend results', async () => {
  const commands = createSessionManagerCommands({
    backend: {
      archivesUnarchive: async id => ({ status: 200, body: { ok: true, id } }),
      archivesDelete: async () => ({ status: 409, body: { ok: false, error: 'running' } }),
      archivesList: async () => ({ status: 200, body: { ok: true, archived: [] } }),
    },
  });
  const byName = new Map(commands.map(c => [c.id, c]));

  const missing = await byName.get(`${COMMAND_PREFIX}.archives-unarchive`).execute({ rawInput: '' });
  assert.equal(JSON.parse(missing.text).error, 'bad-session');

  const unarchived = await byName.get(`${COMMAND_PREFIX}.archives-unarchive`).execute({ rawInput: '{"sessionId":"s9"}' });
  assert.deepEqual(JSON.parse(unarchived.text), { ok: true, id: 's9' });

  const running = await byName.get(`${COMMAND_PREFIX}.archives-delete`).execute({ rawInput: '{"sessionId":"s9"}' });
  assert.equal(running.kind, 'error');
  assert.deepEqual(JSON.parse(running.text), { ok: false, error: 'running' });

  const listed = await byName.get(`${COMMAND_PREFIX}.archives-list`).execute({ rawInput: '' });
  assert.deepEqual(JSON.parse(listed.text), { ok: true, archived: [] });
});

test('official route is a thin projection with legacy status codes preserved', async () => {
  const { apply } = await import('../lib/index.js');
  const routes = [];
  const ctx = {
    on() {},
    get(service) {
      if (service === 'sessions') return { get: () => undefined };
      if (service === 'dshHomePath') return (...segments) => join('home', ...segments);
      return undefined;
    },
    workspaceRegistry: { archivedSessionIds: [], list: () => [] },
    sessionPersistence: { list: async () => [] },
    webServer: { register: r => routes.push(r) },
  };
  apply(ctx, {});
  const route = routes[0];
  assert.equal(route.path, '/api/session-manager');

  const res = captureResponse();
  await route.handler({ method: 'GET', url: '/api/session-manager/config' }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, rewindFileMode: 'git' });

  // 缺少 sessionId → bad-session → 400（旧版语义）
  // mock req 需要在 readBody 注册监听时同步派发 data/end，否则 await readBody 永不返回
  const bad = captureResponse();
  await route.handler(emitBody('POST', '/api/session-manager/archives/unarchive', ''), bad);
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.body).error, 'bad-session');

  // 归档列表（空 registry）
  const list = captureResponse();
  await route.handler({ method: 'GET', url: '/api/session-manager/archives/list' }, list);
  assert.equal(list.status, 200);
  assert.deepEqual(JSON.parse(list.body), { ok: true, archived: [] });
});

function captureResponse() {
  const res = { status: 0, body: '', headers: null };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = body => { res.body = body ?? ''; };
  return res;
}

// 可被 lib/index.js readBody 读取的最小 req mock：注册监听时同步派发 data/end
function emitBody(method, url, body) {
  return {
    method,
    url,
    on(name, listener) {
      if (name === 'data' && body) listener(Buffer.from(body));
      if (name === 'end') listener();
    },
  };
}
