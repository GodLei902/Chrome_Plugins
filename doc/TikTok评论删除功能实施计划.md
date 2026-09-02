# TikTok 评论删除功能实施计划

> 制定日期：2026-09-02
> 当前实现基线：`codex/v2.0.0-baseline` 的 `c749aea`
> TikTok 页面适配参考：`origin/codex/development` 的 `45037ef`
> 实施范围：TikTok 作品页评论与回复的 Preview、删除、自动加载、计划刷新和检查点恢复。

## 1. 目标与结论

在不改变现有 Instagram 功能、删除语义、脚本加载顺序和用户操作流程的前提下，为 Chrome 扩展增加 TikTok 作品页评论清理能力。

TikTok 必须复用当前通用运行时，而不是复制开发分支中的旧核心：

- `CleanerRuntime` 继续编排会话、逐一级评论扫描、候选筛选、删除顺序、分页循环、计划休息、刷新恢复、暂停和停止。
- `WaitCoordinator`、动作节奏、全局限频、任务锁、检查点和 UI 快照继续使用当前实现。
- `src/platform/tiktok/` 只处理 TikTok 的 URL、页面状态、评论 DOM、展开、加载更多、菜单、确认、删除验证和错误分类。
- 开发分支仅作为 TikTok 页面适配参考，严禁合并或拣选其 `core/`、`shared/`、`background/`、`options/`、UI 或 Manifest 改造。

完成后，TikTok 支持以下完整流程：

1. 打开并校验 TikTok 作品页，等待评论页签和评论面稳定。
2. 逐一级评论串行展开回复，扫描并筛选回复候选。
3. 仅删除命中关键词、未在白名单且未受作者保护的回复。
4. 自动加载下一批评论，直到安全确认当前页面没有更多评论。
5. 正式运行的一轮完成后复用既有 10 至 60 分钟随机休息、页面刷新和会话恢复。

## 2. 已确认的范围与边界

### 2.1 不可改变的现有能力

- Preview 只可扫描、筛选、统计和展开明确的回复入口；不得打开菜单、确认删除或修改评论内容。
- 一级评论永远不进入删除候选；回复优先；白名单和作者保护优先于关键词。
- 删除只能在插件 `verifyDeleted()` 明确成功后由核心计数、写入 `processedIds` 并保存检查点。
- 暂停、停止、取消、锁续租、全局限频、节奏、会话删除上限、最长运行时间和刷新恢复继续使用当前通用实现。
- Service Worker、设置页和核心不得解析 TikTok 路径、查询 TikTok DOM、识别 TikTok 菜单文本或保存 TikTok 私有字段。
- 不调用 TikTok 私有接口，不读取网络响应，不依赖 React 内部状态，不写入长期存储的 DOM、菜单文本或账号信息。

### 2.2 前置检查取舍

当前 Instagram 没有实现“当前登录账号、内容页作者、URL 作者三者一致”作为正式删除门槛：`getCurrentAccount()`、`getContentOwner()` 和 `compareAccounts()` 虽存在，但运行时启动仅强制 `checkTarget()`，且 `checkDeletePermission()` 不比较账号。

因此 TikTok **不新增**三者一致校验，也**不为此修改**当前 `CleanerRuntime` 的通用预检调用顺序。TikTok 仅保持与 Instagram 同级的安全行为：

- 规范化目标 URL 必须与当前页面一致。
- 页面出现登录失效、挑战、验证码、限流、错误页或评论面不确定时返回标准错误并暂停。
- 作品作者或 Creator 徽标仅用于评论作者保护和页面内短期判断，不作为新增的账号匹配门槛。
- 正式删除的可操作权限以当前评论行唯一菜单内明确、唯一的可见删除入口为准；入口缺失、重复或确认不明确时暂停。

这项取舍仅排除新的账号一致性要求，不放宽现有目标匹配、挑战/限流、DOM 歧义或删除验证的安全暂停规则。

当前运行时会在启动时调用 `checkTarget()`，并在首次扫描前调用 `detectPageState()`。TikTok 必须在这两个已调用的方法中覆盖当前 URL、明确的登录失效、挑战、验证码、限流和错误页识别；`checkDeletePermission()` 保留为完整插件契约方法，但不新增全局强制调用，也不把账号比较加入现有核心。

### 2.3 TikTok 页面适配参考

开发分支文档和代码提供以下首选 DOM 证据：

