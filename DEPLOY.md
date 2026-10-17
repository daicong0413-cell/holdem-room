# 给部署者：子域名部署说明

这是一个 React 前端 + Node.js HTTP/WebSocket 服务。发布包包含完整源码、锁定依赖、已构建的 `dist/web` 和部署模板，**不包含原作者的 API 密钥、node_modules 或浏览器数据**。

**从 GitHub 克隆源码时**，仓库不包含 `dist/web`。Docker 会自动构建网页，直接按下方 Compose 步骤启动；原生 Node 部署则先执行 `npm ci --include=dev` 和 `npm run build:web`，再启动游戏服务。

目标：朋友访问 `https://poker.example.com`，输入昵称，创建房间并分享邀请链接。请将示例域名替换为你的实际子域名。应用部署在子域名根路径 `/`，不支持直接挂到 `/poker/` 这样的子目录。

**不能只上传 `dist/web` 作为静态站点。** 那样只有界面，没有管理房间和发牌的游戏服务；`/api/*` 和 `/ws` 会返回 404，无法创建游戏。必须启动下方的 Node 服务或 Docker 容器，并反向代理到它。已有静态站点的修复见 [DEPLOY-FIX.md](DEPLOY-FIX.md)。

## 先了解运行方式

- 只运行 **一个 Node 进程/一个容器**。HTTP、前端文件、`/api/*` 和 `/ws` 都由它提供；无需另起 Vite。不要使用 PM2 cluster、多副本或轮询到多个实例。
- **房间、筹码、牌局记录和 API 用量统计都在内存中。重启、崩溃、更新或回退版本都会清空。** 浏览器刷新能重连到仍在运行的房间，但无法恢复服务器重启前的牌局。请在所有人结束牌局后维护。
- 没有账号、房间密码或站点登录。房间码用于分享房间，不等于访问密码；仅在朋友之间分享网址。需要站点密码时，可在现有反向代理上设置访问认证。
- API 可选。不填 `DEEPSEEK_API_KEY`，真人联机和本地机器人都能正常工作，不产生模型调用费用。真人之间的行动无需调用模型。
- **生产模式 `NODE_ENV=production` 禁用网页修改 API 配置和连接测试**。API 密钥只由部署者写入服务器 `.env`，不会发送到浏览器。改 `.env` 后需重建容器环境或重启 Node。
- `RELEASE.json` 记录源码 Git 提交、构建时间和各文件 SHA-256，便于核对版本。发布包不是数据库备份。

## 方案一：Docker Compose（推荐）

适用于 Linux 主机，已安装 Docker Engine 和 Compose 插件。Nginx/宝塔/1Panel 等反向代理运行在同一台主机上。**如果代理也运行在容器里，容器的 `127.0.0.1` 并不是宿主机；请使用方案二，或由部署者按现有 Docker 网络连接两个容器，保持服务端口不直接对公网开放。**

解压 ZIP，将其中的 `holdem-room/` 放到例如 `/opt/holdem-room`：

```bash
cd /opt/holdem-room
cp deploy/.env.example .env
chmod 600 .env
# 可选：编辑 .env，填写自己的 DEEPSEEK_API_KEY。留空也能开局。
nano .env

docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8787/healthz
```

正常会看到 `"ok":true`，容器稍后显示 `healthy`。服务器本机映射端口默认 `127.0.0.1:8787`；**不要在云防火墙里开放 8787**，只通过站点的 HTTPS 访问。

如果 8787 已占用，修改 `.env` 的 `HTTP_PORT`，并同步修改反向代理目标端口。Docker 内部的端口仍为 8787。

Docker 在构建阶段自动安装构建依赖并生成网页，运行阶段只保留生产依赖、服务源码和构建结果。服务器无需单独安装 Node、Python 或前端构建工具，但首次构建需要下载 Node 镜像和 npm 依赖。如果 Docker Hub 不可达，使用服务器已有的镜像源，或改用下方的原生 Node 方案。

常用命令：

```bash
docker compose logs --tail=100 -f holdem
docker compose exec -T holdem npm run check:deploy

# 修改 .env 后：普通 restart 不会更新 Compose 注入的环境变量
docker compose up -d --force-recreate

# 停止 / 再启动（会清空房间）
docker compose stop
docker compose up -d
```

## 绑定朋友的子域名和 HTTPS

1. 为子域名设置 DNS `A` 记录，指向该服务器公网 IPv4。仅在 IPv6 确实可用时设置 `AAAA`。
2. **为这个子域名单独新建站点**，不要覆盖朋友原有站点的配置。反向代理目标：`http://127.0.0.1:8787`（或修改后的映射端口）。
3. 开启 WebSocket，转发 `/ws`；同时转发根路径和 `/api/*`。不要把应用配置成纯静态站点。
4. 为子域名申请并启用 HTTPS，自动续期证书。前端会自动使用同域的 `wss://子域名/ws`，无需改代码或设置 API 域名。

### 已使用宝塔 / 1Panel 等面板

新建该子域名的反向代理站点，配置上述代理地址，开启 WebSocket，申请 SSL，并启用 HTTP 跳转 HTTPS。WebSocket 读取/发送超时建议为 3600 秒。若已有证书，直接使用现有证书流程，不必安装另一套 Nginx。

### 手动配置 Nginx

