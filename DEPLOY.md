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

> **内容与媒体不进 git 仓库**：`src/content/`（文章与随笔）和 `public/uploads/`（上传图片）属于个人数据，已被 `.gitignore` 排除，不会提交到 GitHub。因此在换服务器或重新克隆仓库后，这些目录会是空的——需要把旧服务器上的这两个目录拷贝过去，或定期备份：
>
> ```bash
> tar -czf blog-content-$(date +%F).tar.gz src/content public/uploads
> ```

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
