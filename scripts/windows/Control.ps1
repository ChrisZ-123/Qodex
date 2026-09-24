param([ValidateSet('Start','Stop','Status','Verify','OpenConsole','OpenSnowLuma','EnableAutoStart','DisableAutoStart')][string]$Action='Status')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$root = Get-QodexRoot

function Get-ControlStatus([int]$Port, [string]$Token, [string]$Route = 'status') {
    $uri = "http://127.0.0.1:$Port/$Route"
    return Invoke-RestMethod -Uri $uri -Headers @{Authorization="Bearer $Token"} -TimeoutSec 2 -Method Get
}

function Show-ConsoleToken([string]$Token) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form = New-Object Windows.Forms.Form
    $form.Text = 'Qodex 控制台访问令牌'
    $form.ClientSize = New-Object Drawing.Size(650, 145)
    $form.StartPosition = 'CenterScreen'
    $form.TopMost = $true
    $label = New-Object Windows.Forms.Label
    $label.Text = '浏览器打开后，请将下面的令牌复制到登录框。'
    $label.SetBounds(15, 18, 610, 25)
    $box = New-Object Windows.Forms.TextBox
    $box.Text = $Token
    $box.ReadOnly = $true
    $box.SetBounds(15, 56, 610, 25)
    $form.Controls.AddRange(@($label, $box))
    $form.Add_Shown({ $box.Focus(); $box.SelectAll() })
    try { [void]$form.ShowDialog() }
    finally { $form.Dispose() }
}

function Get-AutoStartShortcut {
    return (Join-Path ([Environment]::GetFolderPath('Startup')) 'Qodex.lnk')
}

function Get-AutoStartArguments {
    $controlPath = Join-Path $root 'scripts\windows\Control.ps1'
    return ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $controlPath + '" -Action Start')
}

function Assert-OwnShortcut([string]$Shortcut) {
    if (-not (Test-Path -LiteralPath $Shortcut -PathType Leaf)) { return }
    $shell = New-Object -ComObject WScript.Shell
    $existing = $shell.CreateShortcut($Shortcut)
    $powershell = Join-Path $PSHOME 'powershell.exe'
    if ($existing.TargetPath -ine $powershell -or $existing.Arguments -ne (Get-AutoStartArguments)) {
        throw '启动文件夹已有同名但不属于本 Qodex 安装的快捷方式；没有修改它。'
    }
}

