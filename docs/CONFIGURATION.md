# 配置说明

首次运行优先使用根目录 `Setup.ps1`（也可运行 `npm run setup`）。以下说明与 `config.example.json` 一起用于审阅生成的 `config.json`；示例文件没有真实账号、令牌或本机路径。配置文件和 `state/` 都不会被 Git 跟踪。手工更改模型、`consolePort` 或 `controlPort` 时，先用**旧配置**执行 `Control.ps1 -Action Stop`，再修改配置、执行 `Start` 和 `Verify`。先改控制端口会使旧进程无法通过新端口停止。

## Codex 与会话

| 字段 | 含义 |
| --- | --- |
| `backend` | 发布版使用 `codex`。旧 DSH 代码仍在源码中，但不作为此预览版受支持的部署后端。 |
| `codex.exe` | 原生 Codex CLI 可执行文件路径；留空时由运行环境发现。某些 `.cmd` 包装器不能作为子进程启动。 |
| `codex.conversationMode` | 发布版为 `model`：把允许的消息交给模型自主决定是否接话。 |
| `codex.model` | 需要当前 ChatGPT 账号支持的模型；默认示例为 `gpt-6-luna`。 |
| `codex.reasoningEffort` | 推理强度；示例为 `max`，与模型一起检查可用性。 |
| `codex.serviceTier` | `default` 为标准速度，`priority` 为可选速度。不会自动回退。 |
| `chatMemory.directory` | 每个群/私聊的长期记忆位置；默认 `state/chat-memory`。相对路径从**仓库根目录**解析，也可使用绝对路径。 |
| `sessionCwd` | 旧会话工作目录字段；普通使用保持空值。 |

Codex 账号必须是 ChatGPT 登录类型；仅配置 API key 不可用。控制台支持账户可用模型与推理强度选择，下一轮生效且保留速度档位；有会话正在处理时拒绝保存。选择对整个部署生效，不修改 Codex 桌面端全局模型。会话重置只影响选中的会话，取消待发送回复并在下条消息创建新上下文，保留历史、人格和长期记忆，不重新注入重置前的历史；它不是删除记录或清空长期记忆，也不会撤回已发送消息。模型有权选择不回复，原生网页搜索也由模型按需使用；配置 `web_search: live` 不等于每轮自动联网。一个群或私聊各有独立模型会话、历史和长期笔记。长期笔记最多 30,000 字符，可在控制台关闭或手工编辑；关闭后不会再注入笔记，但旧聊天记录可能仍含曾谈过的内容。记忆在聊天模型的同一轮输出中更新，没有单独记忆模型，不用于 Qodex 训练。

## SnowLuma 与访问

Windows 向导要求以下三个 URL 使用字面量 `127.0.0.1` 和显式端口；不接受 `localhost`、IPv6 地址或省略端口。OneBot HTTP、WebSocket、SnowLuma WebUI、控制台、控制服务五个端口必须各不相同，端口范围为 1024–65535。

| 字段 | 含义 |
| --- | --- |
| `snowluma.wsUrl` | 本机 OneBot WebSocket 服务端；默认 `ws://127.0.0.1:3001`。 |
| `snowluma.httpUrl` | 本机 OneBot HTTP API；默认 `http://127.0.0.1:3000`，不要填 WebSocket 端口。 |
| `snowluma.webUiUrl` | SnowLuma 管理页地址；默认 `http://127.0.0.1:5099`。 |
| `snowluma.launcherPath` | 可选的本机启动器路径；启动 Qodex 时若 OneBot WebSocket 尚不可达，管理进程会尝试启动它。`OpenSnowLuma` 只打开 WebUI。SnowLuma 需单独安装。 |
| `snowluma.accessToken` | 示例留空；向导会安全询问 OneBot 令牌并存入 `state/secrets.dpapi`，不要写入公开配置或 Issue。 |
| `ownerQQ` | 管理员 QQ 号。 |
| `allow.groups` / `allow.private` | 允许接入的群号和私聊 QQ 号数组；默认空。 |
| `deny.groups` / `deny.private` | 黑名单，优先于白名单。 |
| `allowAllWhenEmpty` | 保持默认 `false`：白名单为空时拒绝所有消息。设为 `true` 会扩大访问范围。 |

群聊的全体发言在放行后会进入该群独立会话，由模型判断是否接话；`ownerQQ` 不意味着管理员普通群发言必须得到回复。不要将 OneBot、控制台或控制接口直接开放到公网。需要改访问范围时，可使用本机控制台的“群聊与访问权限”界面。

## 控制台、历史与表情

| 字段 | 含义 |
| --- | --- |
| `consolePort` | 本机控制台端口，默认 3100。 |
| `controlPort` | 本机控制接口端口，默认 3110。 |
| `consoleToken` | 控制台访问令牌；安装时在本地生成并保管，不要分享。 |
| `ackMessage` | 消息收到后的提示文本；默认空，不额外发送即时确认。 |
| `sendDelayMs` | 连续发送的基础间隔。 |

控制台可管理全局人格、聊天口吻、白名单、会话历史、暂停状态、每个会话的长期记忆、表情目录和备注。每轮最多发送两张已在目录中的表情。开启“收藏表情看图学习”时，每轮最多向当前模型提供两张尚无备注的收藏图；笔记供各允许会话共用。自动收藏只处理**允许群**里 OneBot 明确标记为表情的图片；普通群图和私聊图片不会自动收藏，到 100 张时暂停新增。手工在 QQ 收藏的表情可在控制台同步。

`state/` 含会话历史、记忆、表情资料、日志以及本地令牌状态，应视为私有数据备份。显式设置仓库外 `chatMemory.directory` 时，备份和迁移须额外包含该目录。不要把本机真实文件、`config.json`、`state/` 或 `*.dpapi` 提交到 Git。
