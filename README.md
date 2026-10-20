# Qodex

**基于 Codex 的 QQ 自主群聊助手**

用 Codex 驱动 QQ 群聊与私聊的本地桥接程序。Qodex 接收 [SnowLuma](https://github.com/SnowLuma/SnowLuma) 的 OneBot 消息，让模型结合各会话的历史和记忆，自己决定接话、保持安静、搜索网页或理解图片。管理员通过本机网页控制台管理访问范围和聊天风格。

**English:** [README.en.md](README.en.md) · **版本：** `qodex-v0.6.0` 预览版 · **平台：** Windows；需自己的 QQ 与 Codex ChatGPT 登录

本项目是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的公开 fork，基于上游提交 [`dea3ce8`](https://github.com/Derpyu520/qq-bridge/commit/dea3ce8) 改造。它不是 SnowLuma、QQ 或 OpenAI 的官方产品。上游没有随该提交提供明确的 `LICENSE` 文件；请阅读[来源与许可说明](THIRD_PARTY_NOTICES.md)，不要把本仓库视为已获得通用开源再许可。

```mermaid
flowchart LR
    QQ[QQ 群聊 / 私聊] <--> SL[SnowLuma<br/>OneBot HTTP + WebSocket]
    SL <--> QB[Qodex 桥接]
    QB <--> CX[本部署独立 Codex CLI<br/>ChatGPT 账号登录]
    QB <--> UI[本机控制台]
    QB <--> ST[本机历史、条目记忆、表情与设置]
```

## 能做什么

- **群聊 / 鸣潮双分区：** 两区共用左侧会话选择，切换保留各区未保存的草稿；修改后仍须点击对应保存按钮。鸣潮整合是可选模块，公开默认关闭，远程自助绑定另行明确启用。原有聊天、记忆、生图、表情与备份功能保留。
- **鸣潮原版功能与模型工具：** 启用后，明确 `ww` 指令独占游戏处理；自然语言由当前聊天模型从实际游戏目录选择工具，同轮使用原版结果回答。公开资料、本人账号功能及待授权项目分别标示，不把“未绑定”当成成功查询。自动签到和体力提醒默认关闭，本人直接发送的明确 `ww` 签到、解绑、订阅指令即构成操作授权；模型发起的修改需同一 QQ 另行确认。详见[鸣潮说明与支持矩阵](docs/WAVES.md)。
- **鸣潮登录与作者授权：** 群内登录链接 @申请人；SMS 验证后返回账号摘要，须同一 QQ 确认才提交绑定。控制台可分别或共用保存 WavesToken/xwtoken，DPAPI 加密且不入备份；已保存、真实验证、授权拒绝与服务故障分开显示，作者授权不代替玩家登录。
- **鸣潮一次绑定，多群使用：** 同一 QQ 在同一机器人成功登录并确认绑定一次后，可在该机器人已加入、已放行且允许鸣潮的其他群直接使用本人账号，无需逐群登录。各群仍检查白名单、游戏开关和暂停；聊天记忆与自动任务订阅仍按会话隔离。不共享给其他 QQ 或独立机器人，凭据过期/撤销后可能需重新登录。
- **QQ 语音转写（实验性）：** 公开默认关闭，按会话可继承、开启或关闭。开启时请求 SnowLuma 的 QQ 原生转写，保留来源和失败提示，不保存音频。历史证据确认收到了语音，但多条实际转写失败，原因尚未确定。不能保证稳定识别，详见[语音说明](docs/VOICE.md)。
- **自然有序回复：** 模型原生排列文字、表情、生图与鸣潮结果图片，可保持安静或只发表情。每轮最多四段文字、两张不同表情、一张生成图、二十张不同鸣潮结果图；整轮先校验，每次发送再检查权限，失败停止剩余发送且不重试。只在第一条实际消息附引用。全局/分会话可选自然回复或单段文字。
- **模型自主接话：** 允许的群消息和私聊交给同一轮 Codex 对话判断；它可以回复，也可以不发言。是否搜索网页由模型按问题决定，不能保证每条消息都有回复或都会联网。
- **独立会话与设置：** 每个群和私聊分别保留模型上下文及历史。模型、推理强度、人格和聊天口吻可继承全局设置，也可按会话覆盖；还能为单个会话暂停、取消当前回复或重置上下文。全局速度及自动压缩阈值对所有会话生效。
- **分类互动记忆与表达反馈：** 每个会话的长期记忆独立保存，总有效内容上限 30,000 字符；支持事实、人物、共同经历、话题四类，关联真实 QQ、来源证据及话题结束状态；保留修订、置顶、停用和旧版恢复。本轮按需检索相关条目，模型可在同轮逐条更新。机器人回复可标记“多余”“太长”或“合适”，并可撤销反馈。这些只是本地资料和表达提示，**不是模型训练**。
- **原生生图与改图：** 群友可请求新图，或引用本会话图片要求改图；每轮最多发送一张。公开安装默认“仅明确请求”，可改为关闭或允许模型主动生成。生图全局串行，其他群仍能文字聊天；失败或取消不自动重试。图片存于本部署 `state/generated-images`，备份 JSON 只含元数据。
- **合并转发与自然接话：** 可读取当前消息或本会话引用的合并转发，向模型提供转发文字和图片；控制台展示内容、读取耗时与截断提示。无 @ 的开放话题也可参与，模型仍会选择安静；旧转发中的命令没有管理权限。
- **收藏表情：** 模型每轮最多发两张已收藏表情，并可逐步看懂最多两张尚无备注的收藏图。仅在允许的群中自动收藏 QQ 明确标记为表情的图片；普通照片、截图和私聊图片不自动收藏。自动新增在 100 张时暂停。图库支持搜索、学习状态筛选、备注及全局或分会话禁用；禁用不会删除 QQ 收藏。公开默认“自然适量”。
- **连接恢复：** 模型列表有明确的加载/失败/刷新状态，保留已有选项。启动页“修复 Codex 连接”只重启所属桥接/Codex，不动 QQ、鸣潮或隧道；硬性上下文耗尽后仅在下批新消息建立新线程，保留旧绑定/历史，不回放失败消息。
- **本机管理与备份：** 控制台可查看分会话运行阶段、排队、搜索耗时、发送结果及脱敏错误；管理权限、暂停、人格、历史、记忆与表情。可导出白名单格式 JSON，预览差异并选择恢复。备份 v1 保留回复方式、记忆元数据和可选历史顺序，不导出作者/玩家凭据、票据、订阅、登录态、音频或图片本体，恢复不自动订阅；私人文本仍需自行保管。

以下截图使用测试数据生成，仅作**界面示意**，不含真实 QQ 会话或账号。

![自然回复与部分发送结果示意](assets/qodex-replies-v060.png)

![分类互动记忆示意](assets/qodex-memory-v060.png)

![鸣潮与作者授权示意](assets/qodex-waves-v060.png)

![模型加载与全局人格示意](assets/qodex-models-v060.png)

## 安装

需要 Windows、[Git for Windows](https://git-scm.com/download/win)、Node.js 24 或更新、单独安装的 [Codex CLI](https://developers.openai.com/codex/cli) 和 [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases/latest)。Codex 必须使用 **ChatGPT 账号**为这个部署单独完成官方登录；此版不支持只用 API key 鉴权。请自行阅读、接受各产品的条款并完成 QQ 登录；Qodex 不捆绑第三方可执行文件，也不会代你接受协议。

首次预览版记录的本机环境为 Node 24.18.1、`codex-cli 0.155.0-alpha.16`、SnowLuma 1.14.17；这是历史记录，**不是 v0.6.0 的全版本兼容保证**。安装向导检查独立登录账号可用的模型和推理强度。从当前账号可用列表选择模型和推理强度，默认标准速度；可选 `priority` 加速，**不保证固定倍率提速**，且可能影响共享的 Codex 使用额度。主动生图也会增加用量。模型不可用时会报错，不自动切换。

```powershell
git clone https://github.com/ChrisZ-123/Qodex.git
cd Qodex
git switch --detach qodex-v0.6.0
.\Install.bat
```

`Install.bat` 调用中文引导脚本 `scripts/windows/Install.ps1`，检查 Node.js、原生 Codex 与 SnowLuma，依赖已就绪时跳过安装，否则暂存执行 `npm ci --omit=dev`，成功后才替换依赖；检查独立登录，未就绪时进入官方登录，再运行设置向导并打开启动面板。缺少软件时提示官方渠道，不自动下载全局软件。QQ、Codex 和玩家登录仍需本人完成；这不是 EXE 安装包，也不是全无人值守安装。重跑前先停止本部署；已有配置、密钥和已就绪登录会保留。

独立登录由 Codex 官方命令完成，状态保存在本部署的 `state/codex-home`；Qodex 不复制桌面端登录资料。登录后再运行安装向导。控制台可调整全局和分会话的图片生成、表情倾向；现有已保存值不会被升级覆盖。

安装向导会询问 Codex 可执行文件、SnowLuma 启动器（可选）、WebUI 与 OneBot 地址、管理员、群和私聊白名单、模型与速度。若系统只找到不兼容的 `.cmd` 包装器，请指定真正的 Codex 可执行文件路径。SnowLuma 中需自行开启本机 OneBot **HTTP API**（默认 `127.0.0.1:3000`）和 **WebSocket 服务端**（默认 `127.0.0.1:3001`）；WebUI 默认 `http://127.0.0.1:5099`，以实际设置为准。向导要求地址使用字面量 `127.0.0.1` 和显式端口，`localhost`、IPv6 或无端口 URL 不受支持；OneBot HTTP、WebSocket、WebUI、控制台和控制服务的端口必须各不相同。OneBot 令牌在向导的安全提示中输入，保存在本机 Windows DPAPI 状态文件中，不写入公开 JSON 模板。

完成后双击 `Qodex.bat` 打开 Windows 启动面板，再点击“启动”和“打开控制台”。控制台与控制接口默认分别使用 `127.0.0.1:3100`、`127.0.0.1:3110`；访问令牌在本机生成。向导重跑时会先验证已有配置，不会默认覆盖。白名单为空时默认**不响应任何 QQ 消息**；请明确添加要接入的群或私聊。完整步骤见[部署指南](docs/DEPLOYMENT.md)，字段见[配置说明](docs/CONFIGURATION.md)。

需要鸣潮时，另行安装 Python 3.11 x64，传入其解释器路径：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Install-Waves.ps1 -Python "C:\Python311\python.exe"
# 仅明确需要远程自助绑定时，在上述命令追加 -RemoteLogin
```

安装器从官方/作者来源下载固定提交源码、运行依赖与作者资源；仓库不捆绑第三方二进制或游戏素材。运行目录为本部署 `state/waves`，安装完成后重启Qodex加载安全密钥，再在鸣潮分区显式开启游戏功能，远程登录仍单独控制。[gsuid_core](https://github.com/Genshin-bots/gsuid_core)、[XutheringWavesUID](https://github.com/Loping151/XutheringWavesUID)、[RoverSign](https://github.com/Loping151/RoverSign)、[RoverReminder](https://github.com/Loping151/RoverReminder)、[ScoreEcho](https://github.com/Loping151/ScoreEcho) 的固定提交和 GPL-3.0 许可见[第三方说明](THIRD_PARTY_NOTICES.md)。GPL 仅按其适用源码范围声明，不将继承仓库根目录重新许可。

## 日常运行

从 v0.5.0（`aab466b`）升级先停止并完整备份旧部署及外部记忆；按[v0.6.0 升级与回退指南](docs/UPGRADE_V060.md)操作。升级不会批量重置会话，也不强制替换现有角色。首次启用游戏工具在下个空闲点/新线程生效，新上下文载入最近 100 条有效消息及当轮检索记忆；完整本地历史、长期记忆和旧 Codex 绑定保留供回退，不声称复制旧原生隐藏压缩状态。未启用会话保持原绑定。

在仓库根目录执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Status` 可查看状态；`-Action Stop` 停止，`-Action Start` 启动，`-Action Verify` 检查运行中的连接状态。可用操作还包括 `RepairCodex`（启动页“修复 Codex 连接”）、`OpenConsole`、`OpenSnowLuma`、`EnableAutoStart`、`DisableAutoStart`。`npm start`、`npm stop`、`npm run status` 和 `npm run setup` 分别调用同一套 Windows 控制与设置脚本，保留 DPAPI 令牌处理。合上电脑、睡眠或断网会使回复暂停；关闭浏览器中的控制台页面不会停止桥接进程。

从 v0.3.0 升级前先停止 Qodex，完整备份源码、`config.json`、整个 `state/`、自定义角色及外部记忆目录。升级后单独登录，可选择迁移旧原生 Codex 会话；也可明确从新模型上下文开始，桥接历史与记忆仍保留。按[v0.4.0 升级与回退指南](docs/UPGRADE_V040.md)检查后再启动。旧版 v0.2.0 用户先参照[v0.3.0 升级指南](docs/UPGRADE_V030.md)处理记忆格式。

控制台的**全局模型与推理强度**供默认继承；某个会话可单独选择自己的组合。保存后从下一轮生效，正在处理的回复沿用本轮启动时设置；设置若被其他操作更新，会提示刷新后重试。全局速度与自动压缩阈值作用于所有会话，留空阈值使用 Codex 模型默认值。**重置当前对话上下文**会取消该会话待发送回复，保留历史、人格和长期记忆；下一条消息创建新会话，不重新注入重置前的历史。已发送到 QQ 的消息不会撤回。

修改本机 `consolePort`、`controlPort` 前仍须先用旧配置执行 `Stop`，再修改、`Start`、`Verify`。Codex 使用额度与同一 ChatGPT 账号的其他 Codex 活动共享。

## 文档与反馈

[部署](docs/DEPLOYMENT.md) · [v0.6.0 升级与回退](docs/UPGRADE_V060.md) · [鸣潮](docs/WAVES.md) · [实验性语音](docs/VOICE.md) · [配置](docs/CONFIGURATION.md) · [控制台接口](docs/CONSOLE_API.md) · [故障排查](docs/TROUBLESHOOTING.md) · [项目结构](docs/PROJECT_GUIDE.md) · [更新记录](CHANGELOG.md) · [发布配方](docs/RELEASE_V060.md) · [安全说明](SECURITY.md)

离线审计可运行 `npm test`。它不代替真实 QQ、全新 Windows 和第三方版本的端到端验证。提交问题时请移除 QQ 号、令牌、私人聊天内容和本机路径。
