# Windows 部署与运行

本指南面向 `qodex-v0.1.0` 预览版。当前仅在 Windows 的已有本机环境验证；全新安装仍需按下文逐项检查。Qodex 需要本机持续运行，电脑睡眠、关机或断网时不能回复。

## 1. 准备依赖

1. 安装 [Git for Windows](https://git-scm.com/download/win)，以使用下文的 `git clone` 和升级时的 `git pull --ff-only`。
2. 安装 [Node.js](https://nodejs.org/) 24 或更新版本；这是当前 Windows 部署脚本要求的版本。
3. 安装官方 [Codex CLI](https://developers.openai.com/codex/cli)，以使用 Qodex 的同一 Windows 用户登录 **ChatGPT 账号**。仅有 OpenAI API key 不满足此版的账号检查。若 Codex 命令解析为 `.cmd` 包装器，向导中指定真正的可执行文件。
4. 从 [SnowLuma 官方发布页](https://github.com/SnowLuma/SnowLuma/releases/latest) 单独下载安装，阅读其条款并自行登录 QQ。在 SnowLuma 的 OneBot 设置中开启本机 HTTP API 和 WebSocket 服务端，分别记录地址和令牌。默认地址分别是 `http://127.0.0.1:3000` 与 `ws://127.0.0.1:3001`。WebUI 默认 `http://127.0.0.1:5099`，以自己的设置为准。

不要把 HTTP 地址填成 WebSocket 端口。Windows 向导要求 URL 使用字面量 `127.0.0.1` 和显式端口；`localhost`、IPv6 地址或无端口 URL 不会通过校验。OneBot HTTP、WebSocket、SnowLuma WebUI、Qodex 控制台和控制服务的五个端口必须互不相同。Qodex 不安装 SnowLuma，不代用户扫码登录或接受第三方协议；不要把这些服务直接暴露到公网。

## 2. 安装 Qodex

打开 PowerShell，在你选择的本地目录执行：

```powershell
git clone https://github.com/ChrisZ-123/Qodex.git
cd Qodex
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1
```

也可用 `npm run setup` 调用同一 Windows 向导。

仓库根目录的 `Setup.ps1` 调用 `scripts/windows/Setup.ps1`。向导会引导填写 Codex 可执行文件、可选的 SnowLuma 启动器、SnowLuma WebUI/HTTP/WS 地址、管理员 QQ、允许的群和私聊、模型/推理强度/速度。设置 OneBot 令牌时在安全提示中输入；令牌保存在本机 `state/secrets.dpapi`，不应手工粘贴进 `config.json`、Issue 或日志。控制台与本机控制接口的令牌也由安装过程在本地生成。

安装向导不会默认覆盖已有配置；再次运行主要用于检查当前安装。白名单默认是空的，`allowAllWhenEmpty=false`，因此配置完成前**不会响应任何群或私聊**。向导要求至少填写一个允许的群或私聊；先只放行你准备试用的目标。若填写 SnowLuma 启动器路径，Qodex 启动时会在 OneBot WebSocket 不可达的情况下尝试启动它；没有填写时仍可自行启动 SnowLuma。

建议从 `gpt-6-luna` / `max` / 默认速度开始。Qodex 启动时会检查当前 ChatGPT 账号可用的模型和推理强度，不会自动降级到别的模型。可选 `priority` 速度可能影响与其他 Codex 使用共享的额度。已有本机环境曾使用 Node 24.18.1、`codex-cli 0.155.0-alpha.16` 和 SnowLuma 1.14.17；这不是新机器或未来版本的兼容性承诺。

## 3. 启动与检查

双击仓库根目录的 `Qodex.bat`。它调用 `scripts/windows/Launcher.ps1` 打开 Windows 启动面板；在面板中点击“启动”，然后点击“打开控制台”；把本机弹窗显示的访问令牌复制到浏览器登录表单。也可在 PowerShell 运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Start
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Verify
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action OpenConsole
```

`npm start`、`npm stop`、`npm run status` 分别调用 Windows 控制脚本的 `Start`、`Stop`、`Status`，同样使用本机 DPAPI 令牌；不要直接运行原始桥接进程来绕过设置与令牌加载。

`Status` 和 `Verify` 用于排查运行中的本机进程与连接状态；控制台默认在 `127.0.0.1:3100`，控制接口默认在 `127.0.0.1:3110`。应先确认 SnowLuma 已连接，再从白名单中的账号或群发送测试消息。模型可判断不接话，因此请同时看控制台的会话历史和 `state/bridge.log`；若启动脚本报错，再看 `logs/windows-supervisor.log`，不要仅以“QQ 没收到回复”判断连接失败。

`Control.ps1` 还接受 `Stop`、`OpenSnowLuma`、`EnableAutoStart` 和 `DisableAutoStart`。`OpenSnowLuma` 只打开 WebUI；若已配置启动器路径且 OneBot WebSocket 尚未就绪，启动 Qodex 时会尝试启动 SnowLuma。自动启动仍受 Windows 用户登录、SnowLuma/QQ 状态与网络影响。关闭控制台网页不会停止后台桥接；需要停止时执行 `-Action Stop`，它也会停止由 Qodex 自动启动的 SnowLuma。暂停按钮只暂停模型接话，期间消息保留在本机历史中；恢复后从新消息继续。

若希望 Qodex 同时停止 SnowLuma，请使用保持运行、直接承载程序的启动器。使用 `start` 等方式另开进程后立即退出的第三方批处理可能脱离管理；这类 SnowLuma 与手动启动的实例一样，需要自行关闭。Qodex 不会按进程名称批量结束系统中的其他程序。

## 升级与备份

升级是本机手动流程。先停服务，再把 `config.json`、整个 `state/` 和任何在 `chatMemory.directory` 中显式指定的**仓库外**记忆目录复制到安全位置。若使用默认 `state/chat-memory`，它已包含在 `state/` 备份里。不要公开备份，因为其中可能有聊天记录和令牌状态。随后在仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Stop
git pull --ff-only
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Start
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Verify
```

如果 `git pull --ff-only` 因本地改动或分叉失败，先检查差异；不要强制重置或覆盖本地配置。Codex 登录资料由官方 Codex 单独管理，升级 Qodex 不应替换。Windows DPAPI 保护的令牌文件与当前 Windows 用户环境相关；迁移到另一台机器时请重新运行设置流程并重新输入 OneBot 令牌。

故障定位见[排查指南](TROUBLESHOOTING.md)，配置含义见[配置说明](CONFIGURATION.md)。
