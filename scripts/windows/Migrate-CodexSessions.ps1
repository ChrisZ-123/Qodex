param([Parameter(Mandatory=$true)][string]$SourceHome, [switch]$Apply)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$root = Get-QodexRoot
try {
    $config = Read-QodexConfig $root
    if (Test-QodexPortOpen (Assert-QodexPort $config.controlPort '控制服务')) { throw '请先停止本部署，再迁移旧模型会话。' }
    $node = Get-QodexNode
    $migrationArgs = @((Join-Path $root 'scripts\windows\migrate-codex-sessions.mjs'),'--source-home',[IO.Path]::GetFullPath($SourceHome))
    if ($Apply) { $migrationArgs += '--apply' }
    & $node @migrationArgs
    if ($LASTEXITCODE -ne 0) { throw '会话迁移未完成；请查看上方错误。' }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
