# L1angK1NG_Website

个人全栈博客：**静态前台 + 后台管理**。前台是纯静态构建产物，后台是一个小型 Node 管理服务，负责登录鉴权、在线编辑 Markdown，并在发布时触发一次前台构建、原子切换上线。

## 更新日志

> 每次修复报告的问题后，会自动在此追加记录。

### 2026-09-29

- **修复**：后台保存含引号等特殊字符的路径时报 `ENOENT` —— 保存时路径自动净化（Windows 非法字符、空格等替换为连字符，中文与点号不受影响）
- **修复**：删除内容后重新发布，被删内容仍出现在前台 —— 新增内容构建清单（`.content-build-manifest.json`），发布前检测到删除才重建缓存，删除可靠生效，且日常发布不再破坏 `npm run dev` 预览
- **修复**：本地看不到发布结果 —— 后台新增「查看发布结果」（构建产物直接挂在后台服务根路径，与线上效果一致）
- **清理**：移除原作者遗留静态资源（分享图 `share/og-default.jpg`、模板品牌兜底封面 → 替换为本站品牌版），清理重复上传文件；LICENSE 更新为 L1angK1NG + laogou717 双署名

### 2026-09-28

- **全栈改造**：新增后台管理系统（登录鉴权、文章/随笔管理、Markdown 编辑与实时预览、媒体上传、构建发布与版本回滚、草稿支持）
- 项目更名为 **L1angK1NG_Website**，清除原作者遗留博客内容，作者名改为 L1angK1NG