| 场景 | 首选证据 | 使用限制 |
| --- | --- | --- |
| 目标作品页 | `https://www.tiktok.com/@<creator>/video/<videoId>` | 仅接受完整 URL；短链、个人页和跳转页不猜测。 |
| 评论层级 | `data-e2e="comment-level-1"`、`data-e2e="comment-level-2"` | 不依赖哈希 CSS 类；更深回复扁平为二级时挂到唯一一级线程。 |
| 评论页签 | 页面内唯一评论页签组 | 页签延迟出现或不唯一时经等待后失败，不扫描错误页签。 |
| 更多菜单 | 当前评论行唯一 `[aria-haspopup="dialog"]` | 菜单必须属于当前重新定位后的评论行。 |
| 删除入口 | 当前菜单唯一 `button[data-e2e="comment-delete"]` | 不在全页或其他弹层中查找。 |
| 作者保护 | 当前评论行作者区域的 Creator 徽标 | 不能由正文、导航账号或其他评论推断。 |

开发分支的探索记录未证明真实删除和二次确认弹层已经成功点击。上述证据只能用于实现和 fixture；真实删除、确认弹层、虚拟列表、分页和刷新必须在测试账号上单独验收。

## 3. 模块映射

| 当前职责 | TikTok 实现位置 | 参考来源 | 约束 |
| --- | --- | --- | --- |
| URL 与目标上下文 | `src/platform/tiktok/identity.js` | development `identity.js` | 返回当前契约的 `TargetContext`，不解析短链。 |
| 页面异常与可见权限 | `src/platform/tiktok/preflight.js`、`errors.js` | development `preflight.js`、`errors.js` | 不实现账号三方一致门槛。 |
| DOM 基础工具 | `src/platform/tiktok/dom.js` | development `dom.js` | 所有选择器和 Creator 本地化词表只能在本目录。 |
| 评论页签、评论面和稳定快照 | `src/platform/tiktok/surface.js` | development `surface.js` | 必须适配当前完整 surface 契约和 `WaitCoordinator`。 |
| 记录、稳定键和线程 | `src/platform/tiktok/comments.js` | development `parser.js` | 输出当前 `root/reply`、`username`、`text`、`isPostAuthor` 字段。 |
| 回复展开、加载更多与分页适配器 | `src/platform/tiktok/loader.js` | development `loader.js` | 当前核心负责循环；插件只执行一次页面动作并返回进度。 |
| 菜单、确认和删除验证 | `src/platform/tiktok/actions.js` | development `actions.js` | 返回 `ActionResult`，不修改会话、统计或队列。 |
| 插件组装 | `src/platform/tiktok/plugin.js` | development `plugin.js` | 完整实现当前 `PlatformPlugin` 所有方法组。 |

TikTok 评论记录使用当前核心已有字段：

```js
{
  id: '短期稳定键',
  parentId: '一级评论稳定键或空字符串',
  kind: 'root' | 'reply',
  username: '短期用户名',
  text: '评论正文',
  isPostAuthor: false,
  element: null, // 仅当前页面运行期
  platform: {},  // 仅由 TikTok 插件读取
}
```

稳定键以作品 ID、层级、一级父评论、用户名和正文摘要为基础；可见时间只能作为当前页面内的冲突消歧证据，不能未经刷新验收就作为长期不变的唯一依据。若相对时间变化导致刷新后无法唯一重现已处理记录，插件必须返回 `ambiguous` 并暂停，不能通过相似文本继续操作。

## 4. 分阶段实施计划

每个阶段必须按“限定本阶段改动 -> 静态检查 -> 自动化测试 -> 必要的真实页面验收 -> 记录结果 -> 提交”的顺序完成。以下“测试与推进门禁”全部通过前，不得进入下一阶段、提前开放 TikTok，或把后续阶段的代码混入当前提交。

每个阶段的验收记录至少包含：提交号、执行命令及结果、fixture 名称、真实页面的页面类型和测试批量、Preview/实际结果，以及任何暂停原因。记录不得包含账号名称、评论正文、DOM 快照或菜单文本。仅修改文档的阶段不需要执行 `node --check`；所有包含 JavaScript 改动的阶段均须执行第 5.1 节的公共命令。

### 阶段 0：冻结双平台回归基线

**目标：** 固定当前 Instagram 行为，记录 TikTok 参考边界。

- 执行并记录 `git status --short --branch`、修改文件的 `node --check`、`npm test` 和 `git diff --check`。
- 使用测试账号完成 Instagram Preview；具备条件时验证一条回复删除，记录目标类型、批量和结果。
- 将 development 的 TikTok fixture 场景转换为当前分支待新增测试清单，不复制其核心测试或运行时。

