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
    只有 `source.kind === "user"` 覆盖全部真实输入；system-reminder 包装全部
    落在合成 kind 里。（**该结论不完整**：steering 插话落盘时同样是
    `source.kind === "user"` 的 `user/message`，见 S9。）
- **修复（方案 a：服务端扫描）**：
  - 新增 `lib/rewind-entries.js`：`listUserInputs(ctx, sessionId)` 用
    `sessionPersistence.readRaw` 读日志，取 `source.kind==="user"` 的
    `user/message`，turn 号按 turn/start 顺序推导，返回 `{ seq, turn, text, time }`；
  - `lib/index.js` 新增 `POST /api/session-manager/rewind/entries`；
  - 客户端 `RewindModal` 打开时拉取该端点（含载入态/错误态），删除读投影的
    `collectEntries`；条目→边界映射当时为「条目 j 的 boundary = 前一条的
    seq」，该取法在 S9 中被修正为「选中 turn 之前最后一个 turn/end」。
- **验证 `[browser]`**：合成 20 轮会话（92 条 surface 消息，初始窗口只含尾部
  ~12 轮），不滚动直接打开回退弹窗 → 列出全部 19 条可回退点，最旧一条来自
  未加载的第 2 轮；服务端端点单独验证返回 20 条真实输入（system-reminder
  与合成消息零混入）。

## 修复待验证（已实现 + 单测覆盖，待重启 web 实例后浏览器验收）

### S10 `[browser]` 0.1.6 适配：删除归档会话先掉进「未分组」且慢；回退报 `sessions.open is not a function`；桌面端归档入口与「上下文洞察」叠在一起

- **现象**（用户在同一台机器上同时跑桌面包与 web 包，四个独立症状）：
  1. 归档列表点「删除」：该会话先出现在工作区**未分组**里，过几秒才消失；
     单个归档会话的删除要好几秒。
  2. 回退确认后弹窗报 `回退失败: props.sessions.open is not a function`。
  3. 桌面端侧边栏底部，「归档会话」与 `dsh-context` 的「上下文洞察」挤在同一行
     （前者把后者的标签挤成只剩图标）；网页端是两行，表现不一致。
  4. `Ctrl/Cmd+Shift+Z` 快捷键在 0.1.6 下失效（无任何反应）。
- **根因 `[code]`**（逐条核实 0.1.6-alpha.2 的上游源码）：
  1. **未分组**：客户端的会话目录只由 host 事件维护
     （`api-session/removed` ← `session/disposed`）。冷会话没有可 dispose 的
     对象，删除时宿主只删了磁盘目录就改工作区记账与归档集合；客户端手里
     那份目录快照仍留着这一行，而它此时既不在工作区、也不再归档
     （`tree.ts` 的 `sessionVisible`）→ 投影成「未分组」，一直显示到客户端
     自己再拉一次整库列表。
  2. **慢**：删除路径用 `sessionPersistence.list()` 找 header，而 `list()` 是
     **整库扫描**（逐个项目目录、逐个会话目录、读并解析每个日志的首行）。
     `deleteMany` 每删一个就扫一遍；客户端在每次删除后还额外触发
     `sessions.refresh()`（又一次整库扫描）与 `archives/list`（第三次）。
  3. **`sessions.open`**：0.1.6 的 `ISessions` 只有 `list/retain/using/create/
     fork/scope/refresh/search/...`，没有 `open`；打开会话是 `uiWorkspace`
     的职责（官方 `ui-chat` 的 `forkAt` 就是 `sessions.fork(...).then(id =>
     ctx.uiWorkspace.openSession(id))`）。同一处还有第二个已失效的契约：
     会话列表快照没有 `current` 字段（快捷键因此恒早退）。
  4. **叠在一起**：footer 动作容器的类名是 CSS Modules 哈希
     （web 包 `hHd-Xa_footerActions`，桌面包 `CHRDNG_footerActions`）。插件
     按 web 包的哈希把容器改成竖排，桌面包上这条规则**根本不匹配**，容器
     退回 `display:flex` 的默认行排布；插件条目又写了
     `flex:none; width:calc(100% + 8px)`，于是把相邻插件挤成一个图标。
