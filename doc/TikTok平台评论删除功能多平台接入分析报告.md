# TikTok 平台评论删除功能多平台接入分析报告

> 分析日期：2026-09-02
> 分析范围：确认当前代码能否在不改变 Instagram 评论删除流程的前提下，引入 TikTok 平台。
> 结论类型：代码结构、自动化测试与接入边界分析；不包含 TikTok 或 Instagram 的真实删除验收。

## 1. 结论摘要

当前项目已经完成 Instagram 的阶段 0 至阶段 5 插件化迁移，**具备以独立平台插件接入 TikTok 的核心架构条件**；但 **TikTok 评论删除功能尚未实现，不能直接使用或宣称已支持**。

这两个结论并不矛盾：

- 已完成的是通用核心、消息协议、会话/锁/限频隔离、设置解析与 Instagram 插件迁移。新增平台不需要复制 `CleanerRuntime`、候选规则、面板、节奏或后台任务逻辑。
- 尚未完成的是 TikTok 自身的页面适配。当前没有 `src/platform/tiktok/`、TikTok 域名权限、页面匹配、评论 DOM 解析、回复展开、删除菜单、确认、结果验证、fixture 或真实页面小批量验证。

因此，TikTok 的正确实施范围是方案中的阶段 6：新增独立插件、注册项、最小 Manifest 权限、测试和文档；不改变 Instagram 的业务流程，也不在核心中增加 `if (platform === 'tiktok')` 分支。

## 2. 当前完成状态

| 范围 | 当前实现 | 对 TikTok 的意义 |
| --- | --- | --- |
| 通用运行时 | `src/core/cleaner-runtime.js` 负责编排目标确认、锁、扫描、候选、删除、休息、分页、续跑、暂停和停止 | 可直接复用，不应复制 |
| 会话与等待 | `TaskSession`、`WaitCoordinator`、UI 快照、节奏和限频均在 core/shared | 可直接复用，不应复制 |
| 候选策略 | `src/core/candidate-policy.js` 统一处理仅删回复、一级评论保护、作者保护、白名单和关键词 | TikTok 插件不得绕过或重写 |
| 插件契约 | `src/platform/contract.js` 对 identity、preflight、surface、loader、comments、actions、errors 全部方法组校验 | TikTok 必须完整实现或明确返回 `unsupported` |
| 插件注册 | `src/platform/registry.js` 通过 URL 解析并注册平台 | 新增 TikTok 时只增加注册项 |
| Instagram 插件 | `src/platform/instagram/` 已承载 URL、评论面、解析、文案、展开、分页、菜单、删除和异常 | 是 TikTok 插件的职责边界参考，不是 DOM 代码模板 |
| 后台与消息 | `SC_*` 消息显式携带 `platformId` 与规范化目标 URL；锁、会话、限频和刷新 Alarm 均按平台+目标隔离 | 可避免跨平台串任务 |
| 设置页 | 通过注册中心解析平台和规范化目标 URL；通用节奏与限制不再绑定 Instagram | 新平台接入后可复用相同配置结构 |
| Manifest | 仅含 Instagram `matches` 与 `host_permissions` | TikTok 页面不会被注入，符合最小权限原则 |
| 自动化测试 | `npm test` 当前 63/63 通过，覆盖核心候选、运行时顺序、Instagram 适配器和契约 | 不能证明 TikTok 页面可操作 |

## 3. Instagram 流程的不可变边界

TikTok 接入只能替换平台识别和页面操作实现，不能改变以下通用业务语义和顺序：

1. 设置读取后等待当前 URL 稳定，并确认设置目标与当前页面一致。
2. 获取并续租目标任务锁，保存运行检查点。
3. 按一级评论串行展开回复，再针对当前父评论建立候选。
4. 一级评论默认不进入删除候选；内容作者与白名单优先保护，之后才匹配关键词。
5. Preview 仅扫描、筛选和统计，不打开菜单、不确认删除、不改变页面内容。
6. 正式删除先确认回复可见、重新定位、滚入可操作位置、悬停，并最多等待 1.8 秒让评论菜单出现。
7. 菜单动作、删除和二次确认仍经统一节奏与全局限频协调；删除项不唯一或确认不明确时暂停。
8. 仅在插件明确验证目标评论已删除且评论面稳定后，核心才累计 `deleted`、写入 `processedIds`、保存检查点，并重新展开当前父评论。
9. 分页仅在 `completed && !newIds` 时结束；正式运行完成后进入既有的 10 至 60 分钟刷新续跑窗口。
10. Pause 保存检查点并释放锁；Stop 清理会话并回到 `idle`；挑战、限流、权限不足、歧义和未知异常均暂停。

## 4. TikTok 仍未实现的能力

### 4.1 平台身份与前置检查

需要在 `src/platform/tiktok/identity.js` 与 `preflight.js` 中基于 TikTok 实际页面确认：

