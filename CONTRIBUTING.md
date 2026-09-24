# 参与贡献

欢迎为 Qodex 提交可复现的问题、文档修正和针对当前 Windows + Codex 发布路径的小范围改进。请先阅读 [README](README.md)、[项目指南](docs/PROJECT_GUIDE.md)和[安全说明](SECURITY.md)。本预览版以模型自主对话为主，旧 DSH 脚本和后端仅保留在内部代码中，不作为功能请求的默认目标。

提出 Issue 时请说明触发步骤、预期与实际结果、Windows/Node/Codex/SnowLuma 版本，以及脱敏日志。不要提交真实 `config.json`、`state/`、QQ 号、群号、令牌、私人聊天、用户目录或可用的访问链接。安全问题请按 [SECURITY.md](SECURITY.md) 的私有渠道处理。

提交代码前：

1. 从最新目标分支创建独立分支，保持修改集中，解释用户可见行为与兼容影响。
2. 运行与改动相关的聚焦检查；发布回归入口是 `npm test`，Windows 部署检查是 `npm run test:deployment`。没有真实 QQ 测试时请明确说明，勿把模拟检查写成端到端验证。
3. 更新受影响的配置、部署或故障排查文档。新增第三方依赖时注明来源和许可证，不捆绑 SnowLuma 或 Codex 可执行文件。
4. 提交 PR 时说明测试环境、实际运行过的命令与已知限制，使用仓库的 PR 模板。

**权利与来源：** Qodex 继承的上游提交没有明确的 `LICENSE` 文件。GitHub 的公开 fork 机制允许平台内查看与 fork，但它本身不授予通用的再分发许可证。请先查看[来源与许可说明](THIRD_PARTY_NOTICES.md)；只提交你有权贡献的内容，并保留原作者署名。对外复用或重新授权之前应自行确认相关权利。