**测试与推进门禁：**

- `npm test`、已有 JavaScript 的 `node --check` 与 `git diff --check` 全部通过，并保存基线提交号和测试输出。
- Instagram Preview 必须完成；可控测试账号具备删除条件时，单条回复删除必须完成且不影响一级评论、作者回复和白名单回复。若账号条件不满足，记录缺口，后续阶段不得把它标记为已验收。
- TikTok fixture 清单须覆盖 URL、页签、层级、菜单、确认、虚拟列表、分页、挑战/限流和刷新恢复，才可开始阶段 1。

**提交边界：** `冻结TikTok接入基线`

### 阶段 1：建立 TikTok 身份和注册能力

**目标：** 让后台、设置页和内容脚本可通过注册中心识别 TikTok，但尚不执行页面动作。

- 新增 `identity.js`、`errors.js`、`plugin.js`，注册 `id: 'tiktok'`、显示名、目标 URL placeholder 和能力声明。
- 严格规范化完整的 `www.tiktok.com/@<creator>/video/<id>` 地址，清除查询参数；拒绝短链、个人主页和非 `www` host。
- 页面 DOM 能力未加载时，插件方法必须返回 `unsupported`，与 Instagram 插件的后台安全包装方式一致。
- 新增 TikTok URL、页面匹配、注册、错误分类和完整契约测试。

**测试与推进门禁：**

- 自动化测试覆盖完整 URL 的规范化、查询参数清除、错误 host、短链、个人页、插件注册、能力声明、`unsupported` 安全返回和错误分类；既有 Instagram 测试全量通过。
- 对注册中心、后台目标路由和设置页目标解析进行非 DOM 集成测试，确认 TikTok 仅能被识别，尚不能触发 TikTok 页面动作。
- 当前阶段不得修改 Manifest、内容脚本加载链或 Instagram 平台目录；差异审查通过后才可开始阶段 2。

**提交边界：** `新增TikTok身份插件`

### 阶段 2：实现评论页签、评论面和记录解析

**目标：** 在不接入删除动作前，完成安全的 TikTok Preview 基础。

- 新增 `dom.js`、`surface.js`、`comments.js`。
- 页面初始位于非评论页签时，只点击唯一评论页签，并通过当前 `WaitCoordinator` 等待评论节点出现、Mutation 去抖和连续稳定快照。
- `surface` 完整实现当前 `findCommentSurface`、滚动面、观察器、快照、可见性、滚动状态和 `waitUntilStable` 方法。
- 一级评论映射为 `root`，所有可证明归属于同一一级评论的二级及更深扁平回复映射为 `reply`；没有唯一父级时暂停。
- Creator 徽标只在当前行作者区域识别，并映射为 `isPostAuthor` 以复用现有候选保护；正文出现 Creator 文案不得保护。

**测试与推进门禁：**

- fixture 测试覆盖评论页签延迟/重复、评论面重复/替换、稳定快照、观察器释放、一级与回复映射、父级缺失、稳定键冲突、Creator 区域误判和节点重绘。
- 运行时测试确认 Preview 只产生扫描和统计结果，一级评论与 Creator 回复不会成为候选，且不会调用菜单、确认或删除动作。
- 在测试账号作品页完成一次仅 Preview 的浏览器验收：评论页签、稳定等待、解析结果和暂停语义均正确；不满足时只修复阶段 2，不进入回复展开。

**提交边界：** `实现TikTok评论面解析`

### 阶段 3：接入逐父评论回复展开

**目标：** 使用当前核心的“一级评论 -> 展开 -> 扫描 -> 筛选”顺序加载 TikTok 回复。

- 实现 TikTok `loader.expandParent()`，每次只处理当前一级评论线程内一个明确入口。
- 每次点击前后通过现有 `coordinateAction`、全局限频、可取消等待、Mutation 与稳定快照确认新增回复或明确展开状态。
- 节点替换后必须重新定位当前父评论和展开入口；无进展、超时、重复入口或取消均停止本轮。
- Preview 允许展开回复用于统计，但不得调用 actions 菜单或删除方法。

**测试与推进门禁：**

- fixture 和运行时测试覆盖逐父评论单入口展开、点击后的新增回复、无进展、入口重复、节点重绘、`AbortSignal` 取消以及观察器和等待释放。
- Preview 回归测试必须证明按“一级评论 -> 展开 -> 扫描 -> 筛选”串行执行，并断言菜单、删除和确认方法调用次数均为零。
- 在测试账号作品页完成至少两个一级评论线程的 Preview 展开验收，包括一个没有回复或无法展开的线程；任何歧义必须暂停而非继续下一个线程。

