# 后台 API 参考

> 后台服务（`admin/server.mjs`）暴露的 HTTP 接口速查。鉴权列说明：
> - **公开**：无需登录，带按 IP 限流（超限返回 429，`/api/public/view` 超限返回 202 静默）。
> - **会话**：需登录（`connect.sid` 会话 cookie），未登录返回 401。
> - **会话+CSRF**：写操作还要求 `X-CSRF-Token` 请求头（或 body 里的 `csrfToken`）与会话中一致。
>
> 所有接口收发均为 JSON（媒体上传为二进制 body，见下）。错误响应统一为 `{ "error": "中文说明" }`。

## 公开接口（/api/public）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/public/twikoo` | Twikoo 协议评论接口：body `{ event, ... }`，事件 `COMMENT_GET`（拉评论树）/ `COMMENT_SUBMIT`（发评论/回复）/ `COMMENT_LIKE`（点赞，按 IP 哈希去重） |
| GET | `/api/public/friends` | 友链列表（仅已审核）+ 申请须知文案 |
| POST | `/api/public/friends/apply` | 提交友链申请（进待审核队列）；同 URL 重复提交视为更新 |
| GET | `/api/public/announcements` | 当前启用且在有效期内的公告 |
| GET | `/api/public/projects` | 项目展示列表 |
| GET | `/api/public/projects/:slug` | 项目详情（含 Markdown 渲染正文） |
| GET | `/api/public/playlist` | 自建歌单曲目（后台「音乐」模块维护） |
| GET | `/api/public/playlist/resolve/:id` | 网易云曲目播放地址重新解析（播放失败后前端调用） |
| GET | `/api/public/playlist/lyric/:id` | 网易云曲目歌词（LRC 文本，`{ lyric }`，无歌词返回空串） |
| POST | `/api/public/view` | 访问统计打点：body `{ path, title }`；失败静默返回 `{ ok: true }` |
| GET | `/api/public/site-info` | 站点信息聚合（profile + 导航 + 公告），前端少发请求 |

## 认证

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/login` | 会话+CSRF | body `{ username, password }`；失败 401（含剩余尝试次数提示），8 次失败锁定 15 分钟 |
| POST | `/api/logout` | 会话+CSRF | 销毁会话并清除 cookie |

## 内容管理（文章 / 随笔）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/list/:collection` | 会话 | 内容列表（`posts` / `notes`） |
| GET | `/api/entry/:collection?path=` | 会话 | 单篇内容（frontmatter + 正文） |
| POST | `/api/save/:collection` | 会话+CSRF | 保存/新建；body `{ id?, originalId?, fields, body }`；slug 自动净化（Windows 非法字符） |
| POST | `/api/delete/:collection` | 会话+CSRF | 删除；body `{ id }` |
| POST | `/api/preview` | 会话+CSRF | Markdown → HTML 预览（前端展示前再过 DOM 白名单净化） |

## 媒体

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/media` | 会话 | 已上传文件列表 |
| POST | `/api/upload?filename=` | 会话+CSRF | 图片上传（原始二进制 body，≤15MB）；扩展名白名单 + 文件头校验，SVG 自动剥离脚本能力；按内容哈希去重复用 |
| POST | `/api/media/delete` | 会话+CSRF | 删除文件；仍被内容引用时返回 409 并列出引用位置 |

## 动态模块管理（/api/manage）

以下写操作均需 **会话+CSRF**，读操作需 **会话**：

| 模块 | 读 | 写 |
| --- | --- | --- |
| 页面内容 | GET `/api/manage/profile` | POST `/api/manage/profile` |
| 网址导航 | GET `/api/manage/nav` | POST `/api/manage/nav` |
| 友链 | GET `/api/manage/friends` | POST `/api/manage/friends/notice`、`/friends/save`、`/friends/review`、`/friends/delete` |
| 项目 | GET `/api/manage/projects` | POST `/api/manage/projects/save`、`/projects/delete` |
| 音乐 | GET `/api/manage/music` | POST `/api/manage/music/upload`、`/music/import-netease`（`input` 为链接/ID，可选 `type: song\|playlist` 显式指定）、`/music/update`、`/music/delete`、`/music/reorder` |
| 公告 | GET `/api/manage/announcements` | POST `/api/manage/announcements/save`、`/announcements/delete` |
| 评论 | GET `/api/manage/comments` | POST `/api/manage/comments/status`、`/comments/delete`、`/comments/reply` |
| 访问统计 | GET `/api/manage/stats` | —（公开打点写入） |

## 构建发布与备份

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/build` | 会话+CSRF | 触发「构建并发布」（`astro build` + 原子切换）；构建中重复调用返回 409 |
| GET | `/api/build/status` | 会话 | 构建状态 / 日志 / 发布版本列表 |
| POST | `/api/build/rollback` | 会话+CSRF | 回滚到上一发布版本 |
| GET | `/api/backup/config` | 会话 | 备份仓库配置（保存值 / 生效值 / 来源） |
| POST | `/api/backup/config` | 会话+CSRF | 保存备份仓库地址（留空回落默认来源） |

## 本地音乐文件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/music/file/:name` | `data/music-files/` 下音频流式输出，支持单段 Range（拖动进度条）；缓存一天 |

## 后台页面

`/admin/login`（登录）、`/admin`（仪表盘）、`/admin/posts`、`/admin/notes`（内容列表）、`/admin/media`、`/admin/build`、`/admin/site-content`、`/admin/projects`、`/admin/nav-links`、`/admin/friends`、`/admin/music`、`/admin/announcements`、`/admin/comments`、`/admin/stats`。
