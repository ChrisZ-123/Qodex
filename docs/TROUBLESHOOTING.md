# 故障排查

先从仓库根目录查看状态；若未运行，执行 `Control.ps1 -Action Start` 后再做连接验证。随后查看 `state/bridge.log`、启动失败时的 `logs/windows-supervisor.log` 与控制台的会话历史。分享日志或截图前删掉账号、群号、聊天原文、令牌和本机路径。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Verify
```

| 现象 | 检查与处理 |
| --- | --- |
| `Setup.ps1` 提示找不到 Node 或版本不足 | Windows 安装脚本要求 Node.js 24 或更新。安装后重新打开 PowerShell，再运行 `node --version` 与 `npm ci`。 |
| 找不到 Codex 或选中了 `codex.cmd` | 安装官方 Codex 桌面版或 CLI，在安装向导中给出原生 `codex.exe` 完整路径。仅有 npm 的 `.cmd` 包装器不能满足此部署流程。 |
| Codex 账号或模型不可用 | 用运行 Qodex 的同一 Windows 用户在官方 Codex 中登录 ChatGPT 账号。API key 鉴权不支持。向导/启动会检查模型与推理强度；选择当前账号实际列出的组合。不会自动更换模型。 |
| 桥接启动了但 QQ 没有会话 | 确认 SnowLuma 已登录 QQ、启用 OneBot WebSocket 服务端、URL 与令牌一致；确认目标群/私聊在白名单，黑名单没有覆盖。白名单为空时默认不放行。 |
| 会话里有消息，却没有 QQ 回复 | 看控制台是否暂停、模型是否选择不接话、是否有“模型请求失败”或“QQ 发送失败”事件。模型会根据群聊上下文保持安静，不能以无回复单独判断为故障。暂停期间的消息不会在恢复后自动补交。 |
| HTTP 426、发送表情或同步收藏失败 | `snowluma.httpUrl` 应指向 OneBot **HTTP API**，不是 WebSocket 的 3001 端口；检查 SnowLuma 的 HTTP 服务、access token 和本机回环地址。 |
| 图片未被自动收藏 | 仅允许群中由 OneBot 明确标记为表情的图片会进入自动收藏；普通图片和私聊图片不会。达到 100 张时暂停新增。可在控制台检查表情设置并手动同步 QQ 收藏。 |
| 控制台打不开或提示未授权 | 用 `Control.ps1 -Action OpenConsole` 打开页面，将本机弹窗中的令牌复制到浏览器登录表单；检查控制台端口、进程状态及是否在正确的 Windows 用户下运行。不要把令牌或带令牌的访问链接分享出去。 |
| `state/secrets.dpapi` 无法解密 | 该文件受创建它的 Windows 用户环境保护。回到原用户运行；迁移机器时备份聊天数据后，安全重新初始化并输入 OneBot 令牌。不要把它改成明文 JSON。 |
| 端口占用 | `Setup.ps1` 会检查 WebUI、OneBot、控制台与控制服务端口是否不同。确认占用程序并在配置中选另一可用端口，重启后验证。 |
| 向导拒绝 `localhost`、IPv6 或无端口地址 | 当前 Windows 向导要求 OneBot HTTP、WebSocket 与 WebUI URL 使用字面量 `127.0.0.1`、显式端口；五个服务端口必须不同，范围为 1024–65535。 |
| `git pull --ff-only` 失败 | 查看仓库是否有本地改动或分叉；保留并审阅差异，不要用强制重置覆盖 `config.json` 或 `state/`。 |
| 关闭控制台后仍在回复 | 控制台只是网页。运行 `Control.ps1 -Action Stop` 停止桥接及由 Qodex 自动启动的 SnowLuma；若 SnowLuma 是手动启动的，需另行关闭。 |
| 电脑睡眠后不回复 | 睡眠、关机和断网期间本机进程无法实时接收并回复。唤醒后检查 SnowLuma、Codex 登录、`Status` 与日志。失败的模型批次不会静默自动重试。 |

模型搜索网页属于 Codex 的原生能力，只在模型认为需要时发生。没有联网搜索记录并不自动说明配置失败。控制台可直接选择模型和推理强度；保存提示忙碌时等待任务结束，或暂停后等取消完成再保存。列表为空或刷新失败时检查 Codex 登录和连接。重置会话保留长期记忆，因此模型仍可能知道记忆中的约定；需要修改这些内容时使用记忆编辑入口。手工修改配置或本机端口前，先用旧配置执行 `Stop`，再编辑配置、`Start`、`Verify`。若问题可稳定复现，请用[问题模板](../.github/ISSUE_TEMPLATE/)提交脱敏的步骤、预期/实际行为、版本与日志片段。
