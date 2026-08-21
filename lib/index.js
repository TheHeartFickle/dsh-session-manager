// dsh-session-manager — host entry.
// 合并 dsh-rewind 与 dsh-archive-manager：
// - rewind 功能由 lib/rewind.js 提供（shadow git 快照 + 文件回退）；
// - archive 功能由 lib/archive.js 提供（归档会话管理）。
// 这里只负责组合、依赖注入和 /api/session-manager/* 路由分派。

import { applyRewind } from './rewind.js';
import { createArchive } from './archive.js';

const name = 'dsh-session-manager';
const inject = ['webServer', 'sessions', 'workspaceRegistry', 'sessionPersistence'];

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function apply(ctx, config) {
  const rewind = applyRewind(ctx, config);
  const archive = createArchive(ctx);

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
          json(res, 200, { ok: true, ...rewind.getConfig() });
          return;
        }

        if (sub === 'rewind/status') {
          rewind.handleStatus(req, res);
          return;
        }

        if (sub === 'rewind/rollback-files') {
          await rewind.handleRollbackFiles(req, res);
          return;
        }

        if (sub === 'archives/list' || sub === 'archives/unarchive' || sub === 'archives/delete' || sub === 'archives/delete-all' || sub === 'archives/delete-ungrouped') {
          await archive.handle(req, res);
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