try {
    $config = Read-QodexConfig $root
    $secrets = Unprotect-QodexSecretObject $root
    $controlPort = Assert-QodexPort $config.controlPort '控制服务'
    $consolePort = Assert-QodexPort $config.consolePort '控制台'
    if ($Action -eq 'EnableAutoStart' -or $Action -eq 'DisableAutoStart') {
        $shortcut = Get-AutoStartShortcut
        Assert-OwnShortcut $shortcut
        if ($Action -eq 'EnableAutoStart') {
            $shell = New-Object -ComObject WScript.Shell
            $entry = $shell.CreateShortcut($shortcut)
            $entry.TargetPath = Join-Path $PSHOME 'powershell.exe'
            $entry.Arguments = Get-AutoStartArguments
            $entry.WorkingDirectory = $root
            $entry.Description = 'Start this Qodex installation at sign-in'
            $entry.Save()
            Write-Output '已为当前 Windows 用户启用登录时启动。'
        } else {
            if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
            Write-Output '已关闭当前 Windows 用户的 Qodex 登录时启动。'
        }
        exit 0
    }
    if ($Action -eq 'OpenSnowLuma') {
        Start-Process -FilePath ([string]$config.snowluma.webUiUrl)
        Write-Output '已打开 SnowLuma 本机页面。'
        exit 0
    }
    if ($Action -eq 'OpenConsole') {
        Start-Process -FilePath "http://127.0.0.1:$consolePort/"
        Show-ConsoleToken ([string]$secrets.console)
        Write-Output '已打开 Qodex 控制台。'
        exit 0
    }
    if ($Action -eq 'Start') {
        Assert-QodexConfig $config
        $node = Get-QodexNode
        $exe = Get-QodexCodexExe ([string]$config.codex.exe)
        if (Test-QodexPortOpen $controlPort) {
            try { $status = Get-ControlStatus $controlPort $secrets.control }
            catch { throw '控制服务端口已被其他服务占用，或认证失败；未启动第二个实例。' }
            if ($status.startupError) { throw ("现有 Qodex 控制服务报告启动失败：{0}。请先停止它。" -f $status.startupError) }
            Write-Output ($status | ConvertTo-Json -Compress -Depth 8)
            exit 0
        }
        if (Test-QodexPortOpen $consolePort) { throw '控制台端口已被其他服务占用；未启动桥接。' }
        $previous = @{onebot=$env:QBOT_ONEBOT_TOKEN;console=$env:QBOT_CONSOLE_TOKEN;control=$env:QBOT_CONTROL_TOKEN;codex=$env:QBOT_CODEX_EXE}
        $env:QBOT_ONEBOT_TOKEN = [string]$secrets.onebot
        $env:QBOT_CONSOLE_TOKEN = [string]$secrets.console
        $env:QBOT_CONTROL_TOKEN = [string]$secrets.control
        $env:QBOT_CODEX_EXE = $exe
        try {
            $info = New-Object Diagnostics.ProcessStartInfo
            $info.FileName = $node
            $info.Arguments = '"' + (Join-Path $root 'scripts\windows\supervisor.mjs') + '"'
            $info.WorkingDirectory = $root
            $info.UseShellExecute = $true
            $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
            $process = [Diagnostics.Process]::Start($info)
            if (-not $process) { throw '无法启动 Qodex 控制进程。' }
        } finally {
            $env:QBOT_ONEBOT_TOKEN = $previous.onebot
            $env:QBOT_CONSOLE_TOKEN = $previous.console
            $env:QBOT_CONTROL_TOKEN = $previous.control
            $env:QBOT_CODEX_EXE = $previous.codex
        }
        try {
            for ($i = 0; $i -lt 300; $i++) {
                if ($process.HasExited) { throw "Qodex 控制进程已退出（代码 $($process.ExitCode)）；请查看 logs/windows-supervisor.log。" }
                if (Test-QodexPortOpen $controlPort) {
                    try { $status = Get-ControlStatus $controlPort $secrets.control }
                    catch { throw '控制服务端口被占用，但不能用本安装密钥认证；未连接外部进程。' }
                    if ($status.startupError) { throw ("Qodex 启动失败：{0}" -f $status.startupError) }
                    if ($status.services.bridge.running -and $status.bridgeReady -and $status.modelReady) {
                        Write-Output ($status | ConvertTo-Json -Compress -Depth 8)
                        exit 0
                    }
                }
                Start-Sleep -Milliseconds 100
            }
            try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:$controlPort/stop" -Method Post -Headers @{Authorization="Bearer $($secrets.control)"} -TimeoutSec 5 } catch {}
            throw 'Qodex 模型在 30 秒内未就绪，已请求停止；请检查 Codex 登录、模型权限和 logs/windows-supervisor.log。'
        } finally { $process.Dispose() }
    }
    if (-not (Test-QodexPortOpen $controlPort)) {
        Write-Output '{"running":false}'
        exit 0
    }
    try {
        if ($Action -eq 'Stop') {
            $result = Invoke-RestMethod -Uri "http://127.0.0.1:$controlPort/stop" -Method Post -Headers @{Authorization="Bearer $($secrets.control)"} -TimeoutSec 5
            for ($i = 0; $i -lt 150; $i++) {
                if (-not (Test-QodexPortOpen $controlPort)) { break }
                Start-Sleep -Milliseconds 100
            }
            if (Test-QodexPortOpen $controlPort) { throw '停止超时；控制服务仍在监听，请查看本地日志。' }
        } else {
            $route = if ($Action -eq 'Verify') { 'verify' } else { 'status' }
            $result = Get-ControlStatus $controlPort $secrets.control $route
        }
    } catch { throw '本机控制服务认证失败或不可用；未操作外部进程。' }
    Write-Output ($result | ConvertTo-Json -Compress -Depth 8)
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
