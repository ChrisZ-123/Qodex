# v0.6.0 发布配方

日期：2026-10-20。公开基线为 `qodex-v0.5.0` / `aab466b`，目标标签 `qodex-v0.6.0`。交付为原生源码，不含 EXE、第三方二进制、游戏素材、私人配置、凭据或生产数据。`Install.bat` 是引导入口，不是捆绑安装包；全局软件缺失时提示官方渠道，QQ/Codex/玩家登录需本人完成。

保留 qq-bridge fork 来源与继承根目录无明确 LICENSE 的说明；不宣称整仓 GPL。鸣潮 Python 适配器、安装器、派生补丁及对应测试在 `integrations/waves` 的 GPL-3.0 范围，保留完整对应源码、LICENSE 与作者署名。Node 通过独立鉴权本机 HTTP 交换指令和可展示结果，不直接导入 Python 模块或读取游戏账号库；分进程本身不构成 GPL 豁免。范围与权利来源见[第三方说明](../THIRD_PARTY_NOTICES.md)。五个固定来源与 manifest 核对：

| 项目 | 固定提交 | 许可 |
| --- | --- | --- |
| [Genshin-bots/gsuid_core](https://github.com/Genshin-bots/gsuid_core) | `fb80b874533c23b565a74ebd8549ce09e4742a55` | GPL-3.0 |
| [Loping151/XutheringWavesUID](https://github.com/Loping151/XutheringWavesUID) | `5c9d9aec5c3f8bd0fc819b543f40fda25e8b1aaf` | GPL-3.0 |
| [Loping151/RoverSign](https://github.com/Loping151/RoverSign) | `97cccaa5afeab3661e2a3901145869ed3f7a4ec8` | GPL-3.0 |
| [Loping151/RoverReminder](https://github.com/Loping151/RoverReminder) | `05c100179ee33feae54779fea44a131535addb31` | GPL-3.0 |
| [Loping151/ScoreEcho](https://github.com/Loping151/ScoreEcho) | `9a15321c0c37e56d89cf14d821067ee70508f4b7` | GPL-3.0 |


1. 从审阅候选创建干净源码归档；检查实际清单，排除 `config.json`、`state/`、`node_modules`、本机日志、测试输出、账号库、素材与凭据。私有路径和真实身份不得从参考部署文档复制进来。
2. 运行候选的 Node 回归、Windows 部署检查、适配器隔离测试，分别记录命令、环境、通过/失败与范围。完整上游套件若发生依赖/收集失败必须如实记录，不能把测试未执行当作通过。
3. 在中文/空格路径检查 Install、独立登录、Setup、启动/状态/验证及修复入口。修复只管理本部署所属桥接/Codex，保留 QQ、鸣潮与隧道；验证停止竞争、端口归属和代理子进程边界。
4. 用虚构数据生成 `assets/qodex-replies-v060.png`、`qodex-memory-v060.png`、`qodex-waves-v060.png`、`qodex-models-v060.png`，检查有序回复/部分结果、记忆元数据/修订、作者授权状态、模型失败恢复和全局人格入口。截图是界面示意，不是实际 QQ/SMS/服务成功证明。
5. 核对公开默认：自然回复、仅明确请求生图、自然表情、标准速度，游戏/远程绑定/实验性语音关闭；不复制本地私人模型、压缩阈值、角色或访问名单。
6. 核对一次绑定、多群使用契约：同QQ/同机器人确认绑定后可在其他已加入且允许鸣潮的群查询本人账号；每群访问、游戏开关和暂停仍检查，记忆/任务订阅不跨会话合并，不得借用其他QQ或独立机器人绑定。绑定确认仍限原申请会话，凭据过期/撤销可要求重新登录。此契约说明不冒充新增真实跨群验收。
7. 将本候选真实结果写入[验证记录](VALIDATION.md)。用户反馈“鸣潮可用”、旧部署历史 142 项隔离测试、当前候选回归与真实 QQ/官方服务测试必须分别标明，不能互相替代。只有实际完成的检查才能写成通过。
8. 审阅最终差异与归档后创建标签和发布记录；升级与回退引用[配套指南](UPGRADE_V060.md)。

运行状态继续归入本部署 `state/waves/{core,venv,data,inputs,results,browsers}`，独立 Codex、生图、记忆原目录保留。QQ、Codex、Python、浏览器及可选 cloudflared 均由各自官方来源提供，作者资源按原说明下载，来源许可分别适用。
