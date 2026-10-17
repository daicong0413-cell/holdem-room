# dcpoker.awamyy.top 已上线站点的修复步骤

2026-10-17 实测：网站首页可访问，但 `/healthz`、`/api/personas`、`/api/llm`、`/api/config` 和 `/ws` 全部返回 404。已确认目前只上传了 `dist/web` 静态网页。

这会同时导致：不能创建房间；机器人列表加载失败后旧前端只显示兜底 GTOpro；无法获取 API 状态，旧前端误显示“本地 AI 已就绪”。**五个机器人没有被删掉，API Key 是否配置成功也不能从这个旧提示判断。**

## 1. 启动完整项目

将新 ZIP 内的整个 `holdem-room/` 上传到服务器，例如 `/opt/holdem-room`。不要只上传 `dist/web`。不改动朋友其他站点。

如果使用 Docker Compose，按 [DEPLOY.md](DEPLOY.md) 运行即可。

如果使用已有 Node 项目面板，选择 Node.js 24 或更新版本，工作目录设为完整项目根目录，安装并启动：

```bash
cd /opt/holdem-room
cp deploy/.env.example .env    # 只在首次配置时执行；已有 .env 不要覆盖
chmod 600 .env
npm ci --omit=dev --no-audit --no-fund
npm start
```

用面板守护 `npm start`，只运行一个实例。模板 `.env` 已设生产模式、监听 `127.0.0.1:8787`。包内前端已构建，不需启动 Vite。

启动后，**先在服务器本机验证**：

```bash
curl --fail http://127.0.0.1:8787/healthz
curl --fail http://127.0.0.1:8787/api/personas
```

预期：第一个返回 JSON `"ok":true`；第二个包含 GTOpro、Fish、Rock、Tang Xuan、Alton。若本机访问都失败，先修复 Node 服务，暂时不要修改域名配置。

## 2. 将现有 HTTPS 子域名反向代理到游戏服务

保留当前的域名和 SSL 证书，在现有 `dcpoker.awamyy.top` 站点中，将根路径 `/` 的处理方式改为反向代理 `http://127.0.0.1:8787`，并开启 WebSocket。

手动编辑 Nginx 时，用下面的 `location /` **替换现有负责静态站点的 `location /`**。不要将两个相同路径配置同时追加，也不要用新文件覆盖整套 HTTPS 配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
}
```

如果站点还配置了针对 `.js`、`.css` 等文件的正则 location 静态缓存规则，也应移除或调整为从同一个 Node 上游取资源，避免它们继续指向旧的静态目录。面板通常使用“反向代理站点 + WebSocket”即可。

配置完成后，先 `nginx -t`，通过后 reload。在浏览器强制刷新，避免缓存旧界面。站点首页和所有资源现在都由 Node 服务提供。

代理若在 Docker 容器里，`127.0.0.1` 指的是代理自身，请由部署者沿用现有 Docker 网络连接方式，见 DEPLOY.md。

## 3. 管理员配置一次大模型，所有房间共用

编辑服务器项目根目录 `.env`（**不在 dist/web 内**）：

```dotenv
NODE_ENV=production
DEEPSEEK_API_KEY=在服务器填入自己的真实Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT_MS=8000
```

Node 面板/systemd：重启这个项目进程。Docker Compose：`docker compose up -d --force-recreate`，仅 `restart` 不会重新注入 env_file。

玩家不需要输入 Key。生产网站的修改配置按钮关闭，是为了防止普通玩家覆盖全站密钥或使用测试按钮消耗 token；无需改成开发模式。网页只展示是否接入、模型名、成功/失败及 token 用量。Key 不会发给浏览器。

机器人在未配 Key 时也能使用本地策略行动。配 Key 后，每次机器人行动都会调用模型，接口失败时回退本地策略。房间是否可创建与是否配置 Key 无关。

## 4. 验收最终网址

```bash
# 原生 Node 在项目目录执行
npm run check:deploy -- https://dcpoker.awamyy.top

# Docker 用户也可在容器中执行
docker compose exec -T holdem npm run check:deploy -- https://dcpoker.awamyy.top
```

验收包含五个机器人列表、管理员权限、真实双人 WebSocket 牌局及底牌隔离，不调用大模型。最后请在两台设备上用同一个邀请链接确认可以共同入座。

更新/重启会清空内存房间和筹码，请在朋友结束牌局后维护。
