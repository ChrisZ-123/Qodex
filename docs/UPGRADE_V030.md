# 从 v0.2.0 升级到 v0.3.0

本次升级把长期记忆从旧版整段文本转换为 **schema 2 条目**。请在同一台 Windows 电脑、同一 Windows 用户下完成升级；先停止 Qodex 并备份旧版源码与数据。旧版程序不能直接读取转换后的记忆，回退时须把**旧版程序与升级前的数据一起恢复**。

## 1. 停止并备份

在现有 Qodex 仓库根目录打开 PowerShell，确认这是正在使用的部署，再执行：

```powershell
$install = (Resolve-Path .).Path
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Stop
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Status
$backup = Join-Path (Split-Path $install -Parent) ("Qodex-v020-backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $backup) { throw "备份目录已存在：$backup" }
Copy-Item -LiteralPath $install -Destination $backup -Recurse -Force -ErrorAction Stop
if (-not (Test-Path -LiteralPath (Join-Path $backup 'config.json'))) { throw '备份缺少 config.json' }
if (-not (Test-Path -LiteralPath (Join-Path $backup 'state'))) { throw '备份缺少 state 目录' }
Write-Host "旧版完整部署备份：$backup"
```

完整目录副本保留旧源码、`config.json`、`state/`、自定义 `roles/` 和 DPAPI 文件。备份应放在安装目录**外面**，不要上传 GitHub 或发送给他人。若 `config.json` 的 `chatMemory.directory` 是仓库外的绝对目录，或相对路径解析后位于仓库外，还须单独复制该**整个目录**并记录其原路径；默认 `state/chat-memory` 已在上述目录副本中。备份完成后先检查复制结果，再继续更新。DPAPI 文件在原 Windows 用户环境中才可正常使用，跨电脑迁移应重新配置凭据。

控制台导出的 JSON 可以额外保留设置、角色、记忆与修订、反馈、表情备注，以及可选历史；它**不是完整回退镜像**，不包含 DPAPI 凭据文件、Codex 登录态、表情图片本体和所有运行文件，也不会替代上面的目录副本。文本虽经过已知模式脱敏，仍可能含私人资料或未识别的凭据。

## 2. 更新到固定版本

先确认没有自己修改过仓库中被 Git 跟踪的文件；如有改动，保留备份并审阅差异，不要强制重置。然后在原安装目录执行：

```powershell
git status --short
git fetch --tags origin
git switch --detach qodex-v0.3.0
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Start
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Verify
```

`git switch --detach` 固定到本次 Release 对应的源码，不会删除忽略的本地 `config.json` 和 `state/`。若切换或依赖安装失败，停止在当前状态，不要清理数据；按下文恢复完整备份。升级不会修改官方 Codex 登录资料。

## 3. 检查首次迁移

打开本机控制台，确认群/私聊白名单、全局模型与速度、分会话历史和暂停状态仍正确。选择一个升级前有长期记忆的会话，打开“条目记忆”，检查内容和有效状态；首次读取该会话时，程序会在原位置保留 `memory.json.legacy-v1.json`，再生成 schema 2 的 `memory.json`。迁移在各会话首次读取时发生，因此只打开一个会话不能证明所有会话均已迁移。

再检查“当前会话独立设置”的继承状态、图库和运行记录。使用隔离或你自行选择的测试会话核对下一轮设置生效；不必向真实群群发验收消息。若有外部 `chatMemory.directory`，确认 Qodex 读取的仍是配置指定的目录。旧聊天历史及记忆不会因为重置上下文而删除；恢复 JSON 备份也不会重发历史消息。

## 4. 回退到 v0.2.0

如必须回退，先用新版 `Control.ps1 -Action Stop` 停止进程。把当前安装目录作为故障留档移开，再将**步骤 1 的完整旧版部署副本**复制回原安装路径；若记忆目录在部署外，也把它的升级前副本恢复到原路径。不要仅切换 Git 标签并继续使用已经转换的 `state/chat-memory`：v0.2.0 不能读取 schema 2。旧版目录和旧数据必须来自**同一次升级前备份**，不要把两版的 `state/` 混合覆盖。

回到原 Windows 用户后，用恢复目录中的 `Control.ps1 -Action Start` 和 `-Action Verify` 检查。若没有完整旧版副本，先停止旧版启动尝试，保留现有数据并寻求帮助；单个 `.legacy-v1.json` 或控制台 JSON 不能保证恢复整个部署的旧状态。

常见故障见[故障排查](TROUBLESHOOTING.md)，控制台数据格式与冲突响应见[接口说明](CONSOLE_API.md)。
