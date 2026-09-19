# dsh-session-manager

`dsh-session-manager` 是一个面向 DeepSeek Harness（DSH）的会话管理插件，把两个高频需求合在一起：

- **回退（Rewind）**：对话走偏时，一键回到之前某个用户消息，重新开始。
- **归档（Archive）**：暂时不用的会话先归档，保持侧边栏整洁，之后可以恢复或彻底删除。

它只增强 DSH 的会话管理能力，不改变模型、不改变工作区、不绑定特定项目。

## ✨ 功能一览

- **对话回退**
  - 会话头部新增“回退”按钮，也支持 `Ctrl/Cmd+Shift+Z` 快捷键。
  - 回退列表来自会话日志的全量扫描：不依赖聊天窗口加载到哪，长会话里未滚动到的
    早期轮次也能选到；steering 插话与压缩点之前的输入不会出现在列表里。
  - 确认后基于所选消息之前的状态派生新会话，并把原消息放回输入框，方便重新编辑。
  - 若该消息前面有未正常结束的回合（例如 agent 被中断、日志里没有回合结束记录），
    回退会把它一并撤销 —— 这类条目会在弹窗里给出警告提示。
  - 功能有且仅有“定位用户输入的位置并重建分支”：回退直接调用官方
    `sessions.fork` 在轨迹定位处重建分支，不做文件回退。

- **归档会话**
  - 在侧边栏底部提供“归档会话”入口。
  - 已归档会话可从归档列表快速恢复。
  - 支持彻底删除单个会话、删除全部已归档会话、删除全部未分组归档会话。

## 📦 安装

前置条件：已安装 DSH，且 `dsh web` 可以正常运行。

### 通过 npm / DSH CLI 安装

```sh
dsh plugin --profile web add @the-heart-fickle/dsh-session-manager@latest
```

### 通过 plugin-registry 安装

```sh
npm run package:registry
dsh registry install ./registry
dsh registry enable the-heart-fickle/dsh-session-manager
```

> `registry/` 是本地生成的安装暂存目录，不会提交到仓库。

## 🚀 快速上手

1. 安装插件后重启 DSH，并刷新浏览器页面。
2. 在会话头部点击“回退”按钮，或按 `Ctrl/Cmd+Shift+Z`。
3. 从弹出的历史用户消息列表中选择要回到的位置，确认后会自动创建新会话；带警告
   标记的条目会在回退时把它前面未正常结束的回合一并撤销。
4. 使用侧边栏底部的“归档会话”入口管理不常用的会话。

## ⚙️ 配置

回退功能无需配置。旧的 `rewindFileMode` / `rewindIgnoreFile` 配置项已随
文件回退功能一并移除，profile 中残留的这些键会被忽略，可自行删除。

## 🔧 环境要求

- Node.js ≥ 20
- DSH ≥ 0.1.6（`dsh.plugin.json` 的 `engines.dsh` 是包管理器侧的声明，此处置于
  实际用到的服务形状）：会话导航走 `uiWorkspace.openSession`（`ISessions` 已无
  `open`）、“当前会话”取会话目录的 `retainedBy.mainView`、日志读取走
  `sessionPersistence` 的 handle 模型（`stat` / `open`）、单会话磁盘路径走
  JSONL 后端的 `locate`。这些形状都在适配层（`lib/dsh-adapter.js` /
  `lib/archive.js` / `lib/client.js` 的 `createClientAdapter`）里消化。

## 📡 通信架构（dsh-std 适配通道）

本插件同时支持两条与 DSH 后端通信的通道，命令权威实现共用 `lib/commands.js`：

- **官方通道**（默认安装方式，功能完整）：经 `cordis.patch.yml` 装配 host 半边，
  `lib/dsh-adapter.js` 汇聚官方服务触点（sessions / workspaceRegistry /
  sessionPersistence 等），`/api/session-manager/*` 是标准命令的 HTTP 薄投影。
  client 半边同样只有 `lib/client.js` 里的 `createClientAdapter(ctx)` 触碰官方
  client 服务（sessions / uiWorkspace / conversation）；组件只消费它给出的
  `rewind` / `archives` 能力，上游客户端服务的改名与搬位置在适配层内消化一次。
- **标准通道**：包根的 `dsh-plugin.json`（Community v0.15）声明 `facets.host.entry`
  与 5 个 `contributes.commands`（归档管理）。profile 安装 `@dsh-std/adapter-dsh` 后，适配层会把
  命令发布到 `commands.dsh/v1alpha1`（经 CommandRuntime / 斜杠命令 / browser
  `executeCommand` 可达）。受 `@dsh-std/adapter-dsh` 0.1.1-rc.2 能力边界限制
  （SessionCatalog 无归档删除语义），标准通道下这些命令按
  `backend-unavailable` 显式降级失败，绝不静默假装成功；完整功能仍需官方通道。

```sh
dsh plugin --profile web add @dsh-std/adapter-dsh   # 启用标准通道
```

## 许可证

MIT
