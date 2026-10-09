# v0.5.0 本机控制台接口

这些接口由 Qodex 控制台使用，监听本机回环地址，不是公开的远程服务协议。请优先使用图形控制台；下表用于说明保存内容、修订冲突和备份边界。请求需通过控制台令牌鉴权；写请求须使用 `application/json`，带 `Origin` 时只接受本机同源页面。不要把令牌、完整请求或私人数据贴到 Issue 中。

| 路径与方法 | 用途与关键参数 |
| --- | --- |
| `GET /api/chat`、`GET /api/chat?key=group:10001` | 会话列表与分页历史；示例 ID 为虚构数据。 |
| `GET/POST /api/chat/models` | 获取当前账号可用模型及全局模型设置；POST 使用返回的 `revision`，提交 `model`、`reasoningEffort`，可带 `serviceTier`（`null` 标准、`priority` 加速）和 `autoCompactTokenLimit`（`null` 模型默认，或 8,000–1,000,000 token）。模型/强度从下一轮起作用于继承全局的会话；速度和压缩阈值从下一轮起作用于所有会话。 |
| `GET/POST /api/chat/settings` | 使用 `key` 读取或写入当前会话的 `patch`。`role:null` 继承、`role:false` 明确无角色、字符串选择角色；`style:null` 继承；`model:null` 继承，或填 `{model,reasoningEffort}`。`imageMode` 可为 `null/off/requested/auto`，`stickerStyle` 可为 `null/natural/lively`；`null` 继承全局。还可设置该会话 `paused`。 |
| `POST /api/chat/pause`、`POST /api/chat/cancel`、`POST /api/chat/reset` | `pause` 的 `paused` 为布尔值，省略 `key` 作用于全局；`cancel` 只请求终止当前轮并保留后来排队消息；`reset` 清除所选会话的待发送回复及模型上下文，但保留历史与记忆。 |
| `GET /api/chat/runs?key=group:10001` | 返回该会话最近的运行记录及当前排队数量。运行记录包含转发读取、生图排队与生成、模型、搜索、QQ 发送阶段及脱敏错误；每会话最多保留最近 100 轮。 |
| `GET/POST /api/chat/memory` | 每会话 schema 2 条目记忆。POST 带 `key`、整体 `revision`；`action:add/edit/restore/toggle`，编辑和恢复另带条目的 `id`、`version`，恢复带 `restoreVersion`。保留旧版整体文本编辑兼容入口。 |
| `GET/POST /api/chat/feedback` | 当前会话机器人回复的“多余”“太长”“合适”反馈；新增须引用已有机器人回复的 `messageId`（控制台历史条目 ID），撤销用 `action:"undo"` 和反馈 `id`。 |
| `GET/POST /api/chat/gallery` | 搜索表情描述、备注、标签与用途；POST 带 `id`、`disabled`、`revision`，省略 `key` 为全局禁用，指定 `key` 为该会话禁用。不会删除 QQ 收藏。 |
| `GET /api/chat/sticker-preview`、`POST /api/chat/sticker-note` | 本机图库缩略图与备注；备注写入带 `expectedNote`、`expectedSource`，避免覆盖其他已保存修改。 |
| `GET /api/chat/image-preview?key=group:10001&imageId=<UUID>` | 鉴权后读取当前会话的生成图片，返回 Base64 与 MIME；缺失文件返回 404，跨会话记录不能读取。带 `Origin` 时必须与本机控制台同源。 |
| `GET/POST /api/chat/expression` | 全局口吻、表情发送、看图学习和自动收藏开关；还可设 `imageMode`（`off/requested/auto`）和 `stickerStyle`（`natural/lively`）。POST 带当前 `revision`；缺失字段保留已有值。 |
| `GET /api/chat/backup?history=0|1` | 导出 `qq-codex-backup` v1 JSON；默认不含聊天历史，`history=1` 才包含。 |
| `POST /api/chat/backup/preview`、`POST /api/chat/backup/restore` | 预览传 `{backup:<JSON 对象>}`，返回差异与 10 分钟有效的 `id`；恢复传 `{id,sections:[...]}`，只应用选中的章节。 |

备份文件恢复成功后，`restore` 按恢复后的设置协调鸣潮策略与本部署所属服务，响应新增 `policySynced`；同步失败时为false并带脱敏 `policyError`。此时文件恢复已成功，但运行同步不完整，控制台会提示检查状态。JSON不包含、导入或开通自动任务订阅。

## 修订与冲突

会话设置、反馈、图库等共用 `state/model-preferences.json` 的**整数** `revision`。先读取，再带当前修订号写入；其他操作修改后，旧号返回 HTTP **409**，重新读取并确认差异后重试。记忆有独立的整体 `revision`，编辑/恢复已有条目还要带该条目的 `version`。全局模型和表达设置各有自己的 `revision`，由相应 GET 原样返回，写回时勿自行拼接。表情备注用当前备注文本与来源作冲突检查。备份预览之后若当前资料变化，恢复返回 409，需重新预览。无效模型、记忆文本或备份格式等一般返回 400；未授权返回 401，跨站来源被拒绝返回 403，错误响应含 `ok:false` 和 `error`。

