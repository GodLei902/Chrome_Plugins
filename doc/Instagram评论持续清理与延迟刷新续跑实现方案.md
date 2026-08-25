# 社交评论持续清理与延迟刷新续跑实现方案（跨平台核心，Instagram 首个适配器）

## 1. 文档目的

本文定义社交评论清理器的长期运行改造方案：运营人员点击“开始”后，扩展持续处理目标帖子当前已加载及可继续加载的评论；本轮评论确认处理完成后，进入随机休息态；休息时间结束后，目标页面绕过缓存刷新，并恢复同一个任务会话继续执行。

本文是实现设计，不包含本次代码改动。实现完成后，代码、测试和使用手册应与本文的状态和边界保持一致。

## 1.1 全局化与解耦原则

本方案不是 Instagram 专属的刷新实现，而是“跨平台持续任务运行时”的设计。Instagram 只提供一个平台适配器，后续接入 TikTok、YouTube、Facebook 等平台时，不应复制整套任务循环、休息调度、检查点和刷新恢复代码。

整体分为三层：

```text
全局任务核心
  ├─ 会话状态与检查点
  ├─ 本轮任务调度
  ├─ 10～60 分钟随机休息
  ├─ Alarm 与刷新恢复
  ├─ 暂停、停止、锁和错误边界
  └─ 平台无关的统计与 UI 状态

平台适配器
  ├─ URL 规范化与目标识别
  ├─ 页面加载完成判断
  ├─ 评论区扫描与候选转换
  ├─ 本轮完成判定
  ├─ 删除或其他平台动作
  └─ 平台页面刷新策略

平台入口
  ├─ Instagram Adapter
  ├─ TikTok Adapter（后续）
  └─ YouTube Adapter（后续）
```

全局核心不得直接读取 Instagram DOM、匹配 Instagram 文案或依赖 Instagram URL。所有平台差异都必须收敛到适配器接口中。

## 1.2 平台适配器接口

建议定义平台无关的适配器接口：

```js
{
  platform: 'instagram',
  normalizeTarget(value),
  matchesTarget(location, target),
  waitUntilReady(context),
  createRound(context),
  scan(context),
  processCandidate(candidate, context),
  isRoundComplete(roundResult),
  canRefresh(context),
  reload(context),
  restoreAfterReload(context)
}
```

接口返回标准化结果，不能直接修改全局 `TaskSession`：

```js
{
  commentsScanned,
  repliesScanned,
  candidates,
  processedIds,
  hasMore,
  stable,
  reason
}
```

Instagram 当前的 DOM 发现、回复展开、评论菜单和删除动作迁移到 `platform/instagram` 适配器中；全局运行时只处理候选、统计、节奏、会话、休息和恢复。

## 2. 已确认的业务要求

### 2.1 正式运行

- 点击“开始”后自动打开或激活目标帖子，页面加载完成后自动开始。
- 只要用户没有点击“暂停”或“停止”，任务就持续运行。
- 当前评论处理完毕后，不直接显示“任务完成”并退出，而是进入等待下一轮的休息态。
- 休息时间随机生成，允许配置范围为 **10～60 分钟**。
- 休息结束后强制刷新目标页面，重新扫描并继续执行。

### 2.2 暂停、停止和安全异常

- “暂停”表示暂时停住任务，保留检查点和剩余休息时间；用户点击“继续”后恢复。
- “停止”表示结束本次会话，取消后续刷新，清理检查点并释放任务锁。
- 验证、限流、权限、页面结构或加载稳定性异常时，任务自动进入暂停，不通过刷新掩盖异常。

### 2.3 预览模式

- 预览仍然是扫描和统计模式，不进入长期自动刷新循环。
- 预览不能打开删除菜单，也不能执行删除。

## 3. 当前实现与改造缺口

当前实现已经具备以下能力：

- `src/background/service-worker.js` 负责目标标签页打开、激活、加载等待和任务锁。
- `src/content/social-comment-cleaner.js` 负责扫描、候选筛选、删除、暂停和停止。
- `src/content/comment-pagination-loader.js` 负责当前评论容器的连续加载。
- Service Worker 已定义 `ICC_SAVE_SESSION`、`ICC_GET_SESSION` 和 `ICC_CLEAR_SESSION` 消息，但内容脚本尚未用它们完成刷新后的会话恢复。

