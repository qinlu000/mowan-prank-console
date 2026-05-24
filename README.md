# 魔丸整蛊控制台

一个本地运行的“假 LLM 聊天网站”。访客看到类似 AI 助手的聊天界面，后台操作者可以实时查看会话并手动扮演“魔丸”回复。

> 当前项目用于本地原型、短期演示和私密整蛊。会话数据默认保存在本地 SQLite 文件里。

## 功能

- 仿 ChatGPT 风格的访客聊天页
- 后台会话列表和手动回复控制台
- 后台登录保护，支持 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 和 `ADMIN_USERS` 多管理员配置
- 访客发送后显示“正在思考”
- 后台回复在访客端流式输出
- 访客端和后台端通过 SSE 事件流实时更新，断线后低频刷新兜底
- 支持停止生成和重新生成
- 后台快捷回复模板
- “摊牌”按钮
- cpolar 内网穿透辅助脚本
- Fastify 后端和 `/healthz` 健康检查
- SQLite 持久化，会话默认保留 7 天

## 开发环境

- Node.js 22 或更高版本
- pnpm 11.2.2
- 推荐使用 Volta 固定 Node 和 pnpm 版本
- Windows PowerShell，用于本仓库自带脚本

## 快速开始

首次使用先安装 Volta，然后安装本项目固定的 Node 和 pnpm 版本：

```powershell
winget install --id Volta.Volta -e
volta install node@22.19.0 pnpm@11.2.2
```

然后安装依赖并启动：

```powershell
pnpm install
.\scripts\start-local.ps1 -AdminUsername "admin" -AdminPassword "换成你的后台密码"
```

打开：

- 访客页：http://127.0.0.1:5173/
- 后台页：http://127.0.0.1:5173/admin.html
- 健康检查：http://127.0.0.1:5173/healthz

也可以手动设置环境变量：

```powershell
$env:ADMIN_USERNAME="admin"
$env:ADMIN_PASSWORD="换成你的后台密码"
pnpm start
```

如果要一次配置多个管理员，可以设置：

```powershell
$env:ADMIN_USERS="admin:换成你的后台密码,friend:换成朋友的后台密码"
pnpm start
```

`ADMIN_USERS` 会在服务启动时创建或更新这些管理员账号。没有设置 `ADMIN_PASSWORD` 或 `ADMIN_USERS` 时，服务启动会在终端生成一个临时后台账号和密码。聊天数据默认保存到 `data/mowan.sqlite`，`data/` 不会提交到 Git。

## 常用命令

```powershell
pnpm run doctor
pnpm run check
pnpm run dev
```

## 数据保存

- `DATABASE_URL` 默认是 `file:data/mowan.sqlite`
- `SESSION_RETENTION_DAYS` 默认是 `7`
- 服务启动时会加载未过期会话
- 服务启动后会定时清理过期会话和消息
- 管理员登录会话、回复记录和摊牌操作会写入 SQLite，后台可查看最近操作日志

## Docker 部署

复制 `.env.production.example` 为 `.env`，至少设置 `DOMAIN`、`ADMIN_USERS` 和 `COOKIE_SECRET`，然后在 VPS 上运行：

```bash
docker compose up -d --build
```

Caddy 会自动申请 HTTPS 证书。SQLite 数据保存在 Docker volume 中，可以用 `scripts/backup-sqlite.sh` / `scripts/restore-sqlite.sh`，或 PowerShell 版本的 `.ps1` 脚本备份恢复。

部署后可以在 VPS 上运行：

```bash
sh scripts/verify-deploy.sh
```

它会验证健康检查、访客到后台回复、容器重启持久化，以及 SQLite 备份恢复。

上线时按 [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md) 走一遍，避免漏掉域名、端口、备份恢复这些关键点。

## 内网穿透

本仓库提供 cpolar 辅助脚本，默认使用中国节点：

```powershell
.\scripts\start-cpolar.ps1 -AuthToken "你的 cpolar authtoken"
```

终端里显示的 `https://...` 地址就是访客公网地址。后台地址是在同一个域名后加 `/admin.html`。

更多说明见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## GitHub Pages

这个项目不能只部署到 GitHub Pages，因为核心功能需要 `server.js` 运行后端 API。GitHub Pages 只能托管静态 HTML/CSS/JS。

如果要长期远程部署，建议使用能运行 Node.js 的服务，例如云服务器、Render、Railway、Fly.io、Zeabur 或香港轻量服务器。

## 项目结构

```text
.
├── public/              # 前端页面和静态资源
├── scripts/             # 本地启动和 cpolar 辅助脚本
├── docs/                # 部署说明
├── Dockerfile
├── docker-compose.yml
├── Caddyfile
├── server.js            # Node/Fastify 后端和 SQLite 会话状态
├── package.json
└── .env.example
```

## 安全提醒

- 不要提交 `.env`
- 不要提交 cpolar authtoken
- 不要把真实后台账号或密码写进 README、脚本或提交记录
- 开公网前务必设置强后台账号和密码
- 不要把 `/admin.html` 和后台账号密码发给访客
