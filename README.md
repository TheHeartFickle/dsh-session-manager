# dsh-session-manager

`dsh-session-manager` 是一个面向 DeepSeek Harness（DSH）的会话管理插件，把两个高频需求合在一起：

- **回退（Rewind）**：对话走偏时，一键回到之前某个用户消息，重新开始。
- **归档（Archive）**：暂时不用的会话先归档，保持侧边栏整洁，之后可以恢复或彻底删除。

它只增强 DSH 的会话管理能力，不改变模型、不改变工作区、不绑定特定项目。

## ✨ 功能一览

- **对话回退**
  - 会话头部新增“回退”按钮，也支持 `Ctrl/Cmd+Shift+Z` 快捷键。
  - 可从当前已加载窗口中选择任意一个已完成回合的历史用户消息。
  - 确认后基于该回合之前的状态派生新会话，并把原消息放回输入框，方便重新编辑。
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
3. 从弹出的历史用户消息列表中选择要回到的位置，确认后会自动创建新会话。
4. 使用侧边栏底部的“归档会话”入口管理不常用的会话。

## ⚙️ 配置

回退功能无需配置。旧的 `rewindFileMode` / `rewindIgnoreFile` 配置项已随
文件回退功能一并移除，profile 中残留的这些键会被忽略，可自行删除。

## 🔧 环境要求

- Node.js ≥ 20
- DSH ≥ 0.1.2-rc.1（client 半边依赖 0.1.2 的 `useChat` ChatSnapshot）

## 📡 通信架构（dsh-std 适配通道）

本插件同时支持两条与 DSH 后端通信的通道，命令权威实现共用 `lib/commands.js`：

- **官方通道**（默认安装方式，功能完整）：经 `cordis.patch.yml` 装配 host 半边，
  `lib/dsh-adapter.js` 汇聚官方服务触点（sessions / workspaceRegistry /
  sessionPersistence 等），`/api/session-manager/*` 是标准命令的 HTTP 薄投影。
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
