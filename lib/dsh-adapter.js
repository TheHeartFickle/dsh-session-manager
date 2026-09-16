// dsh-session-manager — 官方服务适配门面（mini-adapter）。
//
// 本仓库 DSH 官方服务触点的汇聚边界：官方通道入口（lib/index.js）只允许
// 经这里获得后端能力，不允许散落注入官方服务。lib/archive.js 是 adapter
// 侧的领域模块（持有 sessions / workspaceRegistry / sessionPersistence /
// agents / sessionProjectionCache 触点），commands.js / std-host.js /
// client.js 必须保持零官方 import。
//
// 回退（rewind）不经过 host：客户端直接用官方 sessions.fork 在轨迹定位处
// 重建分支（见 lib/client.js 的 RewindModal）。
//
// 上游 @deepseek-ai/* 服务形状变化时，只需要修 archive.js / 本文件的对应映射。
import { createArchive } from './archive.js';

export function createOfficialBackend(ctx) {
  const archive = createArchive(ctx);
  return {
    archivesList: archive.list,
    archivesUnarchive: archive.unarchive,
    archivesDelete: archive.del,
    archivesDeleteAll: archive.deleteAll,
    archivesDeleteUngrouped: archive.deleteUngrouped,
  };
}
