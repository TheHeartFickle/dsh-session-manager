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

- **文件回退**
  - 默认使用 `shadow git` 在工作区级别保存快照，不触碰项目自身的 `.git`。
  - 回退时可选择“仅会话回退”，也可选择“带文件回退”同时恢复工作区文件。
  - 回退前自动做安全提交，避免误操作丢失后续改动。
  - 支持 `git`、`diff`、`none` 三种文件回退模式。

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
3. 从弹出的历史用户消息列表中选择要回到的位置。
4. 按需选择“仅会话回退”或“带文件回退”，确认后会自动创建新会话。
5. 使用侧边栏底部的“归档会话”入口管理不常用的会话。

## ⚙️ 配置

在 profile 的 `cordis.patch.yml` 中配置：

```yaml
- id: session-manager
  name: '@the-heart-fickle/dsh-session-manager'
  config:
    rewindIgnoreFile: 'rewind-common.gitignore'
    rewindFileMode: 'diff'   # 'git' | 'diff' | 'none'
```

- `rewindIgnoreFile`：相对 profile 目录解析的公共 ignore 文件，叠加在工作区自身 `.gitignore` 之上。
- `rewindFileMode`：控制回退时的文件行为。
  - `git`：使用 Git 快照回退，失败时降级为文件读写回退。
  - `diff`（默认）：只使用文件读写回退，不创建 Git 快照。
  - `none`：不启用文件回退，仅回退会话。

## 🔧 环境要求

- Node.js ≥ 20
- DSH ≥ 0.1.2-rc.1（client 半边依赖 0.1.2 的 `useChat` ChatSnapshot）
- 使用 `git` 模式时需要系统可用的 `git` 命令

## 📡 通信架构（dsh-std 适配通道）

本插件同时支持两条与 DSH 后端通信的通道，命令权威实现共用 `lib/commands.js`：

- **官方通道**（默认安装方式，功能完整）：经 `cordis.patch.yml` 装配 host 半边，
  `lib/dsh-adapter.js` 汇聚官方服务触点（sessions / workspaceRegistry /
  sessionPersistence 等），`/api/session-manager/*` 是标准命令的 HTTP 薄投影。
- **标准通道**：包根的 `dsh-plugin.json`（Community v0.15）声明 `facets.host.entry`
  与 7 个 `contributes.commands`。profile 安装 `@dsh-std/adapter-dsh` 后，适配层会把
  命令发布到 `commands.dsh/v1alpha1`（经 CommandRuntime / 斜杠命令 / browser
  `executeCommand` 可达）。受 `@dsh-std/adapter-dsh` 0.1.1-rc.2 能力边界限制
  （SessionCatalog 无 rewind / 归档删除语义），标准通道下这些命令按
  `backend-unavailable` 显式降级失败，绝不静默假装成功；完整功能仍需官方通道。

```sh
dsh plugin --profile web add @dsh-std/adapter-dsh   # 启用标准通道
```

## 许可证

MIT