当前会阻止长期运行的边界：

1. `process()` 在分页完成后调用 `stop('completed')`，会结束整个会话。
2. `sessionMaxMinutes` 到期会自动暂停，不符合持续运行模式。
3. `run.startedAt`、已处理 ID 和统计数据主要保存在内容脚本内存中，页面刷新后会丢失。
4. `run.pagination` 保存的是当前 DOM 生命周期内的分页状态，刷新后需要重新创建。
5. 内容脚本中的定时器不能保证在 Service Worker 休眠或页面生命周期变化时可靠执行。

除此之外，当前运行循环主要集中在 `src/content/social-comment-cleaner.js`，其中同时包含通用调度、Instagram DOM 解析、菜单操作和删除逻辑。长期运行改造不能继续扩大这个单文件职责，否则后续增加平台时会产生复制和分叉。

## 3.1 建议的全局模块边界

建议逐步形成以下目录结构：

```text
src/core/
  task-session.js              # 会话状态、暂停、停止和检查点
  round-runner.js              # 单轮扫描、处理和完成判定
  scheduled-rest.js            # 10～60 分钟随机休息
  refresh-orchestrator.js      # 刷新请求、恢复和生命周期
  session-lock.js              # 目标任务锁与续租
  task-messages.js             # 平台无关消息协议

src/platform/
  registry.js                  # 平台适配器注册表
  instagram/adapter.js         # Instagram 适配器入口
  instagram/dom-surface.js     # Instagram 评论 DOM
  instagram/comment-actions.js # Instagram 展开、菜单和删除

src/background/
  service-worker.js             # Alarm、标签页和全局调度编排
```

如果本次不立即完成目录拆分，也必须先定义上述边界；临时实现可以继续由现有文件承载，但新逻辑不得新增对 Instagram DOM 的全局依赖。

## 4. 核心概念

### 4.1 本轮任务

“本轮任务”表示从一次页面加载开始，到当前页面中的评论已经完成稳定扫描、自动加载和候选处理的一个完整周期。

本轮完成不等于用户结束任务。完成本轮后，任务进入 `scheduled-rest`，等待下一次刷新。

### 4.2 两种休息

现有操作节奏中的休息和新增的刷新等待必须分开：

| 状态 | 含义 | 是否刷新 |
| --- | --- | --- |
| `cooling-down` | 连续删除达到上限后的短暂休息，仍属于当前轮次 | 否 |
| `scheduled-rest` | 本轮最终完成后的随机等待 | 等待结束后刷新 |

不能复用节奏控制器内部的 `REST` 状态表示整个任务的刷新等待，否则会混淆连续删除休息和跨页面刷新休息。

### 4.3 用户停止与本轮结束

本轮结束不能调用现有的 `stop()`。`stop()` 只保留给用户明确点击“停止”或需要永久终止会话的场景。

本轮结束应调用类似以下语义的方法：

```js
enterScheduledRest(reason)
```

## 5. 状态机

### 5.1 运行状态

```text
RUNNING_ROUND
  -> ROUND_COMPLETED
  -> SCHEDULED_REST
  -> REFRESHING
  -> RUNNING_ROUND
```

异常和用户操作：

```text
任意运行状态 -> PAUSED（用户暂停或安全异常）
任意运行状态 -> STOPPED（用户停止）
```

### 5.2 建议状态定义

| 状态 | 进入条件 | 自动行为 | 离开条件 |
| --- | --- | --- | --- |
| `running` | 会话启动或刷新恢复 | 扫描、加载、删除 | 本轮完成、暂停、停止、异常 |
| `cooling-down` | 连续处理达到上限 | 等待后继续当前轮次 | 休息结束、暂停、停止 |
| `round-completed` | 最终稳定扫描确认本轮完成 | 保存检查点 | 立即进入 `scheduled-rest` |
| `scheduled-rest` | 本轮完成后生成随机等待时间 | 不扫描、不删除，等待 Alarm | 到期刷新、暂停、停止 |
| `refreshing` | 休息 Alarm 到期 | 保存检查点、绕过缓存刷新 | 页面加载完成并恢复 |
| `paused` | 用户暂停或不可安全继续 | 不自动操作 | 用户点击继续或停止 |
| `stopped` | 用户点击停止 | 取消 Alarm、清理会话 | 用户重新点击开始创建新会话 |

