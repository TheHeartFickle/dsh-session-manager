// dsh-session-manager — host entry（官方通道）。
// 合并 dsh-rewind 与 dsh-archive-manager：
// - rewind 功能由 lib/rewind.js 提供（shadow git 快照 + 文件回退）；
// - archive 功能由 lib/archive.js 提供（归档会话管理）。
//
// 权威实现位于 lib/commands.js（标准 Command 通道与官方 HTTP 通道共用）；
// 官方服务触点汇聚在 lib/dsh-adapter.js；本文件的 /api/session-manager/*
// 路由只是命令的 HTTP 薄投影（+ rewind/status 的 SSE 进度流），不再承载逻辑。

import { createOfficialBackend } from './dsh-adapter.js';
import { createSessionManagerCommands, COMMAND_PREFIX } from './commands.js';

const name = 'dsh-session-manager';
const inject = ['webServer', 'sessions', 'workspaceRegistry', 'sessionPersistence'];

// 命令错误体 → 旧版 HTTP 状态码（命令协议本身不携带状态码）。
// 逐项核对旧版语义：not-archived 走 500（旧 delete 分支只对 running/live 给 409）。
const STATUS_BY_ERROR = {
  'bad-request': 400,
  'bad-boundary': 400,
  'bad-snapshot-boundary': 400,
  'bad-session': 400,
  'session-not-found': 404,
  'unknown-endpoint': 404,
  'file-rollback-disabled': 409,
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

function apply(ctx, config) {
  const backend = createOfficialBackend(ctx, config);
  const commands = new Map(createSessionManagerCommands({ backend }).map((command) => [command.id, command]));
  const cmd = (suffix) => commands.get(`${COMMAND_PREFIX}.${suffix}`);

  ctx.webServer.register({
    kind: 'prefix',
    path: '/api/session-manager',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x');
        const sub = url.pathname.replace(/^\/api\/session-manager\/?/, '').replace(/\/$/, '');

        if (sub === 'config') {
          if (req.method !== 'GET') {
            json(res, 405, { ok: false, error: 'method-not-allowed' });
            return;
          }
          sendCommandResult(res, await cmd('config').execute({ rawInput: '' }));
          return;
        }

        if (sub === 'rewind/status') {
          backend.attachSse(req, res);
          return;
        }

        if (sub === 'rewind/rollback-files') {
          if (req.method !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
          }
          let raw = '';
          try {
            raw = await readBody(req);
            JSON.parse(raw.trim() === '' ? '{}' : raw);
          } catch {
            json(res, 400, { ok: false, error: 'bad-json' });
            return;
          }
          sendCommandResult(res, await cmd('rewind-rollback-files').execute({ rawInput: raw }));
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