- **修复**：
  1. `lib/archive.js`：删除时先 `detachLiveSession` 再 **显式
     `ctx.emit('api-session/removed', id)`**（官方声明并转发给客户端的
     「会话离开宿主注册表」事件；重复宣告在客户端是幂等的），然后才动工作区
     记账与归档集合 —— 顺序即契约。客户端不再需要 `sessions.refresh()`。
  2. `lib/archive.js`：归档相关路径一律改用 0.1.6 的单会话观察入口
     `sessionPersistence.stat(id)`（归档列表按 id 并发 stat），删除一个会话
     只剩一次 stat + 一次 rm；`unarchive` 改走官方公开的
     `workspaceRegistry.unarchiveSession`，不再直接读写
     `registry.state/setState`。归档列表的标题改由客户端会话目录提供
     （`SessionSummary.title`，与官方归档页同源），宿主不再为每条归档会话
     读投影缓存（旧实现还在调用 0.1.6 已改签名的
     `projectionCache.coldSnapshot(id)`，冷会话标题一直是空的）。
  3. `lib/client.js`：新增 **client 半边适配层 `createClientAdapter(ctx)`**
     （与 host 半边 `lib/dsh-adapter.js` 对称）：组件不再触碰
     `ctx.sessions` / `ctx.uiWorkspace` / `ctx.conversation`，只消费适配层
     给出的 `rewind` / `archives` 能力。0.1.6 的两处契约变化都在适配层内
     消化：打开会话 = `uiWorkspace.openSession`；当前会话 = 会话目录里
     `retainedBy.mainView > 0` 的那一行（官方 `ui-agent-preset` 同判据）。
     草稿回填排在 `open` 之后 —— `conversation.input.for(scope)` 要求会话
     已被 retain。适配层工厂经 `__test` 出口由单测直接驱动，边界（适配层
     之外不得出现官方 client 服务）由源码扫描守住。
  4. `lib/client.js` CSS：容器改为按渲染器给出的稳定槽位锚点定位
     （`div:has(> [data-slot="sidebar.footer.action"])`，每个 slot 都有这个
     `display:contents` 锚点，两端构建一致），条目去掉 `flex:none` —— 万一
     容器仍是行排布，条目随容器收缩而不是把相邻插件挤没。
- **验证**：单测覆盖（删除路径不整库 `list()`、宣告早于记账、走官方
  unarchive、客户端适配层行为与边界、锚点选择器、`sessions.open` 与
  `current` 均已消失），`node --test` 30/30 通过；桌面端与 web 端的槽位锚点
  已在两端构建产物里核对一致（`data-slot` + `display:contents` 由渲染器发出，
  两侧 CSS-Modules 哈希各不相同，故只能锚在槽位上）；浏览器验收见文末
  「验收纪律」。
- **部署**：桌面端与 web 端**不是同一份代码**。web profile 的
  `@the-heart-fickle/dsh-session-manager` 是指向本仓库检出目录的软链
  （改完重启 `dsh web` 即生效）；桌面 profile 是官方 `pnpm install` 装下来的
  独立副本（`node_modules/@the-heart-fickle/dsh-session-manager`，spec 为
  `github:TheHeartFickle/dsh-session-manager#master`，lockfile 里钉的是提交号）。
  本修复必须先提交并推到 `master`，桌面端才会在下一次
  `dsh profile` 的包重建 / 重启时拿到它 —— 否则桌面端一直跑旧代码，
  症状（未分组、`sessions.open` 报错、与 dsh-context 挤成一行）原样保留。


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
  （`source.kind === "user"` 这一条过滤在 S9 中补上了 steering 剔除与边界修正。）

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
  检查点重新开始）。边界改为服务端逐条下发（`inputs[].boundary`），客户端
  `toEntries` 直接消费（无压缩时首条 boundary 为 null，维持「第一条输入不可
  回退」语义）。**边界取值本身在 S9 中被修正**：不再把底线当地界，而是取
  「选中输入所在 turn 之前最后一个 `turn/end`」，靠 fork 的前推切片让种子
  天然携带压缩段（压缩后首条的种子切到该 turn 的 `turn/start`，压缩段必在
  其前）。
- **验证**：单测覆盖（压缩前剔除 / 多次压缩取最后底线 / 压缩后无输入 →
  空列表）；浏览器验收并入 S5 的验收流程。

### S9 `[commit]` 回退实际未截断：前序回合未闭合时 fork 整段复制原会话

- **现象**（用户提供的 `dsh-session-session-a4fa01ed-*.zip` 与配套子会话
  `dsh-session-session-4448a798-*.zip`，日志逐条核实）：在 session-a4fa01ed
  打开回退弹窗，选中最新的用户输入（turn 40「npm run build的时候,日志在
  build-cache…」）确认回退，得到的新会话 session-4448a798 事件与父会话逐条
  相同（3776 → 3778，只多 `session/end-seed` + `session/title`），**完全没
  回退**；用户在 2 分钟内重试 4 次（e4e6d0fd / ec6ccb8a / 3d3e6c62 /
  4448a798）都是整段复制。