## 6. 本轮最终完成判定

只有以下条件全部满足时，才能进入 `scheduled-rest`：

1. 当前候选队列为空。
2. 最后一个删除动作已经完成并确认目标回复消失。
3. 评论容器已经稳定。
4. 已完成有限次稳定重扫，没有发现新的候选。
5. 没有正在展开回复、加载下一批、打开菜单或等待删除确认的动作。
6. 分页器确认没有更多可加载入口，或者滚动到底部后连续达到无新增阈值。

如果达到分页安全上限但不能确认到达末尾，不能直接标记本轮完成。应继续当前轮次、增加内部加载切片，或进入暂停并显示明确原因。

## 7. 完整运行流程

### 7.1 开始任务

1. 设置页校验目标 URL和配置。
2. Service Worker 打开或激活目标标签页。
3. 等待标签页 `status === 'complete'`。
4. 内容脚本获取或创建会话检查点。
5. 获取目标帖子锁并开始续租。
6. 初始化扫描、分页器和节奏控制器。
7. 执行首轮扫描和处理。

### 7.2 处理当前轮次

```text
等待评论区稳定
  -> 展开可见回复入口
  -> 扫描当前 DOM
  -> 处理候选回复
  -> 删除后重新扫描
  -> 当前无候选时加载下一批
  -> 稳定确认无候选且无更多入口
```

正式运行只删除命中的子级回复；一级评论、白名单和帖子作者内容继续受现有保护规则约束。

### 7.3 进入随机休息

本轮完成后只生成一次休息时间，并保存到检查点：

```js
const delayMs = DelayGenerator.generateDelayMs({
  minSeconds: 10 * 60,
  maxSeconds: 60 * 60,
  meanSeconds: 30 * 60,
  distribution: 'log-normal'
});
```

建议设置结构：

```js
refreshRest: {
  distribution: 'log-normal',
  minMinutes: 10,
  maxMinutes: 60,
  meanMinutes: 30
}
```

校验规则：

```text
10 <= minMinutes <= maxMinutes <= 60
```

随机时间一旦生成，后续恢复不能重新随机，必须使用检查点中的 `nextRefreshAt`。

### 7.4 休息到期刷新

Service Worker 使用 `chrome.alarms` 创建一次性 Alarm。Alarm 到期后：

1. 确认目标帖子仍有活动会话。
2. 确认会话未暂停、未停止。
3. 确认标签页仍然存在且 URL 匹配。
4. 将会话状态保存为 `refreshing`。
5. 执行目标页强制刷新。
6. 等待页面加载完成。
7. 内容脚本重新获取检查点并恢复会话。
8. 重新发现评论容器并开始下一轮。

## 8. 定时调度方案

不能在内容脚本中使用单独的长期 `setInterval` 触发刷新。调度应集中在 Service Worker：

### 8.1 新增消息

消息协议应由全局核心定义，不能让 `ICC_` 成为未来所有平台都必须依赖的业务前缀。建议新协议使用平台无关的 `SC_TASK_*` 命名；现有 `ICC_*` 消息在迁移期保留兼容层，仅由 Instagram 适配器或兼容桥接处理。

| 消息 | 用途 |
| --- | --- |
| `SC_TASK_SCHEDULE_REFRESH` | 创建下一轮刷新 Alarm |
| `SC_TASK_CANCEL_REFRESH` | 取消刷新 Alarm |
| `SC_TASK_REFRESH_REQUEST` | 通知平台适配器准备刷新 |
| `SC_TASK_REFRESH_READY` | 适配器确认已保存刷新前状态 |
| `SC_TASK_RESTORE_SESSION` | 页面加载完成后恢复会话 |
| `SC_TASK_SAVE_SESSION` | 保存检查点 |
| `SC_TASK_GET_SESSION` | 读取检查点 |
| `SC_TASK_CLEAR_SESSION` | 清理检查点 |

兼容映射示例：`ICC_SAVE_SESSION -> SC_TASK_SAVE_SESSION`。核心运行时只依赖 `SC_TASK_*`，不能在通用模块中出现 Instagram 专属消息名。

### 8.2 Alarm 命名

使用平台和目标标识的稳定哈希或编码生成唯一名称，例如：

```text
social-task-refresh:<platform>:<normalized-target-id>
```

