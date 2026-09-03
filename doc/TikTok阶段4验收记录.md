# TikTok 评论删除功能阶段 4 验收记录

> 阶段范围：实现可验证删除动作
>
> 记录日期：2026-09-03

## 实现范围

- 新增 `src/platform/tiktok/actions.js`，实现评论元素按稳定键重定位、回复可见性确认、悬浮显示更多入口、唯一菜单发现、唯一 `button[data-e2e="comment-delete"]` 删除动作、删除确认和删除后稳定键消失验证。
- 删除链路严格限定为“当前评论行 → 唯一 `[aria-haspopup="dialog"]` → 本次打开的新 `role="dialog"` → 唯一删除按钮”。菜单、删除项、确认弹层或元素重定位出现重复、缺失和状态不明确时返回标准错误并暂停。
- Preview 模式下动作模块拒绝打开菜单、删除和确认；核心只有在 `verifyDeleted()` 明确成功后才增加删除数和 `processedIds`。
- TikTok 内容脚本已在 `plugin.js` 前加载 `actions.js`；页面模块加载后插件声明 `supportsCommentDelete: true`。后台与设置页仍不加载页面 DOM 模块。

## 自动化结果

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 阶段 4 JS 语法 | `node --check src/platform/tiktok/actions.js`、`node --check src/platform/tiktok/plugin.js`、`node --check test/tiktok-stage4.test.js` | 通过 |
| 全量 JavaScript 语法 | `rg --files -g '*.js' src scripts test \| xargs -n 1 node --check` | 通过 |
| 阶段 4 fixture | `node --test test/tiktok-stage4.test.js` | 6 项通过，0 项失败 |
| 全量回归 | `npm test` | 88 项通过，0 项失败 |
| 差异空白检查 | `git diff --check` | 通过 |

阶段 4 新增覆盖：

- 评论节点重绘后的稳定键重新定位；
- 更多入口重复、删除项缺失或重复、Preview 禁止动作；
- 直接删除后的验证成功；
- 二次确认弹层重复、删除验证超时；
- 删除验证失败时核心不增加删除数、不写入 `processedIds`；
- 内容脚本加载顺序与插件删除能力声明。

## Chrome 页面结构探测

使用用户提供的 Chrome TikTok 作品页进行只读探测，未点击删除按钮或确认删除：

- 评论行内存在唯一 `[aria-haspopup="dialog"]` 更多入口，悬浮后可见；
- 点击该入口后出现新的 `role="dialog"`；
- 弹层内存在唯一 `button[data-e2e="comment-delete"]`，日文可见文案为“削除”；
- 当前页面未证明二次确认弹层结构，也未执行真实删除。

因此，本阶段的真实删除门禁仍待测试账号和本人可管理作品上单条验证；本记录只确认了菜单和删除按钮的 DOM 证据，不把自动化 fixture 或静态探测表述为真实删除成功。
