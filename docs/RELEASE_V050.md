# v0.5.0 发布配方

基线：公开 v0.4.0 / `09e7f3e`。发布源应保留 qq-bridge fork 来源和根目录无明确继承许可的说明，不宣称整仓已改为 GPL。鸣潮 Python 适配器与派生补丁位于 `integrations/waves`，按该范围的 GPL-3.0 声明、完整 LICENSE 和来源说明发布。固定来源如下，与安装 manifest 保持一致：

组合审查按实际实现记录：Python直接导入上游core/plugin，全部适配源码、安装器、补丁及测试在 `integrations/waves`；Node不导入/链接Python模块，不共享内存对象或游戏账号库，使用独立本机认证HTTP服务交换指令、输入和可展示结果。基础群聊不需要Python服务，该服务可独立运行。不能仅以分进程作为GPL豁免理由；发布需保留完整对应源码与许可证，并核对 [GNU GPL FAQ 的组合关系说明](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)，不改变继承仓库根目录的授权现状。

| 项目 | 固定提交 | 许可 |
| --- | --- | --- |
| [Genshin-bots/gsuid_core](https://github.com/Genshin-bots/gsuid_core) | `fb80b874533c23b565a74ebd8549ce09e4742a55` | GPL-3.0 |
| [Loping151/XutheringWavesUID](https://github.com/Loping151/XutheringWavesUID) | `5c9d9aec5c3f8bd0fc819b543f40fda25e8b1aaf` | GPL-3.0 |
| [Loping151/RoverSign](https://github.com/Loping151/RoverSign) | `97cccaa5afeab3661e2a3901145869ed3f7a4ec8` | GPL-3.0 |
| [Loping151/RoverReminder](https://github.com/Loping151/RoverReminder) | `05c100179ee33feae54779fea44a131535addb31` | GPL-3.0 |
| [Loping151/ScoreEcho](https://github.com/Loping151/ScoreEcho) | `9a15321c0c37e56d89cf14d821067ee70508f4b7` | GPL-3.0 |

1. 从已审阅候选源码创建干净目录，不复制 `config.json`、`state/`、本地日志、依赖、游戏素材、二进制或测试输出。核对 `.gitignore` 与实际归档列表。
2. 运行 `npm ci`、`npm test` 和适配器对应 Python 隔离测试；实际结果、环境与未验项目写入[验证记录](VALIDATION.md)，不能引用内部旧部署31/31作为此候选通过记录。
3. 在中文/空格的新目录验证Windows设置与运行入口；可选游戏安装器使用 Python3.11 x64，从官方/作者固定源码下载。核对默认游戏/语音/远程登录关闭、账号库DPAPI、来源与LICENSE保留。
4. 以虚构数据检查双区共享选择、草稿、语音失败提示及游戏状态，使用 `assets/qodex-chat-v050.png`、`assets/qodex-waves-v050.png`、`assets/qodex-voice-v050.png`；说明这些是合成示意，不是账号绑定/真实发送证明。
5. 审查公开增量不包含号码、凭据、私人聊天、机器路径或生产状态；只在实际审阅和验证后创建版本标签与发布内容。

游戏资源从作者说明的来源按需下载，QQ、Codex、Python、浏览器与 cloudflared 从官方来源安装，不在公开仓库捆绑。本机运行文件归入 `state/waves/{core,venv,data,inputs,results,browsers}`；独立 Codex、生图、记忆原目录保留。第三方许可与资产权利按各自来源核实，参阅[第三方说明](../THIRD_PARTY_NOTICES.md)。