同一帖子只能有一个活动 Alarm，避免重复刷新。

### 8.3 锁续租

现有目标帖子锁租约为 90 秒，不能覆盖 10～60 分钟的休息态。实现时应：

- 在 `scheduled-rest` 期间由 Service Worker 维护会话租约；或
- 将锁设计为基于检查点和 `sessionId` 的可恢复租约，并在 Alarm 到期恢复时重新校验。

用户暂停或停止后必须释放锁，避免页面长期占用。

## 9. 刷新和缓存策略

业务效果要求是“目标页面强制刷新并获取最新内容”。不建议由全局核心直接清理整个浏览器配置文件的缓存，因为 `chrome.browsingData.removeCache()` 或 CDP 的 `Network.clearBrowserCache` 可能影响其他网站。缓存绕过和页面刷新必须由平台适配器提供能力，全局核心只发出 `reload` 请求。

优先级如下：

1. 平台适配器优先调用 `chrome.tabs.reload(tabId, { bypassCache: true })`。
2. 如果目标平台仍使用旧资源，适配器可以复用现有 `chrome.debugger` 权限：
   - attach 目标标签页；
   - 设置 `Network.setCacheDisabled({ cacheDisabled: true })`；
   - 执行 `Page.reload({ ignoreCache: true })`；
   - 页面加载完成后恢复设置并 detach。

界面文案应使用“强制刷新并绕过页面缓存”。如果未来确实要清理浏览器全局缓存，必须作为单独的高级选项并明确影响范围，不能作为默认行为。

## 10. 会话检查点

建议使用全局 `SC_TASK_SAVE_SESSION` 等消息扩展检查点结构：

```js
{
  schemaVersion: 1,
  sessionId: 'uuid',
  target: {
    platform: 'instagram',
    normalizedId: 'p:xxx',
    url: 'https://www.instagram.com/p/xxx/'
  },
  ownerTabId: 123,
  mode: 'run',
  status: 'running',
  startedAt: 1234567890,
  lastCheckpointAt: 1234567890,

  stats: {
    scanned: 0,
    matched: 0,
    deleted: 0,
    skipped: 0,
    loaded: 0,
    discovered: 0,
    topLevel: 0,
    replies: 0,
    batches: 0
  },

  processedIds: [],
  refresh: {
    count: 0,
    restStartedAt: 0,
    restDelayMs: 0,
    nextRefreshAt: 0,
    lastReason: ''
  },

  pace: {
    state: 'NORMAL',
    consecutive: 0,
    failures: 0
  }
}
```

不能保存以下内容：

- DOM 元素或 React 节点；
- 按钮、菜单和弹窗引用；
- 当前页面的滚动容器引用；
- 任何依赖旧页面生命周期的 Promise 状态。

这些内容刷新后必须重新发现。

检查点保存时机：

1. 会话创建后；
2. 每次删除确认成功后；
3. 本轮最终完成时；
4. 进入 `scheduled-rest` 时；
5. 开始刷新前；
6. 用户暂停时；
7. 用户停止前清理。

## 11. 刷新后的恢复规则

内容脚本加载后：

1. 规范化当前 URL。
2. 根据 `target.platform` 和 `target.normalizedId` 查询检查点。
3. 校验 `sessionId`、目标描述和 `ownerTabId`。
4. `status === 'running'` 或 `status === 'refreshing'` 才允许恢复。
5. `paused` 和 `stopped` 检查点不能自动启动。
6. 恢复累计统计和 `processedIds`。
7. 清空页面级状态，重新创建分页器。
8. 等待评论容器稳定后重新扫描。
9. 进入下一轮处理。

如果标签页被关闭、目标 URL 被改走或检查点校验失败，应将会话标记为暂停或失效，不能猜测恢复到其他帖子。

## 12. 暂停、继续和停止

### 12.1 用户暂停

- 设置 `status = 'paused'`。
- 取消当前等待、分页和稳定观察器。
- 取消刷新 Alarm。
- 保存 `nextRefreshAt` 和剩余等待时间。
- 释放目标帖子锁。

继续时：

- 重新获取锁；
- 重新扫描当前页面；
- 如果仍有未到期的等待时间，继续等待剩余时间；
- 如果等待时间已经到期，直接进入刷新流程。

### 12.2 用户停止

