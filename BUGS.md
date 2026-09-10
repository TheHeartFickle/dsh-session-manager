# dsh-session-manager 缺陷台账

来源标记：`[commit]` 用户在 git commit 中报告；`[browser]` 浏览器实测复现；
`[code]` 代码/官方 bundle 分析确认。状态：`待修复` / `修复待验证` / `已修复`。
注意：S1 的数据面事实（`sessionPersistence.readRaw`）仅对 0.1.2 成立，
0.1.5 起改为 handle 模型，见 S5。

## 待修复

（无）

## 修复待验证（已实现 + 浏览器实测通过，待用户验收）

### S1 `[commit 1a74bdc]` 回退列表只能找到「窗口已加载到」的用户输入

- **现象**：会话窗口没有滚动/加载到某次请求所处的位置时，回退弹窗里找不到
  那条对话；必须先把历史加载到该位置，回退才能选到它。
- **根因 `[code]`**：`lib/client.js` 的 `collectEntries(chat)` 只读当前
  ChatSnapshot（`chat.order` / `chat.nodes`）。0.1.2 聊天窗口是分页窗口：
  首次打开只拉尾部页（`maxMessages: 50`），`loadOlder()` 每次 prepend 50 条
  （`dsh-api-session-controller`）。未加载进窗口的早期轮次在 `chat.order` 里
  根本不存在 → 回退列表漏掉它们。
- **数据面事实**（选型依据）：
  - 客户端 live session store 没有全量事件枚举 API，只有
    `loadOlder()` / `loadThrough(seq)` / `baseSeq` / `hasMore` 分页原语；
  - `sessionPersistence.readRaw(id)` 返回会话日志完整明文 JSONL（host 侧）；
  - 真实日志普查（6 份近期日志共 72 条 user/message）：`source.kind` 分布为
    user 45 / agent-instructions 13 / skill-catalog 10 / plugin 4——
    **只有 `source.kind === "user"` 是真实输入**；steering 插话不产生
    user/message 行；system-reminder 包装全部落在合成 kind 里。
- **修复（方案 a：服务端扫描）**：
  - 新增 `lib/rewind-entries.js`：`listUserInputs(ctx, sessionId)` 用
    `sessionPersistence.readRaw` 读日志，取 `source.kind==="user"` 的
    `user/message`，turn 号按 turn/start 顺序推导，返回 `{ seq, turn, text, time }`；
  - `lib/index.js` 新增 `POST /api/session-manager/rewind/entries`；
  - 客户端 `RewindModal` 打开时拉取该端点（含载入态/错误态），删除读投影的
    `collectEntries`；条目→边界映射不变（条目 j 的 boundary = 前一条的 seq）。
- **验证 `[browser]`**：合成 20 轮会话（92 条 surface 消息，初始窗口只含尾部
  ~12 轮），不滚动直接打开回退弹窗 → 列出全部 19 条可回退点，最旧一条来自
  未加载的第 2 轮；服务端端点单独验证返回 20 条真实输入（system-reminder
  与合成消息零混入）。

## 修复待验证（已实现 + 单测覆盖，待重启 web 实例后浏览器验收）

### S5 `[browser]` 升级 0.1.5 后回退弹窗报「persistence.readRaw is not a function」

- **现象**：打开回退弹窗显示 `回退失败: persistence.readRaw is not a function`，
  列不出任何回退点（0.1.5-rc.1 实测；端口 3080 实例 curl 复现）。
- **根因 `[code]`**：S1 的服务端扫描基于 0.1.2 数据面
  （`sessionPersistence.readRaw(id)` 返回整段明文 JSONL）。0.1.5 的
  `SessionPersistence` 改为 handle 模型：`create/open/flush/stat/list`，
  明文读取接口已移除。
- **修复**：`lib/rewind-entries.js` 改为 `stat()` 预检（缺失 → `session-not-found`）
  + `open(id, "read")` + `handle.read()` 取结构化事件（contiguous、含种子前缀），
  过滤逻辑（`source.kind==="user"`、turn/start 推导 turn 号）不变；读后 `close()`。

### S6 `[browser]` 归档会话「删除」后文件残留、会话进入「未分组」；冷会话状态失真

- **现象**：归档弹窗点删除 → 提示成功，但磁盘文件仍在，客户端侧边栏里会话
  变成未分组条目；归档列表里冷会话一律显示「文件不存在/无标题/无大小」。
- **根因 `[code]`**：0.1.5 的 `sessionPersistence.list()` 返回
  `{ header, revision, sizeBytes? }` 快照，id 在 `snapshot.header.id`；旧实现
  按 `h.id === sessionId` 在 `deleteSession` 里匹配 → 永远落空 → **磁盘 rm 被
  静默跳过**（`ok:true`），但记账步骤照常执行 → 会话脱离工作区与归档集合、
  磁盘文件残留 → `sessionQuery.listSessions()`（persistence ∪ live）仍列出它
  → 投影为「未分组」。`listArchived` / `ungroupedArchivedIds` 同样按 `h.id`
  建索引 → 冷会话的 header 查不到 → cwd/createdAt/size/exists 全部失真。