**提交边界：** `接入TikTok串行回复展开`

### 阶段 4：实现可验证删除动作

**目标：** 让当前核心的统一删除模板可安全调用 TikTok 插件。

- 实现 `resolveElement`、`ensureReplyVisible`、`revealMenu`、`getMenu`、`findDeleteAction`、`confirmDelete`、`verifyDeleted` 和悬停点。
- 只允许当前行唯一的菜单入口、当前新打开菜单唯一的删除入口、当前确认弹层唯一且明确的确认动作。
- 删除后等待目标稳定键从当前评论面消失，并等待评论面稳定；无法确认时不得更新 `deleted` 或 `processedIds`。
- 二次确认结构以测试账号页面为准；development 的选择器不匹配时返回 `ambiguous`，不得扩大选择范围。

**测试与推进门禁：**

- fixture 测试覆盖行元素重新定位、菜单/删除项/确认动作的唯一与重复匹配、确认缺失、删除验证超时、验证成功及页面重绘；失败结果不得改变核心删除数或 `processedIds`。
- 运行时测试覆盖一级评论、作者回复和白名单回复不可删除，以及 `verifyDeleted()` 成功前核心不会处理下一个候选。
- 仅使用测试账号完成一条普通命中回复的真实删除；确认实际消失后，再验证不命中、一级、作者和白名单回复均未被操作。真实确认弹层不明确时，本阶段判定失败并暂停。

**提交边界：** `实现TikTok可验证删除动作`

### 阶段 5：实现分页并接入现有持续运行

**目标：** 覆盖自动加载更多、分页结束、随机休息、刷新和恢复。

- 在 `loader.js` 实现当前契约的 `createPagination()`、`loadNextBatch()`、进度快照和 `cancel()`；返回当前 `CleanerRuntime.process()` 已消费的分页状态，而不新建 TikTok 任务循环。
- 加载更多时只接受唯一可见入口；无入口时可滚动唯一评论滚动面。所有动作都经现有动作协调、限频和可取消等待。
- 加载前后比较稳定键集合，只有明确新增记录才报告 `loaded`；连续无增长、评论面稳定、无待展开回复且无可操作入口时才报告 `completed`。
- 发生虚拟列表回收或容器替换时重新发现评论面；无法确认增长或结束时返回 `ambiguous` 或 `not-ready`。
- 分页返回 `completed && newIds === 0` 后，由现有 `finishCurrentRound()` 进入 scheduled-rest、保存检查点、创建 Alarm、刷新页面并恢复；TikTok 插件不得自行调度刷新。

**测试与推进门禁：**

- fixture 和运行时测试覆盖唯一/缺失/重复分页入口、滚动新增、连续无增长、待展开回复、分页取消、虚拟列表回收、完成条件和跨平台锁/限频隔离。
- 使用可控时钟、Alarm 和检查点 fixture 验证 `finishCurrentRound()` 的计划休息、页面刷新、恢复和已处理 ID 去重；TikTok 插件不得出现单独的定时器或刷新调度。
- 在测试账号作品页完成多批评论加载、结束判断和一次休息后的刷新恢复验收；恢复后不得重复处理已验证删除的回复。缺少稳定键唯一性时必须暂停，不能以文本近似匹配继续。

**提交边界：** `接入TikTok评论分页`、`验证TikTok续跑恢复`

### 阶段 6：接入页面脚本、设置与最小权限

**目标：** 仅在插件能力和测试完成后对用户开放 TikTok。

- Manifest 新增独立 TikTok `content_scripts` 条目和最小 `https://www.tiktok.com/*` 权限；Instagram 脚本数组和权限保持不变。
- TikTok 脚本链加载同一份 shared/core 文件和 TikTok 插件文件，不加载 Instagram DOM 模块。
- Service Worker 与设置页加载 TikTok identity/plugin，使注册中心能按目标 URL 路由；不加载 TikTok 页面 DOM 模块。
- 设置页沿用当前按目标 URL 解析平台的方式，保留已有通用节奏、关键词、白名单、限频和会话字段；更新 Instagram 单平台提示为中性文案。
- README 与操作文档明确 TikTok 已验证页面范围、Preview/Start 差异、最小权限和测试账号边界。

**测试与推进门禁：**

