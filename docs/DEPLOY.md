# 部署和内网穿透

魔丸需要 Node 后端保存会话状态，所以不能只放到 GitHub Pages。GitHub Pages 只能托管静态文件，不能运行 `server.js`。

默认 SQLite 数据库路径是 `data/mowan.sqlite`。Docker 部署时数据库会放到 Docker volume 的 `/data/mowan.sqlite`，容器重启不会丢。

## 本地运行

```powershell
pnpm install
.\scripts\start-local.ps1 -AdminUsername "admin" -AdminPassword "换成你的后台密码"
```

打开：

- 访客页：http://127.0.0.1:5173/
- 后台页：http://127.0.0.1:5173/admin.html
- 健康检查：http://127.0.0.1:5173/healthz

## VPS 部署

服务器需要安装 Docker 和 Docker Compose。建议先把域名解析到 VPS 公网 IP，并开放 80/443 端口。

在服务器上创建 `.env`。推荐先用脚本生成：

```bash
pnpm create:env -- --domain mowan.example.com
```

也可以从生产模板复制：

```bash
cp .env.production.example .env
```

`.env` 至少要包含：

```env
DOMAIN=mowan.example.com
ADMIN_USERS=admin:change-this-admin-password,friend:change-this-friend-password
COOKIE_SECRET=change-this-cookie-secret
SESSION_RETENTION_DAYS=7
```

`COOKIE_SECRET` 用来给后台登录 cookie 加签。正式部署时必须固定下来，不要每次启动都换，否则已有后台登录会失效。

如需让魔丸默认用 LLM 回复，在 `.env` 里额外配置 OpenRouter：

```env
OPENROUTER_API_KEY=sk-or-v1-your-openrouter-key
LLM_MODEL=deepseek/deepseek-v3.2
LLM_TEMPERATURE=0.7
LLM_MAX_TOKENS=900
LLM_RETRY_COUNT=2
OPENROUTER_HTTP_REFERER=https://mowan.example.com
OPENROUTER_APP_TITLE=Mowan
```

设置 `LLM_ENABLED=false` 可临时恢复纯人工模式。自动回复请求会关闭 reasoning effort，并过滤 `<think>` 内容；后台人工回复、停止生成和摊牌都会打断正在进行的 LLM 请求。后台也可以对单个会话开启“下条人工接管”，让下一次访客回复跳过 LLM，等待人工发出。

然后启动：

```bash
docker compose up -d --build
docker compose ps
```

Caddy 会自动申请 HTTPS 证书。后台地址是在同一个域名后加 `/admin.html`。

## 部署验收

在 VPS 上可以直接跑完整验收：

```bash
sh scripts/verify-deploy.sh
```

脚本会自动执行：

- `docker compose up -d --build`
- 等待 `/healthz`
- 访客发消息
- 管理员登录并回复
- 重启 app 容器后确认会话和回复还在
- 创建 SQLite 备份
- 写入一条备份后的临时会话
- 恢复备份并确认临时会话消失、原会话仍在

如果域名还没解析好，可以显式指定访问地址：

```bash
VERIFY_BASE_URL=http://127.0.0.1 sh scripts/verify-deploy.sh
```

## 数据保留

默认配置：

```powershell
$env:DATABASE_URL="file:data/mowan.sqlite"
$env:SESSION_RETENTION_DAYS="7"
```

服务启动时会加载 SQLite 中未过期的会话，并清理超过保留天数的会话和消息。

## 管理员账号

单管理员可以用：

```powershell
$env:ADMIN_USERNAME="admin"
$env:ADMIN_PASSWORD="换成你的后台密码"
```

多管理员可以用：

```powershell
$env:ADMIN_USERS="admin:换成你的后台密码,friend:换成朋友的后台密码"
```

`ADMIN_USERS` 会在服务启动时创建或更新这些账号。后台回复、摊牌和登录退出都会写入操作日志，便于多人同时操作时追溯。

## 备份和恢复

Docker 部署后可以从项目目录执行：

```bash
sh scripts/backup-sqlite.sh
```

Windows PowerShell 也可以用：

```powershell
.\scripts\backup-sqlite.ps1
```

备份文件会保存到 `backups/`。恢复时传入备份文件路径：

```bash
sh scripts/restore-sqlite.sh ./backups/mowan-20260524-120000.sqlite
```

Windows PowerShell：

```powershell
.\scripts\restore-sqlite.ps1 -BackupPath .\backups\mowan-20260524-120000.sqlite
```

恢复脚本会临时停止 app 容器，复制数据库，再启动 app 容器。

## cpolar 内网穿透

先确保本地服务已经运行，然后启动隧道：

```powershell
.\scripts\start-cpolar.ps1 -AuthToken "你的 cpolar authtoken"
```

终端里显示的 `https://...` 地址就是公网访客地址。后台地址是在同一个域名后加 `/admin.html`。

## 上传 GitHub 前检查

- 不要提交 `.env`
- 不要提交 `cpolar.yml`
- 不要提交 cpolar 的 authtoken
- 不要把真实后台账号或密码写进 README、脚本或提交记录
- 如果开公网，先设置强后台账号和密码
