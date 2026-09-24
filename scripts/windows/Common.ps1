$ErrorActionPreference = 'Stop'

# Node/npm can inherit PowerShell 7 module paths when starting Windows PowerShell.
# Load its own DPAPI cmdlets explicitly instead of the incompatible Core module.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop

function Get-QodexRoot {
    return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}

function Get-QodexNode {
    $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { throw '未找到 Node.js。请先安装 Node.js 24，并重新打开终端。' }
    $versionText = & $command.Source --version 2>$null
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(\d+)\.') { throw '无法检查 Node.js 版本。' }
    if ([int]$Matches[1] -lt 24) { throw "需要 Node.js 24 或更新版本，当前为 $versionText。" }
    return $command.Source
}

function Get-QodexCodexExe([string]$Configured = '') {
    $candidates = New-Object 'System.Collections.Generic.List[string]'
    if (-not [string]::IsNullOrWhiteSpace($Configured)) {
        if (-not [IO.Path]::IsPathRooted($Configured) -or -not (Test-Path -LiteralPath $Configured -PathType Leaf) -or [IO.Path]::GetFileName($Configured) -ine 'codex.exe') {
            throw 'config.codex.exe 必须是已存在的原生 codex.exe 完整路径。'
        }
        return [IO.Path]::GetFullPath($Configured)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:QBOT_CODEX_EXE)) { $candidates.Add($env:QBOT_CODEX_EXE) }
    $command = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { $candidates.Add($command.Source) }
    if ($env:LOCALAPPDATA) {
        $bin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
        if (Test-Path -LiteralPath $bin -PathType Container) {
            Get-ChildItem -LiteralPath $bin -Directory -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                ForEach-Object { $candidates.Add((Join-Path $_.FullName 'codex.exe')) }
        }
    }
    foreach ($candidate in $candidates) {
        if ([IO.Path]::IsPathRooted($candidate) -and [IO.Path]::GetFileName($candidate) -ieq 'codex.exe' -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    throw '未找到原生 codex.exe。请安装并登录官方 Codex 桌面版或 CLI；只有 npm 的 codex.cmd 时，请选择原生 codex.exe。'
}

function Assert-QodexLoopbackUrl([string]$Value, [string[]]$Schemes, [string]$Name) {
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin $Schemes -or
        $Value -notmatch '^[a-z]+://127\.0\.0\.1:[0-9]+(?:/|$)' -or $uri.Port -lt 1024 -or $uri.Port -gt 65535 -or
        $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw "$Name 必须是本机回环地址（不含用户名、令牌、查询参数）。"
    }
    return $uri
}

function Assert-QodexPort([object]$Value, [string]$Name) {
    $port = 0
    if (-not [int]::TryParse([string]$Value, [ref]$port) -or $port -lt 1024 -or $port -gt 65535) {
        throw "$Name 必须是 1024 至 65535 的端口。"
    }
    return $port
}

function Assert-QodexConfig([object]$Config, [switch]$Initial) {
    if (-not $Config -or $Config.backend -ne 'codex' -or $Config.codex.conversationMode -ne 'model') { throw '配置必须使用 Codex 模型对话后端。' }
    if (-not $Config.codex.model -or -not $Config.codex.reasoningEffort -or $Config.codex.serviceTier -notin @('default', 'priority')) { throw 'Codex 模型、推理强度或服务档位配置无效。' }
    $null = Get-QodexCodexExe ([string]$Config.codex.exe)
    $ws = Assert-QodexLoopbackUrl ([string]$Config.snowluma.wsUrl) @('ws', 'wss') 'OneBot WebSocket URL'
    $http = Assert-QodexLoopbackUrl ([string]$Config.snowluma.httpUrl) @('http', 'https') 'OneBot HTTP URL'
    $web = Assert-QodexLoopbackUrl ([string]$Config.snowluma.webUiUrl) @('http', 'https') 'SnowLuma WebUI URL'
    $console = Assert-QodexPort $Config.consolePort '控制台'
    $control = Assert-QodexPort $Config.controlPort '控制服务'
    $ports = @([int]$ws.Port, [int]$http.Port, [int]$web.Port, $console, $control)
    if (@($ports | Select-Object -Unique).Count -ne 5) { throw 'OneBot、WebUI、控制台和控制服务的端口必须各不相同。' }
    if (-not [string]::IsNullOrWhiteSpace([string]$Config.snowluma.launcherPath)) {
        $launcher = [string]$Config.snowluma.launcherPath
        if (-not [IO.Path]::IsPathRooted($launcher) -or -not (Test-Path -LiteralPath $launcher -PathType Leaf) -or [IO.Path]::GetExtension($launcher) -notin @('.exe', '.cmd', '.bat')) {
            throw 'SnowLuma 启动器必须是已存在的 .exe、.cmd 或 .bat 完整路径。'
        }
    }
    if ($Initial -and [string]$Config.ownerQQ -notmatch '^[1-9][0-9]{4,15}$') { throw 'ownerQQ 必须是有效 QQ 号。' }
    foreach ($id in @($Config.allow.private) + @($Config.allow.groups)) {
        if ([string]$id -notmatch '^[1-9][0-9]{4,15}$') { throw '白名单中的 QQ 号或群号无效。' }
    }
    if ($Initial -and (@($Config.allow.private).Count + @($Config.allow.groups).Count -eq 0)) { throw '至少配置一个私聊或群聊白名单。' }
    if ($Initial -and $Config.allowAllWhenEmpty -eq $true) { throw '初始化时禁止空白名单放行全部。' }
    if ($Config.snowluma.accessToken -or $Config.consoleToken) { throw '配置文件中不得保存 OneBot 或控制台令牌。' }
}

