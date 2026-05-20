# AstraChat Prank Console

一个本地运行的“假 LLM 聊天网站”。访客看到类似 AI 助手的聊天界面，后台操作者可以实时查看会话并手动回复。

> 当前项目只用于本地原型和短期演示。会话数据保存在内存里，服务重启后会清空。

## 功能

- 仿 ChatGPT 风格的访客聊天页
- 后台会话列表和手动回复控制台
- 后台登录保护，密码通过 `ADMIN_PASSWORD` 设置
- 访客发送后显示“正在思考”
- 后台回复在访客端流式输出
- 支持停止生成和重新生成
- 后台快捷回复模板
- “摊牌”按钮
- cpolar 内网穿透辅助脚本

## 要求

- Node.js 20 或更高版本
- Windows PowerShell，用于本仓库自带脚本

## 快速开始

```powershell
npm install
.\scripts\start-local.ps1 -AdminPassword "换成你的后台密码"
```

打开：

- 访客页：http://127.0.0.1:5173/
- 后台页：http://127.0.0.1:5173/admin.html

也可以手动设置环境变量：

```powershell
$env:ADMIN_PASSWORD="换成你的后台密码"
npm start
```

如果不设置 `ADMIN_PASSWORD`，服务启动时会在终端生成一个临时后台密码。

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
├── server.js            # Node 后端和内存会话状态
├── package.json
└── .env.example
```

## 安全提醒

- 不要提交 `.env`
- 不要提交 cpolar authtoken
- 不要把真实后台密码写进 README、脚本或提交记录
- 开公网前务必设置强后台密码
- 不要把 `/admin.html` 和后台密码发给访客
