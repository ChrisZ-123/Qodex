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