- **修复**：`lib/archive.js` 三处统一按 `snapshot.header.id` 索引/匹配，
  `locate(snapshot.header)`。新增 `test/rewind-host.test.mjs` 回归：
  临时目录真实布局下 `del` 必须删掉磁盘目录。
- **备注**：`workspaceRegistry` 的 `state/setState/enqueueOperation` 在 0.1.5
  转为 TS-private（运行时仍可访问，`archiveSession` 为新增公开 API），
  现有记账路径实测可用，暂不动。

### S7 `[browser]` 回退/分支后消息进入「排队消息」，再发送时把陈旧消息发出去

- **现象**（用户提供的 `dsh-session-session-c43b7f7d-*.zip`，日志逐条核实）：
  fork 链 (7)→(12) 每代子会话的首个自身事件都是同一条文本的
  `agent/inbox/spliced`（start=7→13 递增）；最后一代 13:09:04 回合开启时按
  FIFO 认领队头 —— 把 11:36 排队的旧消息当成输入发出，用户刚发送的消息滞留
  队列，共堆积 13 条。
- **根因 `[code]`**：0.1.x 的 fork 以「种子回放」重建子会话，而
  `agent/inbox/spliced` 是普通日志事件 —— 父会话未消费的 durable 排队消息
  （agent 忙时反复 Enter 入队、从未被认领的输入）被一并继承。回退后用户
  发送的消息按 FIFO 排到陈旧队列尾部，新回合却认领队头；反复回退时同一
  文本逐代累加。activate 本身不认领队列（(7)-(11) 有队列无回合），回合只在
  prompt 投递时开启并认领队头，故清空队列即可恢复正确行为。
- **修复**：新增 `POST /api/session-manager/rewind/drain`（lib/rewind-drain.js）：
  等 fork 子会话 agent 上线（open 时异步 resume，100ms 轮询，15s 上限）后
  调官方 `agent.inbox.clear()` 作废全部继承排队输入；客户端 `doRewind` 在
  `sessions.open(childId)` 后 fire-and-forget 调用。
- **边界**：官方聊天视图的原生 `forkAt`（无 UI 分支）不走本插件，队列继承
  依旧存在 —— 该路径属 DSH 上游行为，插件无法拦截。

### S8 `[commit]` 有压缩的会话能回退到压缩之前，压缩前输入出现在回退列表

- **现象**：会话执行过压缩（compaction）后，回退列表仍列出压缩点之前的
  用户输入；选中即 fork 到压缩段之前，子会话以原始事件重放、丢失压缩检查点。
- **根因 `[code]`**：`listUserInputs` 只按 `source.kind==="user"` 过滤，不感知
  压缩；而 0.1.x 的 fork 以种子回放重建子会话，切到压缩段之前意味着压缩
  折叠不在种子里。
- **修复**：`lib/rewind-entries.js` 取**最后一个 `compaction/end` 的 seq** 为
  压缩底线：底线之前的真实输入不进入列表；压缩后首条输入可回退（回到压缩
  点重新开始），其 fork 边界 = 底线 —— fork 种子完整携带压缩段
  （compaction/* + 检查点 user/message），子会话投影重放时折叠回检查点状态。
  边界改为服务端逐条下发（`inputs[].boundary`），客户端 `toEntries` 直接消费
  （无压缩时首条 boundary 为 null，维持「第一条输入不可回退」语义）。
- **验证**：单测覆盖（压缩前剔除 / 多次压缩取最后底线 / 压缩后无输入 →
  空列表）；浏览器验收并入 S5 的验收流程。

## 已修复（保留记录，回归测试覆盖）

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| S2 | 回退报 `bad-boundary`，除第一轮外全部失败 `[browser]` | 旧 rewind.js 读 `session.events[seq]`，0.1.2 live Session 无 `.events` → 边界校验恒 false → 恒 400 | 整条文件回退链路（rewind.js / detectFileChanges / SSE / 文件按钮）删除，客户端直接 `sessions.fork` |
| S3 | 带文件回退被误判（主按钮永远是带文件回退） | `detectFileChanges` 检查 `turn >= fromTurn` 的整个尾部，用户会话全是文件写入 | 同上，链路删除 |
| S4 | 主按钮分支选择复杂、语义过载 | 原插件文件回退 + 会话回退双轨 | 功能收敛为「定位用户输入 + fork 重建分支」（SPEC §1） |

## 验收纪律

- 修复 S1 后的验收 = 浏览器实际操作 + 截图（长会话、不滚动、早期轮次可见），
  不是语法通过；验收通过后再补回归测试（现有测试断言旧架构，验收前不改）。
- 插件文件变更后须重启 dsh web 实例（composition 缓存）。
