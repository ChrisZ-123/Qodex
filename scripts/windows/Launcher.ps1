param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$root = Get-QodexRoot
$config = Read-QodexConfig $root
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object Windows.Forms.Form
$form.Text = 'Qodex'
$form.ClientSize = New-Object Drawing.Size(760, 510)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
$form.BackColor = [Drawing.Color]::FromArgb(245, 247, 250)
$title = New-Object Windows.Forms.Label
$title.Text = 'Qodex 本机管理'
$title.Font = New-Object Drawing.Font('Microsoft YaHei UI', 18, [Drawing.FontStyle]::Bold)
$title.SetBounds(25, 18, 700, 42)
$form.Controls.Add($title)
$subtitle = New-Object Windows.Forms.Label
$subtitle.Text = "模型：$($config.codex.model) / $($config.codex.reasoningEffort)    控制台：127.0.0.1:$($config.consolePort)"
$subtitle.SetBounds(27, 67, 705, 25)
$form.Controls.Add($subtitle)
$script:outputBox = New-Object Windows.Forms.TextBox
$script:outputBox.Multiline = $true
$script:outputBox.ReadOnly = $true
$script:outputBox.ScrollBars = 'Vertical'
$script:outputBox.SetBounds(25, 264, 710, 189)
$script:outputBox.Text = '请先确认 SnowLuma 已登录 QQ，且 OneBot HTTP 与 WebSocket 已在本机启用。'
$form.Controls.Add($script:outputBox)
$note = New-Object Windows.Forms.Label
$note.Text = '关闭此窗口不会停止 Qodex。登录时自启只影响当前 Windows 用户。'
$note.SetBounds(25, 470, 710, 25)
$form.Controls.Add($note)
$script:worker = $null
$script:workerAction = ''
$script:buttons = @()

function Start-ControlAction([string]$Action) {
    if ($script:worker) { return }
    if ($Action -eq 'InstallWavesRemote') {
        $answer = [Windows.Forms.MessageBox]::Show('配置后，小游戏启用期间的本机 Waves 登录端口会通过 Cloudflare 公共 HTTPS 地址开放，用于账号登录和二维码。不会公开聊天控制台或 RPC。是否继续下载已校验的官方隧道程序？', '配置 Waves 远程登录', [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Warning)
        if ($answer -ne [Windows.Forms.DialogResult]::Yes) { return }
    }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $PSHOME 'powershell.exe'
    if ($Action -eq 'LoginCodex') {
        $info.Arguments = '-NoProfile -ExecutionPolicy Bypass -STA -File "' + (Join-Path $root 'scripts\windows\Login-Codex.ps1') + '"'
        $info.UseShellExecute = $true
        $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
        $info.WorkingDirectory = $root
        $script:worker = [Diagnostics.Process]::Start($info)
        $script:workerAction = $Action
        foreach ($button in $script:buttons) { $button.Enabled = $false }
        $script:outputBox.Text = '已打开独立 Codex 登录窗口。请在该窗口中完成官方登录，然后回到这里检查状态。'
        return
    } elseif ($Action -in @('InstallWaves','InstallWavesRemote')) {
        $info.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $root 'scripts\windows\Install-Waves.ps1') + '"'
        if ($Action -eq 'InstallWavesRemote') { $info.Arguments += ' -RemoteLogin' }
    } else {
        $info.Arguments = '-NoProfile -ExecutionPolicy Bypass -STA -File "' + (Join-Path $root 'scripts\windows\Control.ps1') + '" -Action ' + $Action
    }
    $info.WorkingDirectory = $root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $script:worker = [Diagnostics.Process]::Start($info)
    $script:workerAction = $Action
    foreach ($button in $script:buttons) { $button.Enabled = $false }
    $script:outputBox.Text = '正在执行，请稍候……'
}

$entries = @(
    @('启动 Qodex', 'Start'), @('停止 Qodex', 'Stop'), @('检查状态', 'Status'), @('验证连接', 'Verify'),
    @('打开控制台', 'OpenConsole'), @('打开 SnowLuma', 'OpenSnowLuma'), @('启用登录自启', 'EnableAutoStart'), @('关闭登录自启', 'DisableAutoStart'),
    @('登录 Codex（独立）', 'LoginCodex'), @('安装 Waves', 'InstallWaves'), @('配置 Waves 远程登录', 'InstallWavesRemote')
)
for ($i = 0; $i -lt $entries.Count; $i++) {
    $button = New-Object Windows.Forms.Button
    $button.Text = $entries[$i][0]
    $button.Tag = $entries[$i][1]
    $button.SetBounds((25 + ($i % 4) * 180), (105 + [math]::Floor($i / 4) * 48), 169, 38)
    $button.Add_Click({ param($sender, $eventArgs) Start-ControlAction ([string]$sender.Tag) })
    $script:buttons += $button
    $form.Controls.Add($button)
}
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
    if (-not $script:worker -or -not $script:worker.HasExited) { return }
    if ($script:workerAction -eq 'LoginCodex') {
        $script:outputBox.Text = if ($script:worker.ExitCode -eq 0) { '独立 Codex 登录已完成。请单击“验证连接”检查本部署账号与模型。' } else { '独立 Codex 登录未完成。可再次登录，或在终端运行 Login-Codex.ps1 查看提示。' }
        $script:worker.Dispose()
        $script:worker = $null
        foreach ($button in $script:buttons) { $button.Enabled = $true }
        return
    }
    $out = $script:worker.StandardOutput.ReadToEnd().Trim()
    $err = $script:worker.StandardError.ReadToEnd().Trim()
    if ($script:worker.ExitCode -eq 0) {
        if ($script:workerAction -eq 'Stop') {
            $script:outputBox.Text = 'Qodex 已停止。'
        }
        elseif ($script:workerAction -in @('Status', 'Verify', 'Start')) {
            try {
                $data = $out | ConvertFrom-Json
                $lines = @(
                    "运行：$($data.running)", "模型：$($data.model) / $($data.reasoningEffort)",
                    "桥接可用：$($data.bridgeReady)", "模型就绪：$($data.modelReady)"
                )
                if ($script:workerAction -eq 'Verify') { $lines += "QQ 在线：$($data.qqOnline)" }
                if ($data.startupError) { $lines += "启动错误：$($data.startupError)" }
                if ($data.waves) {
                    $lines += "小游戏：已安装=$($data.waves.installed) / 已启用=$($data.waves.enabled) / 就绪=$($data.waves.ready)"
                    $lines += "远程登录：已配置=$($data.waves.remoteLoginEnabled) / 就绪=$($data.waves.remoteReady)"
                    if ($data.waves.error) { $lines += "小游戏错误：$($data.waves.error)" }
                }
                $script:outputBox.Text = $lines -join "`r`n"
            } catch { $script:outputBox.Text = $out }
        } else { $script:outputBox.Text = $out }
    } else {
        $script:outputBox.Text = if ($err) { $err } else { '操作失败。请检查本地配置和 logs/windows-supervisor.log。' }
    }
    $script:worker.Dispose()
    $script:worker = $null
    foreach ($button in $script:buttons) { $button.Enabled = $true }
})
$timer.Start()
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose(); if ($script:worker) { $script:worker.Dispose() } })
if ($ValidateOnly) {
    Write-Output "Launcher validated: $($script:buttons.Count) actions"
    $timer.Stop(); $timer.Dispose(); $form.Dispose()
    exit 0
}
[void]$form.ShowDialog()
