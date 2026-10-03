# 部署与后台使用

本项目现在是「**静态前台 + 后台管理**」架构：前台是纯静态构建产物，后台是一个小型 Node 服务，负责登录鉴权、编辑 Markdown 内容，并在发布时触发一次前台构建、原子切换到线上。

```
互联网 → nginx (80/443)
           ├─ 所有前台页面 → 静态目录 current/（构建产物，原子切换）
           └─ /admin、/api、/admin-assets → 反代到管理服务（Node，端口 4000）
                                            ├─ 登录鉴权（session）
                                            ├─ 写 src/content/*.md
                                            ├─ 上传图片 → public/uploads/
                                            └─ 触发构建 → astro build → 原子发布
```

- 内容仍以 Markdown 存放在 `src/content/`，前台的短代码、搜索、RSS、sitemap 全部照旧工作。
- 管理员保存内容**只写文件**，不会立刻上线；到「构建发布」点一下才会重新构建前台。
- 构建失败不影响线上（原子切换，旧版本继续服务）。

---

## 一、目录说明

| 路径 | 作用 |
| --- | --- |
| `admin/` | 后台管理服务（Express） |
| `scripts/` | `hash-password.mjs`（改密）、`deploy.mjs`（命令行构建发布） |
| `src/content/` | 文章与随笔（Markdown），后台读写这里 |
| `public/uploads/` | 后台上传的图片 |
| `releases/<时间戳>/` | 每次发布的静态快照 |
| `current` | 指向当前发布版本的软链接，nginx 服务它 |
| `dist/` | `astro build` 的临时输出，发布后会被移入 `releases/` |

---

## 二、本地开发

```bash
npm install

# 前台：博客本地预览（改内容会热更新）
npm run dev          # http://localhost:4321

# 后台：管理服务（另开一个终端）
npm run admin        # http://localhost:4000/admin
```

本地开发时，后台保存内容后，`npm run dev` 会自动热更新，可直接在前台看到效果。若要看最终静态产物：`npm run build && npm run preview`。

登录账号密码见 `.env` 的 `ADMIN_USER` / `ADMIN_PASSWORD_HASH`。

---

## 三、日常写作流程

1. 登录后台 `/admin`。
2. 「文章」→「新建文章」，填写标题、路径、分类标签、正文（Markdown，支持预览）。
3. 点「保存」——只写入文件。可勾选「存为草稿」，草稿不会出现在前台。
4. 满意后到「构建发布」→「构建并发布」，等待十几秒，前台即更新。
5. 若发布后发现问题，在「构建发布」点「回滚上一版」。

> 说明：正文里可直接用博客原有的 `{% %}` 短代码，后台预览会尽量还原；最终效果以构建结果为准。

> **内容与媒体不进 git 仓库**：`src/content/`（文章与随笔）和 `public/uploads/`（上传图片）属于个人数据，已被 `.gitignore` 排除，不会提交到公开仓库。这些数据的备份已经自动化——每次「构建发布」成功后自动推送到你的 GitHub 私有仓库，详见「八、数据备份与恢复」。

---

## 四、服务器部署

前置：一台 Linux 服务器，已安装 **Node.js ≥ 20**、**git**、**nginx**。

### 1. 拉取项目并配置

```bash
sudo mkdir -p /var/www && cd /var/www
sudo git clone <你的仓库地址> blog
cd blog
npm install

# 配置环境变量（含后台账号、密钥）
cp .env.example .env
nano .env       # 设置 ADMIN_USER / ADMIN_PASSWORD_HASH / SESSION_SECRET / SITE_URL 等
```

设置/修改管理员密码：

```bash
npm run admin:hash -- "你的新密码"
# 把输出的 ADMIN_PASSWORD_HASH=... 覆盖写入 .env
```

在 `.env` 里把 `COOKIE_SECURE=true`（部署在 HTTPS 后面时），`SITE_URL` 改成正式域名。

### 2. 首次构建发布

```bash
npm run deploy      # 构建前台并原子发布到 current/
```

执行后会生成 `releases/<时间戳>/` 并把 `current` 指向它。

### 3. 配置 nginx

`/etc/nginx/sites-available/blog`：

```nginx
server {
    listen 80;
    server_name your-domain.com;   # 换成你的域名

    # 前台静态站点
    root /var/www/blog/current;
    index index.html;

    location / {
        try_files $uri $uri/ $uri/index.html =404;
    }

    # 后台与接口反代到管理服务
    location /admin {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /admin-assets {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 20m;   # 允许上传图片
    }
}
```

> **安全响应头**：后台服务自带基础安全头（`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`、`HSTS`（`COOKIE_SECURE=true` 时）、CSP report-only），nginx 无需重复配置——即使跳过 nginx 直连 4000 端口也有基本防护。前台静态文件可按需在 nginx 补充缓存与压缩策略。
>
> **会话存储**：后台会话使用 express-session 默认的内存存储（MemoryStore）——服务重启后所有登录态失效（单管理员场景可接受）；如需重启不掉线可自行接入持久化 store（如 `connect-sqlite3`）。会话 cookie 为 `httpOnly + SameSite=Strict`，有效期 7 天。

启用并配置 HTTPS（推荐 certbot）：

```bash
sudo ln -s /etc/nginx/sites-available/blog /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.com   # 自动签发并强制 https
```

### 4. 用 systemd 守护管理服务

