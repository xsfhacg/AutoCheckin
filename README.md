<<<<<<< HEAD
# AutoCheckin
网页自动签到，当前已适配NewAPI
=======
# Auto Checkin

一个可持续运行在服务器上的网页自动签到项目。当前内置 `NewAPI` 轻量 HTTP 适配器，支持配置多个站点、保存 Cookie 登录状态、按固定时间或间隔频率执行签到。

## 功能

- 配置页面：按网页类型分组管理站点。
- NewAPI 适配器：首次运行调用登录接口，后续复用 Cookie 会话。
- 定时调度：支持每天固定时间或按分钟间隔执行。
- 手动运行：配置页可立即触发单个站点签到。
- 运行记录：最近 200 条记录保存在 `data/history.json`。

## 启动

```bash
npm install
npm run dev
```

开发环境：

- 前端：http://localhost:3333
- 服务端：http://localhost:8787

生产环境：

```bash
npm run build
npm start
```

## Linux 环境运行

推荐使用 Node.js 20 LTS 或更新版本。以下示例假设项目放在 `/opt/auto-checkin`，服务端口使用默认 `8787`。

```bash
cd /opt/auto-checkin
npm ci
npm run build
PORT=8787 npm start
```

启动后访问：

- 页面：http://服务器IP:8787
- API：http://服务器IP:8787/api/config

如果服务器开启了防火墙，需要放行端口：

```bash
sudo ufw allow 8787/tcp
```

需要长期后台运行时，建议使用 `systemd`。创建 `/etc/systemd/system/auto-checkin.service`：

```ini
[Unit]
Description=Auto Checkin
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/auto-checkin
Environment=PORT=8787
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

然后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now auto-checkin
sudo systemctl status auto-checkin
```

查看运行日志：

```bash
journalctl -u auto-checkin -f
```

也可以使用 `pm2` 长期后台运行：

```bash
cd /opt/auto-checkin
npm ci
npm run build
npm install -g pm2
PORT=8787 pm2 start npm --name auto-checkin -- start
pm2 save
```

配置开机自启：

```bash
pm2 startup
```

`pm2 startup` 会输出一条需要 `sudo` 执行的命令，复制执行后再运行一次：

```bash
pm2 save
```

PM2 常用命令：

```bash
pm2 status
pm2 logs auto-checkin
pm2 restart auto-checkin
pm2 stop auto-checkin
```

## Docker 部署

项目已提供 `Dockerfile` 和 `docker-compose.yml`。Docker 镜像默认使用 Node.js `22.22.2`：

```dockerfile
ARG NODE_VERSION=22.22.2
FROM node:${NODE_VERSION}-alpine
```

使用 Docker Compose 启动：

```bash
docker compose up -d --build
```

启动后访问：

- 页面：http://服务器IP:8787
- API：http://服务器IP:8787/api/config

Docker 使用生产部署方式，不会再单独启动 Vite 前端开发端口。后端服务会托管 `dist` 前端文件，所以 `8787` 同时是页面地址和 API 地址，接口统一走 `/api/*`。

数据会通过挂载目录持久化到宿主机：

```yaml
volumes:
  - ./data:/app/data
```

常用命令：

```bash
docker compose ps
docker compose logs -f
docker compose restart
docker compose down
```

如果需要临时切换 Node.js 版本，可以构建时覆盖参数：

```bash
docker compose build --build-arg NODE_VERSION=22.22.2
docker compose up -d
```

## 数据位置

- 配置：`data/config.json`
- 运行记录：`data/history.json`
- 登录会话 Cookie：`data/sessions/*.json`

`data/config.json` 默认写入了你提供的 Helpcoder 测试数据，便于直接验证。生产使用时建议把服务器目录权限收紧，或者改造成环境变量/密钥管理方案，因为当前密码是本地明文配置。

## 轻量方案说明

默认不会启动无头浏览器。NewAPI 站点只需要配置主域名，程序会自动使用固定接口路径完成登录和签到：

- 登录接口默认：`/api/user/login`
- 签到接口默认：`/api/user/check_in`
- 会话保持：保存服务端返回的 `Set-Cookie`

如果某个站点开启验证码、二次验证或接口路径不同，可以在配置页面修改接口路径。遇到必须执行页面脚本的站点，再单独增加浏览器型适配器。

## 扩展适配器

新增网站类型时：

1. 在 `server/adapters/` 新增适配器文件。
2. 在 `server/adapters/index.js` 注册。
3. 在 `data/config.json` 的 `adapters` 中增加分类。

适配器只需要实现类似 `runNewApiCheckin(site, runtime)` 的函数并返回运行结果。
>>>>>>> ed95389 (first commit)