`deploy/nginx.conf` 是独立子域名的 HTTP 配置模板。替换域名和端口后，加入现有 Nginx 的站点目录，先执行 `sudo nginx -t`，通过后再 reload。不同发行版启用站点的目录不同，请沿用该服务器现有方式。

模板包含这些关键设置：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

如果服务器使用 Certbot Nginx 插件，DNS 已生效且 80/443 可达后，可按现有流程执行：

```bash
sudo certbot --nginx -d poker.example.com
```

证书由 Certbot/面板管理，不在此发布包中。国内服务器的域名接入和备案事项，沿用服务器提供商的要求确认后再上线。

## 方案二：直接运行 Node.js

适用于不使用 Docker、或面板已有 Node 运行环境的服务器。需要 **Node.js 24 或更新版本**，不能使用面板默认的 Node 18/20。服务端直接执行 TypeScript，无需编译服务端。

```bash
cd /opt/holdem-room
node --version
cp deploy/.env.example .env
chmod 600 .env
# 按需编辑 .env 中的 API 配置，保留 NODE_ENV=production 和 HOST=127.0.0.1
npm ci --omit=dev --no-audit --no-fund
npm start
```

发布包已有 `dist/web`，因此**首次部署无需构建前端**。用面板守护进程时，启动命令为 `npm start`，工作目录为项目根目录，设置 `NODE_ENV=production`，只运行一个进程。

也可使用 `deploy/holdem.service` 常驻：先创建专用 `holdem` 系统用户，确保它能读取项目目录和 `.env`，将服务文件中的工作目录及 Node 绝对路径改为实际值（`command -v node`）。模板假设目录为 `/opt/holdem-room`、Node 位于 `/usr/bin/node`。

```bash
sudo useradd --system --home-dir /opt/holdem-room --shell /usr/sbin/nologin holdem
# .env 交给服务用户读取；源码目录和文件也应对该用户可读/可遍历
sudo chown holdem:holdem /opt/holdem-room/.env
sudo cp deploy/holdem.service /etc/systemd/system/holdem.service
sudo systemctl daemon-reload
sudo systemctl enable --now holdem
sudo systemctl status holdem
sudo journalctl -u holdem -n 100 --no-pager
```

已有 `holdem` 用户时跳过 useradd。systemd 模板强制生产模式和本机监听；自定义端口需要同时修改模板及反向代理。

### 修改源码后

只有需要改前端时才安装开发依赖和重新构建：

```bash
npm ci --include=dev
npm run typecheck
npm test
npm run build:web
```

之后重新构建 Docker 镜像或重启 Node 服务。不要把 Vite 开发服务器作为线上服务。

## 上线验收

先检查服务器本机，再检查最终子域名：

```bash
# 原生 Node 环境执行；Docker 用户已可用上方 compose exec 命令验收内部服务
npm run check:deploy -- http://127.0.0.1:8787
npm run check:deploy -- https://poker.example.com
```

Docker 用户也可在容器里检查最终域名：

```bash
docker compose exec -T holdem npm run check:deploy -- https://poker.example.com
```

脚本检查网页资源、健康状态、公网禁止修改 API 配置、WebSocket 连通，并让两个模拟真人完成一手牌、检查底牌隔离和筹码守恒。**不加入机器人，不调用模型**。会留下一个一次性测试房间，直到服务重启。若已在反向代理设置站点密码，此脚本不处理登录，需暂时在受控环境验收，再用两个浏览器人工确认登录后的联机。

最后用两个不同设备/浏览器打开同一邀请链接，确认都能入座、看到对方行动；在朋友各自的国内网络上实际测试一次。

## 更新和回退

请保留上一个 ZIP 或旧版本目录。在无人游戏时停止旧服务，将新包解压到新目录，把服务器自己的 `.env` 安全复制过去，再启动新版本、完成验收并保持相同反向代理端口。**不要用包内空白模板覆盖已有 `.env`。** 同一个端口只能有一个实例；本 Compose 文件固定项目名 `holdem-room`，切换目录前先停止旧实例。

回退时停止新版本，从保留的旧目录启动即可。回退只恢复代码和配置，不恢复内存中的牌局/筹码。若自行修改代码，可在服务器初始化 Git 仓库管理；发布包用 `RELEASE.json` 标识原始提交，不携带作者本地 `.git`。

## 常见问题

| 现象 | 检查 |
|---|---|
| 502 | 服务是否启动、healthz 是否成功、代理端口是否一致；Docker 内代理不要指向自身 127.0.0.1 |
| 网页能开，入座失败或频繁重连 | `/ws` 是否转发，Upgrade/Connection 头是否设置，代理是否允许长连接 |
| 出现“前端还没有构建” | 是否完整上传 `dist/web`；若从纯源码部署，先安装开发依赖并执行 build:web |
| 网页没有“配置大模型”按钮 | 生产环境预期行为；由部署者编辑服务器 .env 并重建容器环境/重启服务 |
| 配了 API 但暂时零 token | 配置后每次行动均调用；检查服务器环境、网页 API 状态及失败原因。无人在线时牌局暂停，不会继续请求 |
| 重启后房间不见 | 当前版本无数据库，内存房间清空是已知限制 |
| 多个玩家进入同一房间却互相看不到 | 是否启动了多个进程/副本，或代理分发到了不同实例 |
| 容器构建下载失败 | 检查 Docker 镜像源及 npm 网络；也可用 Node 方案和包内预构建网页 |
