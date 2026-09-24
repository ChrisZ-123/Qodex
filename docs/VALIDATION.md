# v0.1.0 发布验证记录

验证日期：2026-09-24。此记录区分模拟测试、真实程序协议检查和真实 QQ 运行，不将模拟服务通过等同于全新电脑上的真实账号联调。

## 已完成的核心检查

- `node scripts/test-audit.mjs`：19/19 组脚本通过，覆盖白名单发送时复查、会话隔离、取消与暂停竞争、控制台认证/CSRF、角色编辑、记忆、引用序列化、表情收藏和学习等。
- `node scripts/test-portable-memory.mjs`：两个部署的默认记忆目录彼此隔离；中文及空格相对路径、显式绝对路径均通过。
- Codex 会话测试验证首次创建及恢复前会自动创建 `state/agents`，不依赖已有运行数据。
- 浏览器使用虚构数据检查控制台登录表单、暂停/恢复、群间切换、编辑记忆及跨群隔离；截图来自该测试界面。
- 候选文件检查未检出已知私人号码、机器路径或凭据格式；真实配置、状态、日志、DPAPI 文件及依赖目录均在忽略规则中。新增历史只包含整理后的发布源码，不包含本机开发提交。

## 真实 Codex 程序检查

本机环境为 Node.js 24.18.1、`codex-cli 0.155.0-alpha.16`；原有 SnowLuma 环境版本为 1.14.17。版本记录不保证未来版本兼容。

`scripts/runtime-check.mjs` 对真实 Codex 执行只读账号与模型目录查询，确认 ChatGPT 登录类型及建议的 `gpt-6-luna / max` 组合可用，没有调用真实模型推理。其他用户仍须通过自己的安装向导检查。

`scripts/test-codex-tool-isolation.mjs` 使用真实 Codex app-server、独立临时 Codex 数据目录和本机模拟模型服务检查请求中的工具声明：未暴露 shell、文件操作、桌面操作或继承的 MCP 工具。模拟服务主动返回 `intentional offline audit stop`，这是测试终止方式。该项需要已安装原生 Codex，不属于无账号 CI 的必选测试。

## Windows 与干净部署

- 发布工作区完整 `npm test` 通过：核心 19/19 组、记忆目录隔离与 Windows 部署夹具均通过。
- 将 Git 暂存区中的 123 个候选文件导出到全新目录，不复制本机配置、状态或 `node_modules`，重新运行 `npm ci`（128 个依赖包）和 `npm test`，结果全部通过。
- Windows 夹具使用中文与空格路径，验证缺失依赖提示、首次配置写入、DPAPI 加解密、拒绝重复初始化、控制台及控制端口占用、错误令牌拒绝、图形启动页构建、模拟 SnowLuma 批处理启动、模型就绪状态、停止前取消与只停止本部署进程。
- 修复了后台进程继承输出管道导致启动面板等待的问题，以及从 PowerShell 7 经 npm 启动 Windows PowerShell 时安全模块解析冲突的问题。
- 测试使用正常 Windows 用户的 DPAPI 环境，未改用明文或替代加密。启动项写入和真实 QQ 登录需由安装者选择完成；模拟测试没有修改本机登录自启。

## 复现与边界

在 Windows 安装 Node.js 24 后，从干净源码目录运行：

```powershell
npm ci
npm test
```

`npm test` 只使用隔离目录、虚构数据及模拟 QQ/Codex 服务，不需要真实 QQ 或 Codex 账号。DPAPI 测试需要正常的 Windows 用户配置环境，不能通过跳过加密来规避失败。

本次发布验证不向真实 QQ 群发送测试消息，未验证全新物理电脑上的扫码登录、不同第三方版本或持续长时运行。Linux/macOS 与桌面安装包不在首发支持范围内。远端 Windows CI 的执行记录见仓库 [Actions](https://github.com/ChrisZ-123/Qodex/actions)。