- **根因 `[code]`**：0.1.5 的 `session/fork` 把 `atSeq` **向前吸附到首个
  `turn/end`**，再把切片推进到其后的第一个 `turn/start`
  （`session-controller/src/commands.ts` 的 `anchoredBoundary` +
  `while (cut … !== "turn/start")`）。服务端下发的是「上一条用户输入的 seq」，
  只有当该输入所在回合确实有 `turn/end` 时才会吸附到那个回合末。该会话
  turn 39 因 agent 被中断**没有 `turn/end`**（turn/start 3728 → 下一条
  turn/start 3755），于是 `atSeq=3731` 吸附到 turn 40 的 `turn/end`(3775)，
  切片推进到日志末尾 → 整段复制（切点 3776 = 全长）。同类偏差另有两处：
  （a）压缩后首条的边界取压缩底线（`compaction/end` 不是 turn/end）会吸附
  过头，把选中的输入本身包进种子；（b）steering 插话落盘同样是
  `source.kind === "user"` 的 `user/message`（如 A 的 seq 3651），被当成回退点
  列出，其边界又落在同一回合内、语义不可表达。交叉印证：导出的真实子会话
  d6de226b（旧规则下选 turn 38 输入，边界 = 上一条输入 3683）切点 3702，
  与新规则对同一输入算出的切点一致。
- **修复**：`lib/rewind-entries.js` 两处：
  1. 边界改为**选中输入所在 turn 之前最后一个 `turn/end` 的 seq**：吸附后切片
     正好停在该 turn 的 `turn/start` 之前，选中输入不入种子；压缩段位于该
     turn 之前时被完整携带；前序 turn 未闭合（缺 `turn/end`）时边界回落到更早
     的已闭合 turn —— 未闭合 turn 不能作为合法种子结尾（`_forkSeed` 拒绝
     停在未闭合 turn），只能连同选中输入一起撤销，**绝不能退化成整段复制**。
  2. 按官方 `SteeringHistory` 重放 `agent/inbox/spliced` 队列，剔除被
     `next-step` 认领的 user/message（steering），与聊天投影的 kind 判定一致。
  3. 前序 turn 未闭合（`closedTurn < turn - 1`）时给条目加 `dropsOpenTurns: true`；
     客户端在列表项渲染警告图标、在预览区（确认按钮上方）渲染
     「它前面未正常结束的回合会被一并撤销」文案 —— 只在真的会连带撤销时才出现
     （SPEC.md §1.4）。
- **验证**（单测 + 真实日志复算，浏览器验收待重启实例）：
  - 新增单测：steering 剔除；未闭合前序 turn 的边界回落并带 `dropsOpenTurns`
    （`test/rewind-host.test.mjs`）；客户端提示接线（`test/plugin.test.mjs`）。
  - 用 4 份用户真实导出日志（A/B/C/D 的 `session.v3.jsonl` 共 31 个可回退点）
    复算 0.1.5 的 fork 切点：新边界下 **0 次**包含被选中输入、**0 次**整段
    复制；A 的 turn 40 边界由 `3731` 变为 `3726`（切点由 3776=全长变为
    3728），A 的列表由 13 条降为 12 条（steering 3651 被剔除）。
  - 同一复算跑遍工作区 9 份 live 会话日志（含多帧 zstd 与种子前缀）：
    `dropsOpenTurns` 只命中 A/B/e4e6d0fd/ec6ccb8a/3d3e6c62 的 turn 40 条目
    （正是本次故障点），其余条目零误报。
  - 浏览器验收：重启 0.1.5 实例后在 A 上选 turn 40 回退，应看到警告提示，并得到
    “到 turn 38 为止”的新会话 + 草稿回填（未闭合的 turn 39 会被一并撤销，
    这是 0.1.5 fork 不能停在未闭合回合的必然结果）。

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
- **两端要各验一次**：web profile 的包是本仓库的软链，重启 `dsh web` 即用新代码；
  桌面 profile 的包是 `pnpm install` 下来的独立副本（lockfile 钉提交号），
  必须先把修复推到仓库 `master` 再重建/重启桌面端，否则桌面端跑的还是旧代码
  （S10 的四个症状里，桌面端独有的「与 dsh-context 挤成一行」正是旧代码里
  写死的 web 构建哈希类名造成的）。
