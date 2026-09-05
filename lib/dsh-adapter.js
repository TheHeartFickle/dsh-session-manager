// dsh-session-manager — 官方服务适配门面（mini-adapter）。
//
// 本仓库 DSH 官方服务触点的汇聚边界：官方通道入口（lib/index.js）只允许
// 经这里获得后端能力，不允许散落注入官方服务。lib/rewind.js 与
// lib/archive.js 是 adapter 侧的领域模块（持有 sessions / workspaceRegistry /
// sessionPersistence / agents / sessionProjectionCache / dshHomePath 触点），
// commands.js / std-host.js / client.js 必须保持零官方 import。
//
// 上游 @deepseek-ai/* 服务形状变化时，只需要修 rewind.js / archive.js /
// 本文件的对应映射。
import { applyRewind } from './rewind.js';
import { createArchive } from './archive.js';

export function createOfficialBackend(ctx, config) {
  const rewind = applyRewind(ctx, config);
  const archive = createArchive(ctx);
  return {
    getConfig: rewind.getConfig,
    rewindFiles: rewind.rewindFiles,
    archivesList: archive.list,
    archivesUnarchive: archive.unarchive,
    archivesDelete: archive.del,
    archivesDeleteAll: archive.deleteAll,
    archivesDeleteUngrouped: archive.deleteUngrouped,
    // 官方通道专有：SSE 快照进度流（标准 Command 协议没有流式语义）
    attachSse: rewind.handleStatus,
  };
}