## 记忆与备份格式

记忆文件 `schemaVersion:2`，按会话保存 `key`、`enabled`、整体 `revision` 与 `entries`。条目有 `id`、`text`、`pinned`、`enabled`、`version`、`source`、`versions` 等字段。首次读取旧格式时，会将原文件保留为 `memory.json.legacy-v1.json`，再写入新版。模型只能修改本轮检索可见、未置顶且来源可核对的普通条目。每会话有效记忆总量上限 30,000 字符；本地中文分词和 BM25 负责按需检索，置顶内容优先。

导出 JSON 的顶层为 `format:"qq-codex-backup"`、`version:1`、`createdAt` 和 `sections`。支持的章节是 `settings`、`roles`、`conversations`、`memory`、`feedback`、`stickers`、`images`、`history`、`waves`；history只有勾选历史时才出现，waves只含非敏感游戏开关。`images` 只含图片 ID、会话归属、格式、状态等元数据。可选 `history` 保留消息文字和图片编号，不包含运行记录及转发节点的展开副本；需保留这些本机状态时请备份整个部署目录。v0.3.0 备份没有新字段时，导入按 `requested`、`natural` 和分会话继承处理。导入校验会话 ID、角色名、记忆条目、图片元数据和当前账号可用模型。恢复前自动将本机快照写到 `state/restore-snapshots/`，执行中停止进行中的回复，失败时尝试回滚；有数据变化的相关空闲会话才重建模型上下文，单纯恢复表情备注、反馈或图片元数据不重置无关空闲会话。历史恢复不会重发 QQ 消息。JSON 排除本机凭据文件、Codex 登录态、图片本体与会话绑定，但可能包含私人对话、角色、记忆以及未被自动识别的敏感文本。它不能代替升级前的[完整目录备份](UPGRADE_V040.md)。

合并转发记录附在相应历史消息的 `forward` 字段中，包含已读取节点、层级、部分失败与截断标记。当前读取预算为三层、八份、一百条节点、两万字符、五张图片和十五秒；OneBot 返回展平节点时，页面会按返回顺序显示。转发内容是引用资料，不代表当前发言者或管理员授权。

## v0.5.0 增量接口

`/api/chat/expression` 新增全局 `voiceEnabled`（布尔值、公开默认false）；`/api/chat/settings` 的会话 `patch.voiceEnabled` 可为 `null/true/false`，null继承。可选历史含语音转写文字、来源元数据及失败提示，不含音频。

| 路径与方法 | 用途与边界 |
| --- | --- |
| `GET /api/waves/status` | 模块就绪、功能目录与可用性；上游未授权/未绑定提示不等于成功取得账号数据。 |
| `POST /api/waves/settings` | 全局或 `key` 指定会话游戏开关；当前值从status读取。POST带当前整数 `revision`、`enabled`（全局布尔，会话null可继承），与远程绑定启用项分离。未完整安装时开启返回409。 |
| `GET /api/waves/accounts` | 管理员的本部署绑定概要，仅显示脱敏资料，不导出账号凭据；此GET不是聊天模型接口。 |
| `GET/POST /api/waves/subscriptions` | GET为本部署订阅概要；POST带 `key`、`senderQQ`、当前 `revision` 及停用字段 `signEnabled:false` / `reminderEnabled:false`；正常授权会话可带threshold，暂停或撤权后仅接受false停用字段。暂停或撤销会话访问权限后仍可纯停用已有订阅；不能借此开通或修改有效订阅，true会拒绝。本人开通须QQ确认。 |
| `GET /api/waves/image-preview?key=group:10001&id=<结果ID>` | 鉴权读取游戏结果图片，校验会话归属和受管结果路径，禁止跨会话或任意文件读取；响应为Base64与MIME。 |

新增接口仍需控制台令牌鉴权；带Origin时只接受同源，写请求使用application/json。会话键及结果会话归属必须匹配，不能通过另一个会话的图片编号读数据。旧revision返回409，刷新后审阅差异再重试；未授权401，拒绝来源403，缺失结果404。接口不是公开登录隧道的管理协议。

设置保存响应还包括 `policySynced`，若进程/策略同步失败则附脱敏 `policyError`；已保存的设置不等于运行服务已就绪，应检查status。双区共享选择和保留草稿由控制台实现，未点击保存的草稿不写入接口状态。

备份顶层继续为 `qq-codex-backup` version:1。v0.4.0备份缺少语音字段时全局关闭、会话继承；缺少waves章节时保留当前游戏设置。游戏章节只含非敏感开关，排除账号/凭据、票据、订阅、游戏图片本体和远程绑定启用项；恢复不会开启自动签到或体力提醒。完整恢复/回退必须使用[旧数据配套快照](UPGRADE_V050.md)，而非让v0.4直接读取新版状态。
