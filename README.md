# Holdem Room · 德州扑克

一个可以邀请朋友同桌的德州扑克 Web 应用，内置五位不同风格的机器人对手。使用 React、TypeScript、Node.js 和 WebSocket，所有筹码均为虚拟筹码。

**Node.js 24+ · MIT License · 可选 DeepSeek / OpenAI 兼容接口**

![牌桌](docs/refinement-table.png)

## 功能

- 昵称入场、创建房间、邀请链接，支持 2–9 人同桌及断线重连。
- 现金局与锦标赛、边池、摊牌结算、行动计时、自动下一手和手牌记录。
- 五位机器人：GTOpro、Fish、Rock、Tang Xuan、Alton。
- 本地蒙特卡洛决策随时可用；配置 Key 后，关键决策由大模型参与，常规行动仍在本地完成。
- 英文行动按钮、按窗口缩放的牌桌，以及本人实时最佳牌型显示。
- 服务端控制牌局状态，按玩家过滤底牌；对手不能收到你的私有手牌信息。

## 本机运行

需要 Node.js 24 或更新版本。服务端直接运行 TypeScript，无需额外编译器。

```bash
npm ci
npm run build:web
npm start
```

打开 <http://localhost:8787>，输入昵称、创建房间，然后入座或快速开桌。没有 API Key 也能联机或与机器人练习。

## 大模型配置（可选）

```bash
cp .env.example .env
# Windows PowerShell: Copy-Item .env.example .env
```

在服务器项目根目录的 `.env` 中填写：

```dotenv
DEEPSEEK_API_KEY=填写自己的Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT_MS=8000
```

修改后重启游戏服务。所有房间共用管理员配置的 Key；它不会发送给浏览器。`DEEPSEEK_BASE_URL` 也可指向其他兼容 OpenAI chat completions 的服务。

本机开发时可直接通过 localhost 页面配置。公网必须设置 `NODE_ENV=production`，此时关闭网页修改 Key 与连接测试，由部署者管理环境配置。Docker 更改 `.env` 后需执行 `docker compose up -d --force-recreate`。

机器人只在关键决策调用模型，每个座位每手默认最多两次。网页显示请求成功/失败及接口返回的 token 用量；未触发关键决策时零调用是正常情况。调用失败会回退到本地策略。

## 部署到自己的服务器

推荐使用独立子域名、HTTPS 和一个游戏服务实例。

```bash
cp deploy/.env.example .env
# 按需编辑 .env 中的模型 Key，留空也能游戏
chmod 600 .env

docker compose up -d --build
curl --fail http://127.0.0.1:8787/healthz
```

Docker 会从源码自动构建前端，发布端口只绑定服务器本机。把子域名反向代理到 `http://127.0.0.1:8787`，并启用 WebSocket。完整步骤见 [DEPLOY.md](DEPLOY.md)，包含 Nginx、宝塔/1Panel、原生 Node 和 systemd 配置。

**不能只把 dist/web 上传成静态站点。** 房间、发牌和行动由 Node 后端负责；只有静态网页会导致 API 和 WebSocket 404。遇到此情况请参考 [DEPLOY-FIX.md](DEPLOY-FIX.md)。

上线后可验收：

```bash
npm run check:deploy -- https://你的子域名
# 或在容器里执行
# docker compose exec -T holdem npm run check:deploy -- https://你的子域名
```

验收会检查网页、五个机器人、管理权限、双人 WebSocket 牌局、底牌隔离和筹码守恒，不调用模型。

## 当前限制

- 房间、筹码、牌局记录和用量统计在内存中，**重启会清空**；更新请在牌局结束后进行。
- 只支持单进程/单容器，不能使用 PM2 cluster 或多副本分流。
- 没有账号、房间密码或数据库。房间码用于邀请，不等于访问密码。朋友私局需要额外门禁时，可在反向代理设置站点认证。
- 当前没有完整的公开大厅滥用防护。部署边界和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 开发与测试

```bash
npm run dev:server   # 后端，默认 8787
npm run dev:web      # 前端，默认 5173；代理 API 和 WebSocket

npm run typecheck
npm test
npm run build:web
```

测试覆盖规则、牌力、边池、筹码守恒、超时、机器人、模型降级与底牌隔离。GitHub Actions 会运行检查及 Docker 构建，无需配置真实 API Key。

参与贡献请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目结构

```text
src/engine/     扑克规则、牌力评估、蒙特卡洛胜率、牌局状态机
src/server/     HTTP/WebSocket、房间、机器人、模型适配与权限
src/shared/     显示格式
src/web/        React 界面
scripts/        演示、冒烟测试、部署验收和发布打包
launchers/      Windows 本机应用窗口启动器
deploy/        服务器环境、Nginx 和 systemd 模板
docs/          截图与历史开发记录
```

维护者可在构建网页并提交代码后运行 `python scripts/package-release.py`，生成不含真实密钥的部署 ZIP 和 SHA-256 清单。Python 仅用于本地打包，运行游戏不需要它。

历史记录：[牌桌优化](docs/optimization-20261017.md) · [英文行动与 DeepSeek 诊断](docs/refinement-20261017.md) · [部署交接](docs/deployment-release-20261017.md) · [静态部署故障修复](docs/static-deployment-fix-20261017.md)。

## 许可证

采用 [MIT License](LICENSE)。
