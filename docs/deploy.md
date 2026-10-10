# 公网部署

让朋友从外网进房间，有两条路。先看完「安全须知」再选。

## 安全须知（很重要）

- **房间码就是唯一的门禁**。任何人拿到 4 位房间码都能进来坐下、看牌、加机器人。
  房间码用 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（去掉了 `I/O/0/1` 这些容易念错的字符），
  4 位约有 **104 万种组合**，暴力猜中不现实，但它**不是账号系统**——不要发到公开群里。
- **HTTPS 不是可选项**。用 `ws://` 明文传输时，同一网络里的任何人都能看到你发了什么。
  浏览器对非 `https` 页面还会限制剪贴板等 API。下面两种方式都默认给你 TLS。
- **服务端权威已经做到了**：底牌只发给本人，弃牌玩家的牌永远不亮。
  这一点由测试和冒烟脚本共同保证（进行中 13 次快照、0 次泄露）。
- **对局数据在内存里**。进程重启 = 房间全清空、筹码重置。这是刻意的最小实现，
  没有数据库。要长期保留战绩需要另接存储。

## 方式 A：Cloudflare Tunnel（推荐先试，零成本）

不用买服务器，把你本机的服务直接暴露出去，自带 HTTPS。

```powershell
# 1. 本机先把服务跑起来
npm start                     # 监听 0.0.0.0:8787

# 2. 另开一个终端，装一次 cloudflared
winget install --id Cloudflare.cloudflared

# 3. 建一条临时隧道（无需账号，会打印一个 https 地址）
cloudflared tunnel --url http://localhost:8787
```

命令会输出类似 `https://random-words-1234.trycloudflare.com` 的地址，
把它发给朋友即可。对方打开就是你本机的牌桌。

> 注意：临时隧道的地址**每次重启都会变**，而且流量经过 Cloudflare。
> 想固定域名就 `cloudflared tunnel login` + 建命名隧道，绑到自己的域名上。

**什么时候够用**：几个人临时开一桌。缺点是电脑必须一直开着。

## 方式 B：云服务器（长期开着，地址固定）

一台最便宜的轻量应用服务器就够（1 核 1G，几块钱一个月）。系统选 Ubuntu 22.04+。

```bash
# 服务器上：装 Node 22+（用 nodesource 或 nvm）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 传代码（本地执行）
# 注意不要传 node_modules 和 .npm-cache
scp -r holdem-room user@你的服务器:/opt/holdem

# 服务器上：装依赖并构建前端
cd /opt/holdem
npm ci --omit=dev        # 服务端只需要 ws
npm install              # 构建前端需要 devDependencies
npm run build:web        # 产出 dist/web，由 main.ts 直接托管
```

### 用 systemd 常驻

`/etc/systemd/system/holdem.service`：

```ini
[Unit]
Description=Texas Hold'em room server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/holdem
ExecStart=/usr/bin/node src/server/main.ts
Environment=PORT=8787
Environment=HOST=127.0.0.1
Environment=ACTION_TIMEOUT_MS=60000
# 大模型 key 放在单独的凭据文件里，不要写进 unit、更不要提交到 git
EnvironmentFile=/etc/holdem.env
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

`/etc/holdem.env`（权限设成 `600`，属主 `www-data`）：

```bash
DEEPSEEK_API_KEY=sk-你的key
# 可选
# DEEPSEEK_MODEL=deepseek-chat
# DEEPSEEK_TIMEOUT_MS=6000
```

```bash
sudo install -m 600 -o www-data -g www-data /dev/null /etc/holdem.env
sudo nano /etc/holdem.env      # 填入 key
sudo systemctl daemon-reload
sudo systemctl enable --now holdem
sudo systemctl status holdem
```

> 不配 key 也能跑：机器人会退回纯本地决策，功能完全正常，只是没有"性格化的临场发挥"。
> 想看用量就 `curl https://your-domain.com/healthz`，里面有大模型调用次数和 token 数。

把 `HOST` 设成 `127.0.0.1` 是为了**只让 Nginx 能访问**，不直接暴露 Node。

### 用 Nginx 终结 TLS

Nginx 负责证书和 WebSocket 升级，Node 只管业务。

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;

        # WebSocket 升级必需的三行
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # 牌局是长连接，别让 Nginx 60 秒就断开
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

证书用 `sudo certbot --nginx -d your-domain.com` 一条命令搞定。

> **最容易踩的坑**：忘了 `proxy_read_timeout`，或者 `Connection` 头没设成 `upgrade`。
> 表现是「刚坐下就断线」或者「一直转圈连不上」。

### Cloudflare 用户注意

如果域名走了 Cloudflare 代理（小黄云），确认 **Network → WebSockets 是开启的**，
否则前端会一直连不上。或者直接把这条记录的云朵点成灰色（DNS only）。

## 健康检查

```bash
curl https://your-domain.com/healthz
# {"ok":true,"rooms":3,"personas":5}
```

适合挂到 UptimeRobot 之类的监控上。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；放到 Nginx 后面时建议改 `127.0.0.1` |

## 之后要加的东西

- **断线重连**：✅ 已实现（token 存在 localStorage，刷新页面自动回到原座位）。
- **行动计时器**：✅ 已实现，默认 60 秒，超时自动过牌、不能过牌则弃牌。
  用 `ACTION_TIMEOUT_MS` 调整，`0` 关闭（只适合所有人都在场的私人局）。
- **限流**：现在任何人拿到房间码都能建房，没有速率限制。公开部署建议在 Nginx 层加
  `limit_req`，或者加一层简单的口令。
- **持久化**：对局和筹码都在内存里，重启即清空。要保留战绩得另接数据库。
