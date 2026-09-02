# TikTok 接入阶段 1 验收记录

> 阶段提交：`接入TikTok测试入口`
>
> 记录日期：2026-09-02

## 实现范围

- 新增 `src/platform/tiktok/identity.js`、`preflight.js`、`errors.js` 和 `plugin.js`，并以 `id: 'tiktok'` 注册完整 `PlatformPlugin` 契约。
- 仅接受 `https://www.tiktok.com/@<creator>/video/<id>`；规范化时移除查询参数和片段，拒绝短链、个人主页及非 `www` host。
- 内容脚本仅加载 TikTok 身份、预检、错误分类、插件、既有核心和面板；未实现的评论面、解析、加载器和动作方法均返回 `unsupported`，不会扫描、展开、打开菜单或删除。
- 后台和设置页仅加载 TikTok identity/plugin，不加载页面 DOM 模块；两者均通过注册中心路由规范化目标 URL。

## 自动化结果

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 阶段 1 语法与测试 | `node --check <阶段 1 修改的 JavaScript> && node --test test/tiktok-stage1.test.js` | 5 项通过，0 项失败 |
| 全量 JavaScript 语法 | `rg --files -g '*.js' src scripts test \| xargs -n 1 node --check` | 通过 |
| 全量回归 | `npm test` | 70 项通过，0 项失败；原有 Instagram 65 项全部保留并通过 |
| 差异空白检查 | `git diff --check` | 通过 |

`test/tiktok-stage1.test.js` 覆盖完整 URL、查询清除、错误 host、短链、个人页、插件注册、能力声明、全部契约方法、安全 `unsupported`、目标匹配、登录/挑战/限流/错误页分类、后台路由、设置页解析、Manifest 脚本隔离和 Preview 安全暂停。

## 真实页面验收

未执行。当前工作区没有可用于验收的测试账号或本人可管理的 TikTok 作品 URL。阶段 1 的人工门禁仍待完成：重载未打包扩展、刷新测试作品页、保存完整目标 URL，并确认浮动面板出现后 Start/Preview 因“当前 TikTok 能力尚未实现”暂停，且评论区没有扫描、展开、菜单或删除动作。

该缺口不影响阶段 1 代码的静态验证，但在完成上述人工验收前不得将 TikTok 标记为已支持，也不得进入阶段 2。