- 校验 Manifest 为 V3，TikTok 只使用独立的 `https://www.tiktok.com/*` 匹配和权限；检查 TikTok 脚本链加载顺序、后台/设置页不加载 TikTok DOM 模块，以及 Instagram 原脚本数组和权限字节级未变。
- 加载未打包扩展，分别完成 TikTok 与 Instagram 的启动、Preview、Pause/Stop 冒烟测试；TikTok 还须复跑阶段 4 和阶段 5 的测试账号用例，Instagram 不得出现路由、面板或删除语义回归。
- 执行完整 `npm test`、所有修改 JavaScript 的 `node --check` 和 `git diff --check`。仅在自动化、双平台浏览器验收和文档审查全部通过后，才可将 TikTok 标为已支持并进入发布准备。

**提交边界：** `接入TikTok内容脚本`、`更新TikTok支持说明`

## 5. 测试与验收门禁

### 5.1 自动化测试

新增 TikTok fixture、契约和运行时测试，至少覆盖：

- URL 规范化、错误 host、短链、个人页和页面匹配。
- 延迟出现的评论页签、非评论页签切换、多个评论面、容器替换和观察器释放。
- 一级/回复层级、扁平深层回复、稳定键重复、父级缺失、节点重绘和作者区域 Creator 徽标。
- 逐父评论单入口展开、展开无进展、取消、Preview 可展开但零菜单/删除动作。
- 唯一菜单、唯一删除入口、确认缺失或重复、删除验证超时和删除成功后的稳定等待。
- 分页入口唯一/缺失/重复、滚动增长、无增长、待展开回复、取消、页面重绘和完成条件。
- 计划刷新、检查点恢复、已处理 ID 去重、Pause/Stop 取消等待与跨平台锁/限频隔离。
- Instagram 全量回归：现有 65 个测试必须持续通过，且不替换或删减 Instagram 测试。

每个包含 JavaScript 改动的阶段，均至少运行：

```bash
node --check <修改的 JavaScript 文件>
npm test
git diff --check
```

上述命令是公共基线，不替代第 4 节各阶段的 fixture、契约、运行时和真实页面门禁。某项测试失败时，必须在当前阶段修复、补齐回归用例并重新执行该阶段全部门禁；不得通过跳过场景、降低唯一性判断或提前进入下一阶段规避失败。

### 5.2 真实页面验收

只使用测试账号和本人可管理的 TikTok 作品，按以下顺序进行：

1. Preview：验证评论页签、一级评论、回复展开、关键词、白名单和 Creator 评论保护。
2. 单条删除：只删除一条普通命中回复，确认未误删一级评论、作者回复或白名单回复。
3. 菜单与确认：分别验证唯一、缺失、重复或不明确认结构均符合暂停语义。
4. DOM 重绘：展开、删除和列表替换后确认能够重新定位或安全暂停。
5. 分页：验证加载更多、滚动加载、无新增、待展开回复和结束判断。
6. 续跑：验证完成一轮后的随机休息、Alarm 刷新、检查点恢复和不重复处理。
7. 中断：验证 Pause、Stop、页面关闭、挑战、限流和验证码能取消所有等待、观察器、分页与刷新任务。

每次记录页面类型、扩展版本、批量、Preview 结果、实际结果和暂停原因；不记录账号名称、评论正文或 DOM 到配置和长期会话。

## 6. 强制停止条件

遇到下列情况必须暂停并保留可理解的错误，而不是扩展选择器、重试点击或跳过验证：

- 当前 URL 与规范化目标不一致。
- 页面出现登录失效、挑战、验证码、限流、错误页或不可恢复的评论面加载失败。
- 评论面、评论行、父级、展开入口、菜单、删除项或确认动作不是唯一匹配。
- 容器重绘或虚拟列表回收后无法按稳定键唯一定位。
- 展开、加载更多或删除后未得到明确增长、消失或稳定结果。
- 用户 Pause、Stop 或会话 `AbortSignal` 已触发。

## 7. 完成定义

只有同时满足以下条件，TikTok 才能在 README 和界面中标为已支持：

1. TikTok 插件通过完整 `PlatformPlugin` 契约，核心没有 TikTok DOM、URL、菜单文本或错误码。
2. Preview、逐父评论展开、候选保护、删除验证、自动加载、分页结束、休息刷新和检查点恢复均通过自动化测试。
3. Instagram 全量自动化测试和至少一次受控浏览器回归保持通过。
4. TikTok 测试账号完成 Preview、单条删除、分页、刷新恢复和 Pause/Stop 验收。
5. 所有歧义、验证失败、权限不可见、重绘、挑战和限流均可安全暂停。
6. Manifest 只授予经实际验证需要的 TikTok 域名权限，且不改变 Instagram 现有权限和注入范围。