`/etc/systemd/system/blog-admin.service`：

```ini
[Unit]
Description=Blog admin backend
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/blog
ExecStart=/usr/bin/node admin/server.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo chown -R www-data:www-data /var/www/blog   # 让服务有写入内容与构建的权限
sudo systemctl daemon-reload
sudo systemctl enable --now blog-admin
sudo systemctl status blog-admin
```

> 若构建/写文件报权限错误，确认运行服务的用户对 `/var/www/blog`（尤其 `src/content/`、`public/uploads/`、`releases/`、`dist/`）有写权限。

---

## 五、安全建议

- **后台是最高权限入口**（能触发构建），务必：启用 HTTPS、设强密码、只开 80/443 端口。
- 修改默认密码：`npm run admin:hash -- "新密码"`，更新 `.env` 后 `sudo systemctl restart blog-admin`。
- `.env` 已被 `.gitignore` 忽略，不要提交到仓库。
- 登录接口内置了失败限流（连续错误会临时锁定），可抵御简单暴力破解。
- 如需更严格，可在防火墙限制 4000 端口仅本机访问（nginx 反代即可，外部无需直连 4000）。

---

## 六、构建与发布机制

- 「构建并发布」执行 `astro build`，成功后把 `dist/` 移入 `releases/<时间戳>/`，并把 `current` 软链接原子地指向它。
- nginx 始终服务 `current/`，所以构建过程中线上不受影响；构建失败则 `current` 保持原样。
- 默认保留最近 **5** 个发布版本，旧的自动清理，便于回滚。
- 「回滚上一版」把 `current` 指回上一个版本。

也可以用命令行手动发布（例如配合 cron 或 webhook）：

```bash
npm run deploy
```

- 每次「构建发布」成功后，后台会自动把个人数据备份到 GitHub 私有仓库（见「八、数据备份与恢复」）；备份或推送失败不影响发布结果。

---

## 七、常见问题

**后台保存了，前台没变化？**
保存只写文件，需要到「构建发布」点「构建并发布」才会上线。

**构建失败怎么办？**
线上保持原版本不受影响。看「构建发布」里的构建日志定位问题（通常是 frontmatter 或 Markdown 语法），改好后再构建。

**忘记管理员密码？**
在服务器上 `npm run admin:hash -- "新密码"`，把输出写入 `.env` 的 `ADMIN_PASSWORD_HASH`，重启 `blog-admin` 服务。

**图片传哪里了？**
`public/uploads/`，构建后可通过 `/uploads/文件名` 访问，可直接插入正文或用作封面。

---

## 八、数据备份与恢复

公开仓库只保存源码；文章、媒体、动态数据等个人数据全部在 `.gitignore` 里。为了不丢数据，后台在**每次「构建发布」成功后自动做一次备份**。

### 备份了什么

| 备份内容 | 说明 |
| --- | --- |
| `src/content/` | 文章与随笔（Markdown） |
| `public/uploads/` | 后台上传的媒体 |
| `data/` | 动态数据（评论/友链/歌单/公告/统计/项目/导航/页面文案） |
| `profile.jpg` | 个人头像 |
| `.env` | 站点配置与后台凭据（含密码哈希；可用 `BACKUP_INCLUDE_ENV=false` 关闭） |

构建产物（`dist/`、`releases/`）不在备份范围——源码 + 上表数据即可随时完整重建。

### 备份到哪

- **本地**：不保留。备份在系统临时目录里建临时 git 仓库完成（拉取远端历史衔接 → 复制数据 → 提交 → 推送），推送完整个删除，本地不留任何备份缓存。
- **远端**：GitHub 私有仓库。地址在后台**「构建发布 → 数据备份」**卡片里直接填写保存（存 `data/backup-config.json`，随数据一起备份）；留空时依次回落 `.env` 的 `BACKUP_REMOTE_URL`、自动推导（`<owner>/<repo>-backup`）。改完地址下一次发布自动改推新仓库，旧仓库里的历史提交不受影响。

每次发布一个提交，远端历史完整可回溯；已删除的文章/媒体也会同步从备份中移除（纯镜像）。

**首次启用（只需一次）**：在 GitHub 上创建一个**私有空仓库**，名称与远端地址一致（如 `your-blog-backup`）。之后的推送全自动；在此之前推送会失败并记录在构建日志里，建好库后无需任何操作，下一次「构建发布」或 `npm run backup` 会自动重试。

### 手动备份

```bash
npm run backup
```

### 相关配置（.env）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BACKUP_ENABLED` | `true` | 设为 `false` 关闭自动备份 |
| `BACKUP_REMOTE_URL` | 自动推导 | 后台「构建发布」页未填写仓库地址时的回落配置；整体未配置时跳过备份 |
| `BACKUP_INCLUDE_ENV` | `true` | 是否连 `.env` 一起备份 |

> 推送失败（网络断、仓库未建、凭据过期）不影响发布结果：该次备份作废（临时目录已清理，数据源在项目内不会丢失），下次发布或手动 `npm run backup` 时自动全量重试。具体原因会写进构建日志。

### 恢复步骤

1. `git clone` 公开源码仓库，`npm install`
2. `git clone` 私有备份仓库，把 `src/content`、`public/uploads`、`data`、`profile.jpg`、`.env` 拷贝到项目对应位置
3. `npm run deploy` 重新构建发布