- 设置 `status = 'stopped'`。
- 取消刷新 Alarm。
- 清除会话检查点。
- 清空当前候选队列。
- 释放目标帖子锁。
- 页面后续加载不能自动恢复。

## 13. 配置页设计

新增配置建议：

| 配置 | 默认值 | 限制 |
| --- | ---: | --- |
| 最短刷新休息 | 10 分钟 | 不小于 10 分钟 |
| 最长刷新休息 | 60 分钟 | 不大于 60 分钟 |
| 平均刷新休息 | 30 分钟 | 必须位于最短和最长之间 |
| 持续运行 | 开启 | 直到暂停、停止或安全异常 |

现有 `sessionMaxMinutes` 应改为可选的额外安全上限：

- 选择“持续运行”时不检查该上限；
- 用户选择具体时长时，仍可按旧逻辑自动暂停；
- `sessionLimit` 仍可作为删除数量上限，但持续运行模式建议默认“不限”。

设置说明必须明确：

> 每一轮评论处理完成后，系统会随机休息 10～60 分钟，然后强制刷新目标页面并继续处理。休息期间不会扫描或删除新评论。

## 14. 文件级改造清单

### `src/core/task-session.js`（新增）

- 定义平台无关的 `TaskSession` 状态。
- 管理 `running`、`scheduled-rest`、`paused` 和 `stopped`。
- 负责检查点序列化、恢复和版本迁移。
- 不读取 DOM，不依赖 Chrome 页面 API，不出现 Instagram 文案。

### `src/core/round-runner.js`（新增）

- 调用平台适配器完成扫描、候选处理和本轮完成判断。
- 统一处理候选队列、统计、重复 ID 和最终稳定扫描。
- 不实现 Instagram 菜单、回复入口或删除按钮查找。

### `src/core/scheduled-rest.js`（新增）

- 生成并保存 10～60 分钟随机休息时间。
- 只接受通用时间配置，不依赖 Instagram。
- 确保恢复时使用原有 `nextRefreshAt`，不重复随机。

### `src/core/refresh-orchestrator.js`（新增）

- 负责休息到期、刷新握手、恢复通知和失败状态。
- 通过适配器调用平台页面刷新，不直接调用 Instagram API 或 DOM。

### `src/core/session-lock.js`（新增）

- 负责按 `{ platform, normalizedId }` 维度加锁、续租和释放。
- 不使用 Instagram URL 作为通用锁的唯一数据模型。

### `src/content/social-comment-cleaner.js`

- 迁移为 Instagram 适配器入口和页面控制面板。
- 保留 Instagram DOM 发现、回复展开、菜单和删除实现，逐步移入 `src/platform/instagram/`。
- 不再承载全局会话和长期刷新调度。

### `src/content/comment-pagination-loader.js`

- 迁移为平台可复用的分页加载接口，平台差异通过 surface/controls 适配器注入。
- 区分当前页面分页完成和整个会话结束。
- 达到当前页面边界时向上层返回 `page-completed`。
- 不能让分页器直接终止长期会话。
- 刷新恢复后重新创建分页器和 DOM 状态。

### `src/background/service-worker.js`

- 增加全局刷新 Alarm 创建、查询和取消。
- 增加页面刷新及加载完成等待。
- 增加刷新恢复消息投递。
- 在休息期间维护或校验目标任务锁。
- 防止同一平台目标创建重复 Alarm。
- 不在 Service Worker 中实现任何平台 DOM 选择器。

### `src/shared/action-pace-config.js`

- 增加 `refreshRest` 配置。
- 校验 10～60 分钟范围。
- 支持旧配置迁移。
- 增加持续运行模式和“不限制会话时间”语义。

### `src/shared/delay-generator.js`

- 将当前 `InstagramCommentDelay` 改为平台无关的 `DelayGenerator`。
- 迁移期可以保留 `InstagramCommentDelay` 别名，避免旧测试和 Instagram 适配器一次性全部改动。

### `src/options/options.html` / `src/options/options.js`

- 增加随机休息时间配置。
- 将“本次最长运行时间”改为可选安全上限。
- 明确区分“暂停”“停止”和“本轮完成后等待”。
- 保留自动保存，不新增额外保存按钮。

### `manifest.json`

- 优先复用现有 `tabs`、`debugger` 权限。
- 不默认新增全局缓存清理权限。

