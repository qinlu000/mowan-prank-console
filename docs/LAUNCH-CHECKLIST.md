# 魔丸上线清单

这份清单只服务一个目标：把魔丸作为私密、纯人工、多管理员的整蛊工具稳定跑在一台 VPS 上。

## 服务器准备

- 已购买一台能运行 Docker 的 VPS。
- 已把域名 A 记录解析到 VPS 公网 IP。
- 防火墙和云厂商安全组已放行 80/443。
- 已安装 Git、Docker 和 Docker Compose。

## 首次部署

```bash
git clone https://github.com/qinlu000/mowan-prank-console.git
cd mowan-prank-console
corepack enable
corepack prepare pnpm@11.2.2 --activate
pnpm create:env -- --domain 你的域名
```

脚本会生成 `.env`、随机 `COOKIE_SECRET` 和随机后台密码。也可以手动复制模板：

```bash
cp .env.production.example .env
```

手动编辑 `.env` 时，至少替换：

- `DOMAIN`
- `ADMIN_USERS`
- `COOKIE_SECRET`

启动并验收：

```bash
sh scripts/verify-deploy.sh
```

验收通过后，打开：

- 访客入口：`https://你的域名/`
- 后台入口：`https://你的域名/admin.html`

## 日常操作

查看状态：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f --tail=120 app caddy
```

更新代码：

```bash
git pull
docker compose up -d --build
sh scripts/verify-deploy.sh
```

备份 SQLite：

```bash
sh scripts/backup-sqlite.sh
```

恢复 SQLite：

```bash
sh scripts/restore-sqlite.sh ./backups/mowan-YYYYMMDD-HHMMSS.sqlite
```

## 完成判定

- `sh scripts/verify-deploy.sh` 通过。
- `https://你的域名/healthz` 返回 `{ "ok": true }`。
- 访客页能发消息。
- 后台能登录并回复。
- 重启 app 容器后旧会话还在。
- 备份恢复脚本能让备份后的临时会话消失，备份前会话保留。
