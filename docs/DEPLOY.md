# 部署和内网穿透

这个项目需要 Node 后端保存会话状态，所以不能只放到 GitHub Pages。GitHub Pages 只能托管静态文件，不能运行 `server.js`。

## 本地运行

```powershell
.\scripts\start-local.ps1 -AdminPassword "换成你的后台密码"
```

打开：

- 访客页：http://127.0.0.1:5173/
- 后台页：http://127.0.0.1:5173/admin.html

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
- 不要把真实后台密码写进 README 或脚本
- 如果开公网，先设置强后台密码
