# 来源与第三方说明

Qodex 是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的公开 fork，首个预览版以该仓库提交 [`dea3ce8`](https://github.com/Derpyu520/qq-bridge/commit/dea3ce8) 为基础，并保留其来源署名。该上游提交未提供明确的根目录 `LICENSE` 文件；本仓库也不以某个通用开源许可证为继承代码作出再授权声明。

[GitHub 关于仓库许可的说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)区分了平台允许的查看与 fork，以及对复制、修改和再分发提供授权的许可证。**公开可见或可 fork 不等于已获通用再分发许可。** 对本仓库代码、继承素材或衍生版本的外部复用，请自行核实权利来源并保留原作者署名。此文件不是法律意见。

Qodex 依赖或连接以下独立项目：

| 项目 | 关系与来源 |
| --- | --- |
| [SnowLuma](https://github.com/SnowLuma/SnowLuma) | QQ/OneBot 网关，由用户从[官方发布页](https://github.com/SnowLuma/SnowLuma/releases/latest)单独安装、阅读其发布说明和适用条款并登录。Qodex 不捆绑其可执行文件。 |
| [OpenAI Codex](https://developers.openai.com/codex/cli) | 使用用户单独安装并登录的 Codex CLI；Qodex 不捆绑 Codex 或代为接受其条款。 |
| [Node.js](https://nodejs.org/) 与 npm 包 | 运行时与 `package-lock.json` 锁定的依赖。各包遵循各自的许可与声明；此文档不将它们统一标注为同一种许可证。 |
| QQ / OneBot | Qodex 通过 SnowLuma 的 OneBot 接口与 QQ 交互。Qodex 与腾讯 QQ 没有官方关系。 |

仓库内继承的素材同样应按其实际来源和授权核查；不要假定代码许可自动覆盖图片、视频或第三方标识。若你发现应补充的来源或权利信息，请按[贡献指南](CONTRIBUTING.md)提出，并给出可核验的依据。

## v0.5.0 可选鸣潮来源

鸣潮整合基于以下固定提交。安装器从作者/官方源码下载并保留其来源、LICENSE与适用声明；本仓库不捆绑其运行环境、第三方二进制或游戏资源。

| 来源 | 固定提交 | 源码许可 |
| --- | --- | --- |
| [Genshin-bots/gsuid_core](https://github.com/Genshin-bots/gsuid_core) | `fb80b874533c23b565a74ebd8549ce09e4742a55` | GPL-3.0 |
| [Loping151/XutheringWavesUID](https://github.com/Loping151/XutheringWavesUID) | `5c9d9aec5c3f8bd0fc819b543f40fda25e8b1aaf` | GPL-3.0 |
| [Loping151/RoverSign](https://github.com/Loping151/RoverSign) | `97cccaa5afeab3661e2a3901145869ed3f7a4ec8` | GPL-3.0 |
| [Loping151/RoverReminder](https://github.com/Loping151/RoverReminder) | `05c100179ee33feae54779fea44a131535addb31` | GPL-3.0 |
| [Loping151/ScoreEcho](https://github.com/Loping151/ScoreEcho) | `9a15321c0c37e56d89cf14d821067ee70508f4b7` | GPL-3.0 |

`integrations/waves` 的 Python 适配器和派生补丁按该目录 GPL-3.0 声明提供，须保留完整许可证、原作者署名和对应源码。**这项范围声明不改变继承 qq-bridge 代码的根目录许可现状，也不宣称整仓 GPL 再授权。** 固定来源与构建/下载步骤见[发布配方](docs/RELEASE_V050.md)。

### 当前组合关系与授权范围

Python 适配服务直接导入 gsuid_core 和上述插件；适配器、安装器、上游源码补丁及对应测试均在 `integrations/waves` 的 GPL-3.0 范围内，发布时保留完整对应源码、许可证和署名。Node 桥接不导入或链接这些 Python 模块，不共享内存对象，也不直接读取游戏账号数据库；双方通过独立、需本机鉴权的 HTTP 服务交换指令、输入及可展示的结果。基础群聊无需安装该服务，Python 服务也可按其入口独立运行。

这是对当前实现与发布范围的说明，不能单凭“分进程”推导 GPL 不适用。组合关系与分发义务还取决于实际通信方式、耦合及衍生关系，参阅 [GNU GPL FAQ 关于聚合与组合程序](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)。本仓库不借此替继承代码添加整仓授权，外部复用仍须核实各部分权利来源。

游戏图片、字体、标识等资源应按作者资源说明与其实际权利来源核实，不假定 GPL 源码许可覆盖全部资产。Python及其依赖、Playwright浏览器、Cloudflare `cloudflared` 等各自适用许可和条款独立保留；cloudflared仅在用户明确启用远程绑定时使用官方来源安装。QQ语音读取依赖SnowLuma与QQ原生转写，不包含另一家识别模型或API。
