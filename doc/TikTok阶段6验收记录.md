# TikTok 评论删除功能阶段 6 验收记录

> 阶段范围：完成双平台集成、文档与发布前静态验收
>
> 记录日期：2026-09-03
>
> 阶段提交：`5fb9c70 完成TikTok集成验收`；本验收记录随后以 `更新TikTok支持说明` 提交。

## 实现范围

- 核对并锁定 Manifest 的 MV3 配置、既有 Instagram 内容脚本数组、TikTok 独立内容脚本数组和最小 TikTok 域名权限。
- 确认 TikTok `preflight`、`dom`、`surface`、`comments`、`loader`、`actions`、`errors` 页面模块均在 `plugin.js` 之前加载；TikTok 脚本链不加载 Instagram 页面模块。
- 确认 Service Worker 与设置页只加载 TikTok `identity.js` 和 `plugin.js`，不加载 TikTok 页面 DOM 模块；后台、设置页和内容页通过注册中心对相同完整 TikTok 作品 URL 得出一致平台判定。
- 将 Manifest 描述、设置页版本和目标地址提示、README、运营手册更新为 Instagram/TikTok 双平台中性文案，明确 Preview/Start 差异、平台范围、最小权限、测试账号和真实验收边界。
- 新增 `test/tiktok-stage6.test.js`，把上述脚本隔离、权限、路由、配置字段保留和用户文案约束固定为回归测试。

## 自动化结果

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 阶段 6 JavaScript 语法 | `node --check test/tiktok-stage6.test.js` | 通过 |
| 全量 JavaScript 语法 | `rg --files -g '*.js' src scripts test \| xargs -n 1 node --check` | 通过 |
| 阶段 6 集成 fixture | `node --test test/tiktok-stage6.test.js` | 5 项通过，0 项失败 |
| 全量回归 | `npm test` | 102 项通过，0 项失败；既有 Instagram 测试全部保留并通过 |
| 差异空白检查 | `git diff --check` | 通过 |

阶段 6 自动化覆盖：

- Manifest 为 MV3，TikTok 仅使用 `https://www.tiktok.com/*` 匹配和权限；Instagram 原有匹配、脚本数组和 `document_idle` 加载时机保持不变。
- TikTok 页面模块全部在插件组装前加载，TikTok 链不包含 Instagram 页面模块。
- Service Worker/设置页只加载 TikTok identity/plugin；注册中心对完整 TikTok 作品 URL 的平台判定一致。
- 设置页保留通用关键词、白名单、节奏、限频、会话限制和平台专属字段容器，并按平台规范化目标 URL。
- 用户文案不再宣称“仅支持 Instagram”，同时保留 Preview 只扫描、测试账号、小批量和真实删除需人工验收的安全边界。

## 真实页面验收

本开发环境本阶段未执行 TikTok 或 Instagram 登录态浏览器验收，也未执行真实删除、分页续跑或 Pause/Stop 页面用例。原因是当前任务未提供可用于验收的测试账号和本人可管理的作品 URL。

因此，以下门禁仍保持未完成状态，不将本记录的自动化结果表述为真实平台成功：

1. 未打包扩展重载后刷新 TikTok 作品页，完成 Preview、单条普通回复删除、分页和一次刷新恢复。
2. 在同一测试账号验证一级评论、Creator 回复和白名单回复不被操作。
3. 验证菜单、确认弹层、节点重绘、虚拟列表、挑战/限流、Pause/Stop 的真实页面暂停与等待释放。
4. 使用同等流程完成 Instagram 启动、Preview、Pause/Stop 冒烟回归。

在上述人工门禁完成前，README 和操作手册仅表述为“TikTok 已完成代码与自动化接入”，不把 TikTok 标记为已通过真实页面删除验证，也不建议直接用于生产内容。
