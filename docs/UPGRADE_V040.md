# 从 v0.3.0 升级到 v0.4.0

本指南面向 Windows 上的 `qodex-v0.3.0` 安装。v0.4.0 将机器人 Codex 登录和原生会话隔离到本部署 `state/codex-home`，新增生图、合并转发与控制台设置。现有 `config.json`、白名单、人格、桥接历史、条目记忆和已保存的表达设置不会自动重写。新字段缺失时，生图默认仅响应明确请求，表情默认自然适量。

## 停止并备份

在旧 Qodex 目录中执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Stop
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Status
```

确认 `running:false`。将**整个旧部署目录**复制到一个新的备份目录，包括 Git 工作树、`config.json`、`state/`、自定义 `roles/` 和 DPAPI 文件；若 `chatMemory.directory` 指向仓库外，再单独备份该目录。备份目录不要与当前目录重名，不要覆盖已有文件。此完整副本用于回退，控制台 JSON 不能代替它。把包含聊天、记忆和凭据的备份当作私人数据保管。

## 更新源码、依赖和独立登录

仍在原部署目录中确认 `git status` 没有待处理的本地源码修改，再执行：

```powershell
git fetch origin --tags
git switch --detach qodex-v0.4.0
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Login-Codex.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1
```

登录脚本调用官方 `codex.exe login`，以本部署的 `state/codex-home` 保存登录状态；它不会复制桌面端或旧目录中的登录凭据。`Setup.ps1` 验证原有配置及账号可用模型，不覆盖 `config.json`。若提示模型不可用，先在官方账号中确认权限，再通过本机配置或控制台选择明确可用的模型，不自动降级。`git switch` 因本地修改失败时先检查差异，不强制重置源码或状态。

## 选择旧原生会话的处理方式

**继续旧模型上下文：** 找到旧版本实际使用的 Codex home，通常是当时 Windows 用户的 `$env:USERPROFILE\.codex`；若旧进程设置过 `CODEX_HOME`，使用那个目录。在 Qodex **停止**状态下先预检，再明确执行迁移：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Migrate-CodexSessions.ps1 -SourceHome "$env:USERPROFILE\.codex"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Migrate-CodexSessions.ps1 -SourceHome "$env:USERPROFILE\.codex" -Apply
```

预检只按 `state/model-chat` 中当前机器人会话的 ID 查找旧原生记录；找不到、重复匹配、目标同名或外部路径映射都会拒绝。`-Apply` 再次验证独立账号，先在 `state/upgrade-snapshots/` 保存会话映射和桥接会话状态，随后复制匹配的原生记录，最后更新 `state/codex-sessions.json`。源文件和登录凭据不删除、不复制；重复执行已完成的迁移不会重复写入。失败时原映射保持或恢复，检查错误后重新预检。迁移快照和目标记录都是私人运行数据，不要提交到 Git。

**从新模型上下文开始：** 跳过迁移，启动后在控制台逐个选择已有会话，使用“重置当前对话上下文”，再发送新消息。此操作保留桥接历史、人格、长期记忆与其他会话，旧原生模型上下文不会进入新回合。已发送到 QQ 的消息不会撤回。

## 启动与核对

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Start
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Control.ps1 -Action Verify
```

检查 QQ 与模型状态、白名单、模型/强度、各会话历史和记忆。控制台分别查看全局与会话的 `imageMode`、`stickerStyle`；先前明确保存的值继续有效。生成图片位于 `state/generated-images`，控制台 JSON 仅保存元数据；旧备份缺少这两个设置时按 `requested`、`natural` 和分会话继承读取。首次在真实群使用请由群管理员自己发消息验收，离线测试不向真实群发送。

## 回退

先在 v0.4.0 部署执行 `Control.ps1 -Action Stop`，确认已停止，再进入此前保存的**完整 v0.3.0 副本**启动旧版。旧副本持有升级前的 `config.json` 和 `state/`，其会话映射仍指向升级前的环境；不要让两个副本同时运行相同端口或连接同一个机器人。v0.4.0 期间新增的历史、图片和设置不会自动合并回旧副本；如需保存，先单独备份新版完整目录。不要用 v0.3.0 读取或覆盖 v0.4.0 的新状态。回退后按旧版指南检查，重新升级时从备份和预检开始。