### `src/platform/instagram/`

- `adapter.js`：实现平台适配器接口。
- `dom-surface.js`：封装评论容器、稳定快照和分页 surface。
- `comment-actions.js`：封装回复展开、菜单定位和删除确认。
- `refresh.js`：封装 Instagram 页面刷新和加载完成判断。

### 文档

- 更新 `README.md` 的运行流程、暂停/停止说明和自动刷新说明。
- 本方案文档作为实现依据，代码完成后补充实际验证结果。

## 15. 测试方案

### 15.1 单元测试

新增 `test/refresh.test.js`，覆盖：

1. 10～60 分钟范围校验。
2. 随机休息时间生成。
3. 本轮完成后只生成一次 `nextRefreshAt`。
4. 恢复时不重新随机休息时间。
5. `scheduled-rest` 不执行扫描和删除。
6. 暂停取消 Alarm 但保留检查点。
7. 停止清除检查点和 Alarm。
8. `processedIds` 防止刷新后重复删除。
9. 分页完成不会直接结束持续会话。
10. 休息期间到达 Alarm 后才进入刷新。
11. 使用一个假的平台适配器运行完整轮次，核心不读取 Instagram 全局变量。
12. 同一个核心运行时替换第二个平台适配器后，休息、检查点和恢复逻辑无需复制。

### 15.2 Service Worker 测试

模拟：

- Alarm 到期；
- 目标标签页不存在；
- 页面 URL 改变；
- 页面加载超时；
- 刷新期间用户点击停止；
- 同一目标重复创建 Alarm；
- `bypassCache` 刷新失败后的安全暂停。
- 不同平台、不同目标的 Alarm 和锁互不冲突。

### 15.3 浏览器验证

使用测试账号和测试帖子：

1. 先用 Preview 确认评论筛选规则。
2. 将休息范围临时设置为 10～10 分钟验证最短边界。
3. 本轮处理完成后确认进入休息态，而不是完成态。
4. 等待刷新后新增评论能被发现。
5. 刷新前后已处理回复不重复删除。
6. 休息期间点击暂停，确认不会刷新。
7. 休息期间点击停止，确认不会恢复。
8. 在删除确认阶段等待刷新请求，确认不会打断删除。
9. 触发验证或限流，确认不会自动刷新绕过暂停。

### 15.4 静态检查

```bash
npm test
node --check src/background/service-worker.js
node --check src/content/social-comment-cleaner.js
node --check src/content/comment-pagination-loader.js
node --check src/options/options.js
git diff --check
```

## 16. 验收标准

功能完成必须满足：

- 点击开始后可以持续运行多个轮次。
- 本轮没有完成前绝不进入刷新等待。
- 本轮完成后随机等待时间始终在 10～60 分钟内。
- 等待时间由本轮完成时生成，并在检查点中保持不变。
- 等待结束后目标页面绕过缓存刷新并自动恢复。
- 刷新不会造成已处理回复重复删除。
- 暂停不会自动刷新，停止不会自动恢复。
- 页面异常时安全暂停，而不是盲目刷新。
- Service Worker 休眠不影响 Alarm 调度。
- 预览模式保持只扫描、不删除、不长期刷新。
- 全局核心不包含 Instagram DOM、文案或 URL 判断。
- 新增一个模拟平台适配器时，不需要复制任务循环、随机休息、检查点和 Alarm 代码。
- 平台特有的刷新、加载完成和候选动作全部通过适配器接口完成。

## 17. 实施顺序

建议按以下顺序实现：

1. 先抽取 `TaskSession`、`RoundRunner` 和 `DelayGenerator` 等平台无关模块。
2. 增加 `scheduled-rest` 状态和本轮完成判定。
3. 接入 `refreshRest` 配置及 10～60 分钟校验。
4. 接入会话检查点保存和恢复。
5. 在 Service Worker 中接入一次性 Alarm。
6. 定义平台适配器接口并将 Instagram DOM 逻辑迁移到 `src/platform/instagram/`。
7. 实现适配器负责的绕过缓存刷新和页面加载后恢复。
8. 修改暂停、停止和锁续租逻辑。
9. 用模拟适配器验证全局核心，再补充 Instagram 浏览器验证。
10. 更新 README 和运营人员操作说明。