function Read-QodexConfig([string]$Root) {
    $path = Join-Path $Root 'config.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw '缺少 config.json，请先运行 Setup.ps1。' }
    try { return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json) }
    catch { throw 'config.json 不是有效 JSON。' }
}

function New-QodexToken {
    $bytes = New-Object byte[] 32
    $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Protect-QodexSecretObject([object]$Secrets) {
    $json = $Secrets | ConvertTo-Json -Compress -Depth 4
    $secure = ConvertTo-SecureString -String $json -AsPlainText -Force
    try { return ConvertFrom-SecureString -SecureString $secure }
    finally { $secure.Dispose() }
}

function Unprotect-QodexSecretObject([string]$Root) {
    $path = Join-Path $Root 'state\secrets.dpapi'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw '缺少 state/secrets.dpapi；请在原 Windows 用户下运行，或重新安全初始化。' }
    try {
        $protected = (Get-Content -LiteralPath $path -Raw -Encoding ASCII).Trim()
        $secure = ConvertTo-SecureString -String $protected
        try { $json = [System.Net.NetworkCredential]::new('', $secure).Password }
        finally { $secure.Dispose() }
        $secrets = $json | ConvertFrom-Json
        if ($null -eq $secrets.onebot -or [string]$secrets.console -notmatch '^[a-f0-9]{64}$' -or [string]$secrets.control -notmatch '^[a-f0-9]{64}$') { throw 'secret shape' }
        return $secrets
    } catch { throw '无法解密 state/secrets.dpapi；请使用创建它的 Windows 用户。' }
}

function Write-QodexInitialization([string]$Root, [object]$Config, [object]$Secrets) {
    Assert-QodexConfig $Config -Initial
    $configPath = Join-Path $Root 'config.json'
    $stateDir = Join-Path $Root 'state'
    $secretPath = Join-Path $stateDir 'secrets.dpapi'
    if (Test-Path -LiteralPath $configPath) { throw 'config.json 已存在，不会覆盖。' }
    if (Test-Path -LiteralPath $secretPath) { throw 'secrets.dpapi 已存在，不会覆盖。' }
    $null = New-Item -ItemType Directory -Path $stateDir -Force
    $tag = [Guid]::NewGuid().ToString('N')
    $secretTmp = Join-Path $stateDir ("secrets.$tag.tmp")
    $configTmp = Join-Path $Root ("config.$tag.tmp")
    $secretInstalled = $false
    try {
        [IO.File]::WriteAllText($secretTmp, (Protect-QodexSecretObject $Secrets), [Text.Encoding]::ASCII)
        [IO.File]::WriteAllText($configTmp, (($Config | ConvertTo-Json -Depth 20) + "`n"), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $secretTmp -Destination $secretPath -ErrorAction Stop
        $secretInstalled = $true
        Move-Item -LiteralPath $configTmp -Destination $configPath -ErrorAction Stop
    } catch {
        if ($secretInstalled -and -not (Test-Path -LiteralPath $configPath)) { Remove-Item -LiteralPath $secretPath -Force -ErrorAction SilentlyContinue }
        throw
    } finally {
        Remove-Item -LiteralPath $secretTmp, $configTmp -Force -ErrorAction SilentlyContinue
    }
}

function Test-QodexPortOpen([int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $Port); return $true }
    catch { return $false }
    finally { $client.Dispose() }
}
