// dsh-session-manager — 标准通道入口（dsh-plugin.json facets.host.entry）。
// 由 @dsh-std/adapter-dsh 的 profile loader 发现并激活：包根 default 导出一个
// FacetModule（@dsh-std/lifecycle 的激活形状，activate/deactivate/snapshot）。
//
// 本文件是标准通道的边界：不含任何 DSH 官方服务触点，只把 lib/commands.js 的
// 权威命令发布到 commands.dsh/v1alpha1。publish 返回的 disposer 已挂 activation
// scope，deactivate 时由宿主自动撤销，无需手动清理。
//
// 适配层现状（@dsh-std/adapter-dsh 0.1.1-rc.2）：
// - 标准协议没有会话 rewind / 归档删除语义（SessionCatalog 只有
//   list/get/create/rename，SessionHistory 只有 read/follow），标准通道里
//   没有可用的 backend，命令按 backend-unavailable 降级失败；
// - 完整功能需要官方通道（cordis.patch.yml 安装，lib/index.js 装配 backend）。
// 测试或嵌入式宿主可用 configureStdHost({ backend }) 注入后端。
import { COMMAND_API_VERSION, COMMAND_KIND, createSessionManagerCommands } from './commands.js'

const COMMAND_EXTENSION = Object.freeze({ apiVersion: COMMAND_API_VERSION, kind: COMMAND_KIND })

let backendOverride = null;

export function configureStdHost({ backend } = {}) {
  backendOverride = backend ?? null;
}

function createStdHost() {
  return Object.freeze({
    activate(context) {
      const commands = createSessionManagerCommands({ backend: backendOverride });
      for (const command of commands) {
        // 发布名 = 完整命令 id（manifest projection 以
        // COMMUNITY_CONTRIBUTION_ID_LABEL 标签匹配发布名）
        context.extensions.publish(COMMAND_EXTENSION, command.id, {
          execute: (input, handlerContext) => command.execute(input, handlerContext),
        });
      }
    },
  });
}

export default createStdHost();
