param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$root = Get-QodexRoot
try {
    $node = Get-QodexNode
    $configured = ''
    if (Test-Path -LiteralPath (Join-Path $root 'config.json') -PathType Leaf) {
        $config = Read-QodexConfig $root
        if (Test-QodexPortOpen (Assert-QodexPort $config.controlPort '控制服务')) { throw '请先停止本部署，再登录独立 Codex。' }
        $configured = [string]$config.codex.exe
    }
    if ($configured) { $exe = Get-QodexCodexExe $configured }
    else {
        try { $exe = Get-QodexCodexExe }
        catch {
            if ($Quiet) { throw '未找到原生 codex.exe，请在终端运行 Login-Codex.ps1 并输入完整路径。' }
            $exe = Get-QodexCodexExe (Read-Host '原生 codex.exe 完整路径')
        }
    }
    $previousExe = $env:QBOT_CODEX_EXE
    $previousQuiet = $env:QODEX_LOGIN_QUIET
    try {
        $env:QBOT_CODEX_EXE = $exe
        $env:QODEX_LOGIN_QUIET = if ($Quiet) { '1' } else { '0' }
        & $node (Join-Path $root 'scripts\windows\login-codex.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Codex 登录未完成。' }
    } finally {
        $env:QBOT_CODEX_EXE = $previousExe
        $env:QODEX_LOGIN_QUIET = $previousQuiet
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
