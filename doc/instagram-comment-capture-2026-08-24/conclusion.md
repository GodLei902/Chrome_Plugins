# Instagram 评论接口抓取结论

## 抓取目标

- 页面：`https://www.instagram.com/p/DcZ9jUmvrwS/`
- Instagram 媒体 ID：`3970475254647536658`
- 抓取时间：2026-08-24

## 评论数据来源

当前 Instagram Web 使用 Relay GraphQL 请求返回评论数据，核心接口为：

```text
GET https://www.instagram.com/graphql/query/
```

评论主列表请求：

- `doc_id=27144918868515421`
- `variables.media_id=3970475254647536658`
- `variables.first=50`
- `variables.after=null`
- `variables.before=null`
- `variables.__relay_internal__pv__PolarisIsLoggedInrelayprovider=true`

完整 URL 和响应报文见同目录的 `instagram-comment-capture.json`。

## 响应结构

评论位于：

```text
data.xdt_api__v1__media__media_id__comments__connection.edges[].node
```

每条评论的主要字段包括：

- `pk`：评论 ID
- `user.username`：评论作者
- `text`：评论内容
- `parent_comment_id`：父评论 ID；顶层评论为 `null`
- `child_comment_count`：回复数量
- `created_at`：创建时间戳
- `comment_like_count`：点赞数
- `is_covered`、`restricted_status`：覆盖或限制状态
- `page_info.has_next_page`：是否还有下一页

本次主列表响应返回 5 条顶层评论，`child_comment_count` 表明其中 2 条各有 1 条回复；页面可见评论总数为 7 条。

## 相关 Relay 操作

- 帖子主体：`PolarisPostRootQuery`，`doc_id=39012401901691788`，根字段为 `xdt_api__v1__media__shortcode__web_info`
- 评论分页：`PolarisPostCommentsPaginationQuery`，`doc_id=28082902984733691`
- 点击一级评论的“查看回复”后首次加载子级评论：`PolarisPostChildCommentsQuery`，`doc_id=27823744063932558`
- 已展开回复继续分页（“查看更多回复”）：`PolarisPostCommentsChildrenPaginationtQuery`，`doc_id=27229753410037873`

首次子级评论请求的变量只有父评论定位所需的字段：

```json
{
  "media_id": "3970475254647536658",
  "parent_comment_id": "18118670534314629"
}
```

前端脚本中的字段名显示，子级评论接口对应：

```text
xdt_api__v1__media__media_id__comments__parent_comment_id__child_comments__connection
```

## 复现与限制

已使用与页面相同的 GraphQL `doc_id`、媒体 ID、父评论 ID 和 Relay 登录状态变量取得 HTTP 200 JSON 响应，并保存两条父评论的完整子级报文。当前 Chrome 控制接口未开放 DevTools Network 事件，因此本记录是对页面实际 GraphQL 请求的精确复现，不包含浏览器 Network 面板中的原始请求头全集或底层事件时间线。

此数据仅用于当前帖子评论结构分析；不应据此绕过登录、权限或 Instagram 风控机制。
