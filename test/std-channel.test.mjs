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
  const [archivesList] = createSessionManagerCommands({ backend: null });
  const result = await archivesList.execute({ rawInput: '' });
  assert.equal(result.kind, 'error');
  const body = JSON.parse(result.text);
  assert.equal(body.error, 'backend-unavailable');
});

// 0.1.2 的文件回退链路（config / rewind-rollback-files 命令）已随 S2/S4 删除，
// 回退收敛为「entries 扫描 + sessions.fork」；命令面只剩 archives-*。

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
    sessionPersistence: {
      list: async () => [],
      stat: async () => undefined,
    },
    webServer: { register: r => routes.push(r) },
  };
  apply(ctx, {});
  const route = routes[0];
  assert.equal(route.path, '/api/session-manager');

  // 0.1.2 的 /config 路由随文件回退链路删除 → unknown-endpoint → 404
  const gone = captureResponse();
  await route.handler({ method: 'GET', url: '/api/session-manager/config' }, gone);
  assert.equal(gone.status, 404);

  // rewind/entries：会话不存在 → session-not-found → 404（旧版语义）
  const missing = captureResponse();
  await route.handler(emitBody('POST', '/api/session-manager/rewind/entries', '{"sessionId":"nope"}'), missing);
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).error, 'session-not-found');

  // 缺少 sessionId → bad-session → 400（旧版语义）
  // mock req 需要在 readBody 注册监听时同步派发 data/end，否则 await readBody 永不返回
  const bad = captureResponse();
  await route.handler(emitBody('POST', '/api/session-manager/archives/unarchive', ''), bad);
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.body).error, 'bad-session');

  const badDrain = captureResponse();
  await route.handler(emitBody('POST', '/api/session-manager/rewind/drain', ''), badDrain);
  assert.equal(badDrain.status, 400);
  assert.equal(JSON.parse(badDrain.body).error, 'bad-session');

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