> **基于原作者项目开发**：本项目在 [laogou717/clay-blog](https://github.com/laogou717/clay-blog)（MIT 协议）的基础上改造而成——保留其 Astro 静态博客的全部前台能力（文章、随笔、归档、分类、标签、搜索、RSS、sitemap、Twikoo 评论、音乐播放器），新增后台管理端与「构建即发布」的全栈能力。感谢原作者的开源工作。

---

## 架构

```
互联网 → nginx (80/443)
           ├─ 所有前台页面 → 静态目录 current/（构建产物，原子切换）
           └─ /admin、/api、/admin-assets → 反代到管理服务（Node，端口 4000）
                                            ├─ 登录鉴权（session + CSRF）
                                            ├─ 写 src/content/*.md
                                            ├─ 上传图片 → public/uploads/
                                            └─ 触发构建 → astro build → 原子发布
```

- 内容仍以 Markdown 存放在 `src/content/`，前台的短代码、搜索、RSS、sitemap 全部照旧工作。
- 后台保存内容**只写文件**，不立即上线；到「构建发布」点一下才重新构建前台。
- 构建采用**原子切换**，构建失败不影响线上（旧版本继续服务）。

---

## 功能

**前台**
- 首页（精选 + 最新）、文章详情（目录侧栏、上一篇/下一篇、相关推荐、阅读时长）
- 归档（按年分组）、分类页、标签页、随笔时间线、客户端全文搜索
- SEO：RSS、sitemap、robots.txt、canonical、Open Graph、JSON-LD 结构化数据
- 明暗主题切换、路由过渡动画、选中文字引用评论、网易云音乐播放器
- 遗留短代码（`{% %}`）兼容、图片属性注入

**后台（/admin）**
- 单管理员登录：scrypt 密码哈希 + session + CSRF 校验 + 登录失败限流
- 文章 / 随笔管理：列表、新建、编辑、删除、改路径（slug）
- Markdown 编辑器：写作 / 实时预览（预览复用前台短代码逻辑）
- frontmatter 表单化编辑，保存时保留未暴露字段（如 `ai`、`main_color`）
- 媒体库：图片上传到 `public/uploads/`，可插入正文 / 用作封面
- 构建发布：一键构建、构建日志、历史版本、**回滚上一版**
- 草稿支持：勾选「存为草稿」的内容不进前台

---

## 技术栈

| 部分 | 技术 |
| --- | --- |
| 前台 | Astro 7 + TypeScript（strict），零 UI 框架、零 CSS 框架 |
| 内容 | Markdown + YAML frontmatter，Astro Content Collections（Zod 校验） |
| 后台 | Node + Express + express-session，服务端渲染 HTML + 原生 JS |
| 鉴权 | Node crypto scrypt 密码哈希，session cookie（HttpOnly / SameSite=Strict） |
| 构建发布 | `astro build` → 原子切换软链接，构建锁防并发 |

---

## 快速开始

**环境要求：Node.js ≥ 20。** Astro 与后台依赖都在 `package.json` 里，`npm install` 自动装好。

```bash
# 1. 安装依赖
npm install

# 2. 前台：博客本地预览（改内容热更新）
npm run dev          # http://localhost:4321

# 3. 后台：管理服务（另开一个终端）
npm run admin        # http://localhost:4000/admin
```

本地开发时，后台保存内容后 `npm run dev` 自动热更新，可直接在前台看到效果。若要看最终静态产物：`npm run build && npm run preview`。

> 内容目录（`src/content/`）已清空，直接在后台（`/admin`）新建自己的文章与随笔即可。

---

## 后台使用

1. 登录后台 `/admin`。默认账号见 `.env` 的 `ADMIN_USER` / `ADMIN_PASSWORD_HASH`。
2. 「文章」→「新建文章」，填写标题、路径、分类标签、正文（Markdown，支持预览）。
3. 点「保存」——只写入文件。可勾选「存为草稿」，草稿不出现在前台。
4. 到「构建发布」→「构建并发布」，等待十几秒，前台即更新。
5. 若发布后发现问题，点「回滚上一版」。

> 本地有两种预览，别混淆：`npm run dev`（:4321）实时反映**保存的内容**，适合写作时预览；后台导航的「查看发布结果」打开的是**构建产物**（后台服务的根路径），与部署到服务器后的效果完全一致。删除内容后发布时，后台会自动重建构建缓存，此时若 dev 预览异常，重启一次 `npm run dev` 即可。

**修改管理员密码**

```bash
npm run admin:hash -- "你的新密码"
# 把输出的 ADMIN_PASSWORD_HASH=... 覆盖写入 .env，然后重启后台服务
```

---

## 内容与字段

- 文章：`src/content/posts/`
- 随笔：`src/content/notes/`
- 字段定义：`src/content.config.ts`

**文章 frontmatter**：`title`（必填）、`description`、`date`、`updated`、`cover`、`categories`、`tags`、`keywords`、`ai`、`sticky`（数字，越大越靠前）、`main_color`、`author`、`draft`（草稿）。

**随笔 frontmatter**：`date`（必填）、`title`、`mood`、`tags`、`draft`。

路径即 URL：`src/content/posts/技术/deploy-static.md` → `/posts/技术/deploy-static/`。后台「路径 / slug」可自定义，中文也可以；改路径会自动迁移文件。

---

## 项目结构

```
L1angK1NG_Website/
├── admin/                     # 后台管理服务
│   ├── server.mjs             # Express 入口（路由、鉴权、接口）
│   ├── views.mjs              # 页面模板
│   ├── lib/                   # auth / content / build / preview / env
│   └── public/                # 后台样式与脚本
├── scripts/
│   ├── deploy.mjs             # 命令行构建发布（配合 cron / webhook）
│   └── hash-password.mjs      # 生成管理员密码哈希
├── public/                    # 静态资源（头像、封面、上传）
├── src/
│   ├── components/            # 组件（导航、播放器、评论等）
│   ├── content/               # 文章与随笔（Markdown）
│   ├── data/                  # site.config.json、github-projects.json
│   ├── layouts/               # 页面布局
│   ├── lib/                   # 工具函数与 Markdown 插件
│   ├── pages/                 # 路由页面
│   └── styles/                # 全局样式
├── DEPLOY.md                  # 服务器部署指南（nginx / systemd / 安全）
├── astro.config.mjs
└── package.json
```

---

## 环境变量

复制 `.env.example` 为 `.env`，按需填写（`.env` 已被忽略，请勿提交）：

```bash
SITE_URL=https://example.com          # 正式域名，用于 RSS / sitemap / canonical

# 后台管理端
ADMIN_USER=你的用户名
ADMIN_PASSWORD_HASH=用 npm run admin:hash 生成
SESSION_SECRET=一串随机长字符串
ADMIN_PORT=4000
COOKIE_SECURE=true                    # 部署在 HTTPS 后面时设 true

# 前台功能
PUBLIC_TWIKOO_ENV_ID=                 # Twikoo 后端，留空则隐藏评论
PUBLIC_NETEASE_PLAYLIST_ID=8792942606 # 网易云歌单 ID
PUBLIC_MUSIC_API=https://meting.mikus.ink/api
```

---

## 构建与发布机制

- 「构建并发布」执行 `astro build`，成功后把 `dist/` 移入 `releases/<时间戳>/`，并把 `current` 软链接**原子**指向它。
- nginx 始终服务 `current/`，构建过程线上不受影响；构建失败则 `current` 保持原样。
- 默认保留最近 **5** 个发布版本，旧的自动清理，便于回滚。
- 也可用命令行发布（适合 cron / webhook）：`npm run deploy`。

**部署到服务器**（Node ≥ 20 + nginx）详见 [DEPLOY.md](DEPLOY.md)，含可直接复制的 nginx、systemd 配置与安全建议。

---

## 部署到你的博客

克隆后需要改的地方，集中在少数几个文件：

| 要改的内容 | 位置 |
| --- | --- |
| 站点名称 / 简介 / 作者 | `src/data/site.config.json` 的 `siteName` / `siteDescription` / `siteAuthor` |
| 头像 | 替换 `public/avatars/avatar.png` 与 `avatar-bw.png` |
| GitHub 用户名与仓库链接 | `src/data/site.config.json` 的 `githubUser` / `githubRepo`（导航「GitHub」按钮与关于页「开源项目」；不想要按钮就留空 `githubRepo`） |
| 正式域名 | `.env` 的 `SITE_URL` |
| 管理员账号 | `.env` 的 `ADMIN_USER` / `ADMIN_PASSWORD_HASH`（改密见上文） |
| 评论后端 | `.env` 的 `PUBLIC_TWIKOO_ENV_ID` |
| 音乐播放器歌单 | `.env` 的 `PUBLIC_NETEASE_PLAYLIST_ID` |
| 文章与随笔 | 后台直接增删改，或编辑 `src/content/` 下的 Markdown |

> 提示：`site.config.json` 的 `githubUser` / `githubRepo` 当前为空，导航「GitHub」按钮与关于页「开源项目」暂不显示。填入你自己的 GitHub 用户名 / 仓库地址即可启用。

### 关于页自定义配置

关于页的「开源项目」与「资源下载」通过 `src/data/site.config.json` 配置：

- **开源项目**：构建时按 `githubUser` 从 GitHub API 拉取该账号的公开仓库（自动排除 fork、按 Star 排序），可用 `projectOverrides` 按仓库名覆盖图标 / 相关文章链接；API 不可达时回退到 `src/data/github-projects.json` 缓存，可用下面命令手动刷新：

  ```bash
  curl -s "https://api.github.com/users/<你的用户名>/repos?per_page=100" -o src/data/github-projects.json
  ```

- **资源下载 / 自定义项目组**：用 `projectGroups` 直接增删条目或整组，字段见 `src/data/site.config.json` 里的示例。

---

## 评论

评论前端未使用 Twikoo 默认 UI，而是通过 `src/lib/comments.js` 调用 Twikoo 后端接口并渲染自定义样式。配置 `.env` 的 `PUBLIC_TWIKOO_ENV_ID` 后即可启用；未配置时评论区与引用按钮自动隐藏。

文章正文支持**选中文字后引用到评论区**：拖选至少 2 个字符 → 点「引用评论」→ 自动滚动到底部评论框并以 Markdown 引用写入。

---

## 音乐播放器

右下角悬浮播放器按需读取网易云歌单，不自动播放。换歌单时从网易云歌单链接复制 `id` 数字写入 `.env` 的 `PUBLIC_NETEASE_PLAYLIST_ID`。Meting 为非官方接入，受版权 / VIP / 地区限制，个别歌曲可能无法播放；生产环境可将 `PUBLIC_MUSIC_API` 指向自建 Meting 兼容服务。

---

## 常见问题

**后台保存了，前台没变化？**
保存只写文件，需到「构建发布」点「构建并发布」才上线。

**构建失败怎么办？**
线上保持原版本不受影响。看「构建发布」的构建日志定位问题（多为 frontmatter 或 Markdown 语法），改好后再构建。

**忘记管理员密码？**
服务器上 `npm run admin:hash -- "新密码"`，写入 `.env` 后重启后台服务。

**没装过 Node.js？**
到 https://nodejs.org/ 下载 LTS 版本安装，npm 会一并装好，然后从「快速开始」继续。

**`npm install` 很慢 / 失败？**
国内可切镜像源：`npm config set registry https://registry.npmmirror.com`

**端口被占用？**
前台：`npm run dev -- --port 4322`；后台：改 `.env` 的 `ADMIN_PORT`。

---

## 许可证与致谢

本项目基于 [MIT License](LICENSE) 开源。

再次感谢原作者 [laogou717](https://github.com/laogou717) 的 [clay-blog](https://github.com/laogou717/clay-blog) 提供的 Astro 博客模板；本项目在其基础上新增后台管理与全栈发布能力。仓库自带的示例文章与随笔仅用于演示，可直接删除替换。