- 可删除目标视频/内容 URL 的规范化规则、页面匹配和目标上下文。
- 登录状态、当前账号、内容作者与删除权限的可靠识别。
- 挑战、验证码、限流、权限不足和不确定页面状态到标准错误类别的映射。

账号、作者或权限无法确认时必须返回 `ambiguous`、`permission` 或其他明确错误，不能猜测后继续删除。

### 4.2 评论面、回复与虚拟列表

需要在 `surface.js`、`comments.js` 与 `loader.js` 中确认：

- 评论抽屉/弹层、可滚动区域和虚拟列表替换后的重新发现方式。
- 评论及回复的稳定 ID、父子关系、作者、正文、内容作者保护标记和短期元素引用。
- 展开回复、加载更多、结束状态和取消行为。
- DOM 重绘、列表回收或定位失败时的安全暂停。

TikTok 的页面结构必须来自测试账号实际页面采样。不能基于 Instagram 的 `/c/` 链接、`ul` 层级、菜单文案或选择器推断实现。

### 4.3 菜单、删除确认与结果验证

需要在 `actions.js` 与 `errors.js` 中确认：

- 如何唯一定位当前回复的菜单入口，并按既有顺序滚动、悬停、等待菜单和执行动作。
- 删除项和二次确认弹层的唯一性判断。
- 节点重绘后如何按统一评论记录重新定位。
- 以可见 UI 证明目标评论消失，并在删除后等待稳定。

不得调用 TikTok 私有接口、构造不可验证网络请求或把菜单文案、DOM 节点、账号名称写入长期会话存储。

## 5. TikTok 阶段 6 的最小改动清单

完成页面研究后，只应增加以下范围：

1. `src/platform/tiktok/` 下的 identity、preflight、surface、comments、loader、actions、errors 与 plugin 组装文件。
2. TikTok 插件注册和页面脚本加载项。
3. TikTok 实际需要的最小 `content_scripts.matches` 与 `host_permissions`，不提前开放无关域名。
4. TikTok 的 `targetPlaceholder`、必要的 `platformOptions` 默认值，以及由注册中心解析的设置元数据。
5. URL/页面匹配、登录/作者/权限、评论面、虚拟列表、ID/父子关系、展开、菜单、删除确认、删除结果、DOM 重绘和歧义暂停的 fixture 与契约测试。
6. README 与操作文档中的支持范围、权限、Preview/Start 差异和风险边界。

不应修改：`src/core/cleaner-runtime.js` 的流程模板、`candidate-policy.js` 的保护策略、面板交互、通用节奏/限频、Instagram 插件逻辑或既有 Manifest 的 Instagram 权限。

## 6. 建议的实施顺序

1. 用测试账号采样 TikTok 目标视频页、评论抽屉、回复、评论菜单、删除确认和挑战/限流页面，不执行生产账号批量删除。
2. 先实现 URL 规范化与前置检查，并以 fixture 固定 `ActionResult`、错误类别和不确定状态的暂停语义。
3. 实现评论面稳定性、记录转换和父子关系；无法证明层级时保留为一级评论，不能放进删除候选。
4. 实现逐父评论的回复展开和分页，接入现有 `coordinateAction`、`WaitCoordinator` 与取消信号。
5. 实现菜单、删除确认和验证；在 `verifyDeleted()` 明确成功前不得让核心更新统计或 `processedIds`。
6. 添加契约、DOM fixture 和运行时顺序测试，然后进行 Preview 与测试账号小批量真实验证并记录页面、账号、批量和结果。

## 7. 验收标准

### 7.1 静态与自动化验收

- TikTok 插件通过完整 `PlatformPlugin` 契约校验。
- 核心不新增 TikTok URL、CSS 选择器、菜单文本、评论链接格式或平台错误码。
- Service Worker 不解析 TikTok 路径；所有目标地址经注册中心与 TikTok 插件处理。
- Preview 不产生页面修改；一级评论、作者评论和白名单仍受保护。
- 所有歧义、菜单/确认缺失、重绘、验证失败、挑战、限流和未知异常都暂停。
- `node --check`、`npm test` 和 `git diff --check` 通过。

### 7.2 真实页面验收边界

只可使用测试账号、Preview 和小批量内容验证。记录目标页面类型、账号身份、批量、预览结果、实际结果与异常页面处理。静态测试或一次页面成功都不能证明 TikTok 在所有页面、语言、账号状态或虚拟列表条件下可用。

## 8. 最终结论

“方案的代码层改造是否已实现”的准确回答是：**Instagram 的阶段 0 至阶段 5 已完成，系统已具备按插件接入第二平台的核心结构；TikTok 的阶段 6 尚未实现，因此当前产品仍只支持 Instagram。**

后续 TikTok 工作应是独立的平台适配项目，而不是复制 Instagram 内容脚本或改写核心流程。这样才能同时满足“整体流程与 Instagram 一致”和“平台页面与具体动作可不同”两项要求。
