# 参与贡献

欢迎提交问题、文档改进和 Pull Request。开发环境为 Node.js 24+ 和 npm。

```bash
npm ci
npm run dev:server
# 在另一个终端启动前端开发服务器
npm run dev:web
```

开发页面默认在 `http://localhost:5173`；Vite 将 API 和 WebSocket 转发至 8787 端口的游戏服务。无需配置真实 API Key。需要模拟模型响应时可用 `npm run mock:llm`。

提交前执行：

```bash
npm run typecheck
npm test
npm run build:web
```

- 修改规则、筹码结算、底牌隔离或管理权限时，请添加覆盖实际问题的回归测试。
- 界面调整请附截图及测试的窗口尺寸。
- 配置和密码放在忽略的 `.env` 中，勿提交 API Key、玩家 token、日志或浏览器配置。
- 问题报告请包含 Node 版本、部署方式、复现步骤和已脱敏的错误。不要上传真实密钥。
- 对安全问题请参阅 [SECURITY.md](SECURITY.md)。

贡献按项目的 [MIT 许可证](LICENSE) 发布。
