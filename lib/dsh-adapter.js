// dsh-session-manager — 官方服务适配层（host 半边，mini-adapter）。
//
// 本仓库 DSH 官方服务触点的汇聚边界，与 client 半边（lib/client.js 的
// createClientAdapter）对称：
// - 只有 lib/archive.js 读 sessions / workspaceRegistry / sessionPersistence /
//   agents / sessionProjectionCache；只有 lib/rewind-entries.js 与
//   lib/rewind-drain.js 读 sessionPersistence / agents —— 它们都是本适配层
//   的领域模块，官方触点在文件头列明；
// - lib/index.js（官方通道入口）、lib/commands.js（命令面）、
//   lib/std-host.js（标准通道入口）零官方服务触点，只经本文件取得后端。
//
// 为什么是自建适配层而不是 @dsh-std/adapter-dsh：0.1.1-rc.2 的
// SessionCatalog 只有 list/get/create/rename，SessionHistory 只有 read/follow，
// 既没有 rewind 的 fork 边界语义，也没有归档删除（见 dsh-std-adapter-docs 与
// lib/std-host.js 的现状说明）。标准通道因此在没有 backend 时按
// backend-unavailable 降级失败，官方通道装配下面的 backend。
//
// 回退（rewind）不经过 host：客户端直接用官方 sessions.fork 在轨迹定位处
// 重建分支（见 lib/client.js 的 createClientAdapter）。
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
