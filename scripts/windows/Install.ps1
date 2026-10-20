param([switch]$NoLaunch, [switch]$PauseOnError)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$root = Get-QodexRoot

function Get-QodexNpmCli([string]$Node) {
    $candidates = @((Join-Path ([IO.Path]::GetDirectoryName($Node)) 'node_modules\npm\bin\npm-cli.js'))
    $command = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { $candidates += Join-Path ([IO.Path]::GetDirectoryName($command.Source)) 'node_modules\npm\bin\npm-cli.js' }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw '未找到随 Node.js 安装的 npm。请从 https://nodejs.org/en/download 安装 Node.js 24 或更新版本，并重新打开 Install.bat。'
}

function Install-QodexDependencies([string]$Node, [string]$Npm, [string]$Root) {
    Push-Location -LiteralPath $Root
    try {
        if (Test-Path -LiteralPath (Join-Path $Root 'node_modules') -PathType Container) {
            $null = & $Node $Npm ls --omit=dev --depth=0 2>$null
            if ($LASTEXITCODE -eq 0) { Write-Host '项目依赖已就绪，跳过 npm ci。'; return }
        }
        Write-Host '正在安装锁定的项目依赖（npm ci），首次运行需要网络，请稍候……'
        # Install beside the project first; a download failure cannot damage its current dependencies.
        $stage = Join-Path $Root ('.qodex-install-' + [Guid]::NewGuid().ToString('N'))
        $modules = Join-Path $Root 'node_modules'
        $backup = Join-Path $stage 'previous-node_modules'
        $installed = $false
        $null = New-Item -ItemType Directory -Path (Join-Path $stage 'scripts') -Force
        try {
            foreach ($name in @('package.json','package-lock.json')) { Copy-Item -LiteralPath (Join-Path $Root $name) -Destination (Join-Path $stage $name) }
            Copy-Item -LiteralPath (Join-Path $Root 'scripts\patch-snowluma-sdk.mjs') -Destination (Join-Path $stage 'scripts\patch-snowluma-sdk.mjs')
            & $Node $Npm ci --omit=dev --prefix $stage
            if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败。请检查网络后重新运行 Install.bat；原有依赖、配置与密钥未被替换。' }
            $null = & $Node $Npm ls --omit=dev --depth=0 --prefix $stage 2>$null
            if ($LASTEXITCODE -ne 0) { throw '下载后的依赖检查失败；原有安装未被替换。' }
            if (Test-Path -LiteralPath $modules) { Move-Item -LiteralPath $modules -Destination $backup }
            try { Move-Item -LiteralPath (Join-Path $stage 'node_modules') -Destination $modules; $installed = $true }
            catch {
                if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $modules }
                throw
            }
        } finally {
            $resolvedStage = [IO.Path]::GetFullPath($stage)
            $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
            if ($resolvedStage.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedStage) -match '^\.qodex-install-[a-f0-9]{32}$' -and ($installed -or -not (Test-Path -LiteralPath $backup))) {
                Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    } finally { Pop-Location }
}

function Invoke-QodexInstallScript([string]$Root, [string]$Name) {
    & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy Bypass -STA -File (Join-Path $Root ('scripts\windows\' + $Name))
    if ($LASTEXITCODE -ne 0) { throw "$Name 未完成。请按提示处理后重新运行 Install.bat。" }
}

function Test-QodexInstallAccount([string]$Node, [string]$Root) {
    try {
        $output = & $Node (Join-Path $Root 'scripts\runtime-check.mjs') 2>$null
        if ($LASTEXITCODE -ne 0) { return $false }
        $account = ($output -join "`n") | ConvertFrom-Json
        return ($account.accountReady -eq $true -and @($account.models).Count -gt 0)
    } catch { return $false }
}

$previousExe = $env:QBOT_CODEX_EXE
try {
    Write-Host 'Qodex 安装与启动向导' -ForegroundColor Cyan
    Write-Host '首次安装：检查软件 → 安装项目依赖 → 独立 Codex 登录 → 配置 → 打开启动页。'
    Write-Host '需要 Node.js 24+、官方原生 codex.exe、已安装并登录 QQ 的 SnowLuma；本向导不会自动安装这些全局软件。'
    Write-Host 'Node.js：https://nodejs.org/en/download'
    Write-Host 'Codex：https://developers.openai.com/codex/windows'
    Write-Host 'SnowLuma：https://github.com/SnowLuma/SnowLuma'
    $node = Get-QodexNode
    $npm = Get-QodexNpmCli $node
    $configured = ''
    if (Test-Path -LiteralPath (Join-Path $root 'config.json') -PathType Leaf) {
        $config = Read-QodexConfig $root
        Assert-QodexConfig $config
        $null = Unprotect-QodexSecretObject $root
        if (Test-QodexPortOpen (Assert-QodexPort $config.controlPort '控制服务')) { throw '本部署正在运行。请先在 Qodex 启动页停止服务，再运行安装向导。' }
        $configured = [string]$config.codex.exe
        Write-Host '检测到已有配置：保留模型、端口、白名单与 DPAPI 密钥，只检查现有安装。'
    } elseif (Test-Path -LiteralPath (Join-Path $root 'state\secrets.dpapi')) {
        throw '检测到密钥但缺少 config.json；为避免覆盖，请先人工检查此安装目录。'
    }
    if ($configured) { $exe = Get-QodexCodexExe $configured }
    else {
        try { $exe = Get-QodexCodexExe }
        catch { $exe = Get-QodexCodexExe ((Read-Host '请输入已安装的官方原生 codex.exe 完整路径').Trim().Trim('"')) }
        Write-Host '请先安装 SnowLuma 并完成 QQ 登录，在 SnowLuma 中启用本机 OneBot HTTP 与 WebSocket。'
        if ((Read-Host '已准备好 SnowLuma 后输入 Y 继续；其他输入退出') -notmatch '^[Yy]$') { throw '请准备好 SnowLuma 后重新运行 Install.bat。' }
    }
    $env:QBOT_CODEX_EXE = $exe
    Install-QodexDependencies $node $npm $root
    if (-not (Test-QodexInstallAccount $node $root)) {
        Write-Host '现在打开官方 Codex 登录。请在浏览器完成本部署的独立登录；不会复用桌面版登录文件。'
        Invoke-QodexInstallScript $root 'Login-Codex.ps1'
    } else { Write-Host '独立 Codex 账户已就绪，保留当前登录。' }
    Invoke-QodexInstallScript $root 'Setup.ps1'
    Write-Host '安装检查完成。启动页中单击“启动 Qodex”启动；以后双击 Qodex.bat 即可。' -ForegroundColor Green
    if (-not $NoLaunch) {
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = Join-Path $PSHOME 'powershell.exe'
        $info.Arguments = '-NoProfile -ExecutionPolicy Bypass -STA -File "' + (Join-Path $root 'scripts\windows\Launcher.ps1') + '"'
        $info.WorkingDirectory = $root
        $info.UseShellExecute = $true
        $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
        $process = [Diagnostics.Process]::Start($info)
        if ($process) { $process.Dispose() }
    }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($PauseOnError) { $null = Read-Host '按回车关闭；处理上述提示后可重新双击 Install.bat' }
    exit 1
} finally { $env:QBOT_CODEX_EXE = $previousExe }
