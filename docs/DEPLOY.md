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

在服务器上创建 `.env`：

```env
DOMAIN=mowan.example.com
ADMIN_USERS=admin:change-this-admin-password,friend:change-this-friend-password
COOKIE_SECRET=change-this-cookie-secret
SESSION_RETENTION_DAYS=7
```

然后启动：

```bash
docker compose up -d --build
docker compose ps
```

Caddy 会自动申请 HTTPS 证书。后台地址是在同一个域名后加 `/admin.html`。

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

```powershell
.\scripts\backup-sqlite.ps1
```

备份文件会保存到 `backups/`。恢复时传入备份文件路径：

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
