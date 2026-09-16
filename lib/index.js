// dsh-session-manager — host entry（官方通道）。
// 提供归档会话管理（archive）与回退条目扫描（rewind/entries，见
// lib/rewind-entries.js）；回退执行（rewind）由客户端直接用官方
// sessions.fork 重建分支，不经 host。
//
// 权威实现位于 lib/commands.js（标准 Command 通道与官方 HTTP 通道共用）；
// 官方服务触点汇聚在 lib/dsh-adapter.js；本文件的 /api/session-manager/*
// 路由只是命令的 HTTP 薄投影，不再承载逻辑。

import { createOfficialBackend } from './dsh-adapter.js';
import { createSessionManagerCommands, COMMAND_PREFIX } from './commands.js';
import { listUserInputs } from './rewind-entries.js';
import { drainInheritedInbox } from './rewind-drain.js';

const name = 'dsh-session-manager';
const inject = ['webServer', 'sessions', 'workspaceRegistry', 'sessionPersistence'];

// 命令错误体 → 旧版 HTTP 状态码（命令协议本身不携带状态码）。
// 逐项核对旧版语义：not-archived 走 500（旧 delete 分支只对 running/live 给 409）。
const STATUS_BY_ERROR = {
  'bad-request': 400,
  'bad-json': 400,
  'bad-session': 400,
  'session-not-found': 404,
  'unknown-endpoint': 404,
  running: 409,
  live: 409,
  'sessions-unavailable': 503,
};

const ARCHIVES_SUBCOMMANDS = {
  'archives/list': 'archives-list',
  'archives/unarchive': 'archives-unarchive',
  'archives/delete': 'archives-delete',
  'archives/delete-all': 'archives-delete-all',
  'archives/delete-ungrouped': 'archives-delete-ungrouped',
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendCommandResult(res, result) {
  if (result.kind === 'success') {
    // result.text 即旧版响应体（{ ok, ... }），逐字节透传
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(result.text);
    return;
  }
  const body = JSON.parse(result.text);
  json(res, STATUS_BY_ERROR[body.error] ?? 500, body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function apply(ctx) {
  const backend = createOfficialBackend(ctx);
  const commands = new Map(createSessionManagerCommands({ backend }).map((command) => [command.id, command]));
  const cmd = (suffix) => commands.get(`${COMMAND_PREFIX}.${suffix}`);

  ctx.webServer.register({
    kind: 'prefix',
    path: '/api/session-manager',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x');
        const sub = url.pathname.replace(/^\/api\/session-manager\/?/, '').replace(/\/$/, '');

        if (sub === 'rewind/entries') {
          if (req.method !== 'POST') {
            json(res, 405, { ok: false, error: 'method-not-allowed' });
            return;
          }
          const raw = await readBody(req);
          let body = {};
          try {
            body = JSON.parse(raw.trim() === '' ? '{}' : raw);
          } catch {
            json(res, 400, { ok: false, error: 'bad-json' });
            return;
          }
          if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            json(res, 400, { ok: false, error: 'bad-session', message: 'sessionId is required' });
            return;
          }
          const result = await listUserInputs(ctx, body.sessionId);
          if (result.ok) {
            json(res, 200, result);
          } else {
            json(res, result.error === 'session-not-found' ? 404 : 500, result);
          }
          return;
        }

        if (sub === 'rewind/drain') {
          if (req.method !== 'POST') {
            json(res, 405, { ok: false, error: 'method-not-allowed' });
            return;
          }
          const raw = await readBody(req);
          let body = {};
          try {
            body = JSON.parse(raw.trim() === '' ? '{}' : raw);
          } catch {
            json(res, 400, { ok: false, error: 'bad-json' });
            return;
          }
          if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            json(res, 400, { ok: false, error: 'bad-session', message: 'sessionId is required' });
            return;
          }
          const result = await drainInheritedInbox(ctx, body.sessionId);
          json(res, result.ok ? 200 : 503, result);
          return;
        }

        if (ARCHIVES_SUBCOMMANDS[sub]) {
          const wantsGet = sub === 'archives/list';
          if (req.method !== (wantsGet ? 'GET' : 'POST')) {
            json(res, 405, { ok: false, error: 'method-not-allowed' });
            return;
          }
          let raw = '';
          if (!wantsGet) {
            try {
              raw = await readBody(req);
              // 与旧版 readJson 一致：归档 POST 的非法 JSON 落 500 internal
              JSON.parse(raw.trim() === '' ? '{}' : raw);
            } catch (error) {
              json(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) });
              return;
            }
          }
          sendCommandResult(res, await cmd(ARCHIVES_SUBCOMMANDS[sub]).execute({ rawInput: raw }));
          return;
        }

        json(res, 404, { ok: false, error: 'unknown-endpoint' });
      } catch (error) {
        json(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}

export { apply, inject, name };
