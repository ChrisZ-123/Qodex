$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$root = Get-QodexRoot

function Read-Default([string]$Label, [string]$Default) {
    $answer = Read-Host "$Label [$Default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim()
}

function Read-Required([string]$Label) {
    do { $answer = (Read-Host $Label).Trim() } while ([string]::IsNullOrWhiteSpace($answer))
    return $answer
}

function Read-IdList([string]$Label, [string]$Default = '') {
    $raw = Read-Default $Label $Default
    if ([string]::IsNullOrWhiteSpace($raw)) { return ,@() }
    $ids = @($raw -split '[,，\s]+' | Where-Object { $_ })
    foreach ($id in $ids) { if ($id -notmatch '^[1-9][0-9]{4,15}$') { throw "QQ 号或群号无效：$id" } }
    return ,@($ids | Select-Object -Unique)
}

function Invoke-ModelCheck([string]$Exe, [string]$Node) {
    $env:QBOT_CODEX_EXE = $Exe
    try {
        $output = & $Node (Join-Path $root 'scripts\runtime-check.mjs') 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Codex 当前账户不可用。请先在官方 Codex 中登录，再运行 Setup.ps1。' }
        return (($output -join "`n") | ConvertFrom-Json)
    } finally { Remove-Item Env:QBOT_CODEX_EXE -ErrorAction SilentlyContinue }
}

try {
    $node = Get-QodexNode
    if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\@snowluma\sdk') -PathType Container)) {
        throw '依赖尚未安装。请先在 Qodex 目录执行 npm ci。'
    }
    $existingPath = Join-Path $root 'config.json'
    if (Test-Path -LiteralPath $existingPath -PathType Leaf) {
        $config = Read-QodexConfig $root
        Assert-QodexConfig $config
        $null = Unprotect-QodexSecretObject $root
        $exe = Get-QodexCodexExe ([string]$config.codex.exe)
        $catalog = Invoke-ModelCheck $exe $node
        $selected = @($catalog.models | Where-Object { $_.model -eq $config.codex.model }) | Select-Object -First 1
        if (-not $catalog.accountReady -or -not $selected -or $config.codex.reasoningEffort -notin @($selected.efforts)) {
            throw '现有配置的 Codex 模型/推理强度在当前账户不可用；配置未被覆盖。'
        }
        Write-Host '配置和 Windows DPAPI 密钥已验证；没有覆盖任何文件。'
        exit 0
    }
    if (Test-Path -LiteralPath (Join-Path $root 'state\secrets.dpapi')) {
        throw '检测到旧的 state/secrets.dpapi，但缺少 config.json。为避免覆盖密钥，请先人工检查。'
    }
    $detectedExe = ''
    try { $detectedExe = Get-QodexCodexExe }
    catch { Write-Host '未自动找到原生 codex.exe，请输入官方安装的完整路径。' }
    if ($detectedExe) { $exe = Read-Default '原生 Codex 可执行文件完整路径' $detectedExe }
    else { $exe = Read-Required '原生 Codex 可执行文件完整路径' }
    $exe = Get-QodexCodexExe $exe
    $catalog = Invoke-ModelCheck $exe $node
    if (-not $catalog.accountReady -or -not @($catalog.models).Count) { throw 'Codex 账户或模型目录未就绪。' }
    Write-Host '当前 Codex 账户可用的模型与推理强度：'
    foreach ($entry in $catalog.models) { Write-Host ("  {0}: {1}" -f $entry.model, (@($entry.efforts) -join ', ')) }
    $suggestion = @($catalog.models | Where-Object { $_.model -eq 'gpt-6-luna' -and 'max' -in @($_.efforts) }) | Select-Object -First 1
    if ($suggestion) { Write-Host '建议选择 gpt-6-luna / max；请明确确认模型与推理强度。' }
    do { $modelName = Read-Required '输入要使用的模型名称' ; $modelEntry = @($catalog.models | Where-Object { $_.model -eq $modelName }) | Select-Object -First 1 } while (-not $modelEntry)
    do { $effort = Read-Required '输入该模型列出的推理强度' } while ($effort -notin @($modelEntry.efforts))
    do { $tier = Read-Default '服务档位（default 或 priority）' 'default' } while ($tier -notin @('default', 'priority'))
    $wsUrl = Read-Default 'OneBot WebSocket URL' 'ws://127.0.0.1:3001'
    $httpUrl = Read-Default 'OneBot HTTP URL' 'http://127.0.0.1:3000'
    $webUiUrl = Read-Default 'SnowLuma WebUI URL' 'http://127.0.0.1:5099'
    $launcherPath = (Read-Host 'SnowLuma 启动器完整路径（已手动启动可留空）').Trim().Trim('"')
    $owner = Read-Required '你的 QQ 号（ownerQQ）'
    $allowPrivate = Read-IdList '允许的私聊 QQ 号，逗号分隔' $owner
    $allowGroups = Read-IdList '允许的群号，逗号分隔；无群可留空'
    $consolePort = Read-Default '控制台端口' '3100'
    $controlPort = Read-Default '控制服务端口' '3110'
    Write-Host '如 SnowLuma 的 OneBot 未设置 access token，直接回车即可。输入不会回显。'
    $secureOneBot = Read-Host 'OneBot access token' -AsSecureString
    try { $onebot = [System.Net.NetworkCredential]::new('', $secureOneBot).Password }
    finally { $secureOneBot.Dispose() }
    $config = Get-Content -LiteralPath (Join-Path $root 'config.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $config.backend = 'codex'
    $config.codex.exe = $exe
    $config.codex.conversationMode = 'model'
    $config.codex.model = $modelName
    $config.codex.reasoningEffort = $effort
    $config.codex.serviceTier = $tier
    $config.snowluma.wsUrl = $wsUrl
    $config.snowluma.httpUrl = $httpUrl
    $config.snowluma.webUiUrl = $webUiUrl
    $config.snowluma.launcherPath = $launcherPath
    $config.snowluma.accessToken = ''
    $config.snowluma.allowProcessControl = $false
    $config.ownerQQ = $owner
    $config.allow.private = @($allowPrivate)
    $config.allow.groups = @($allowGroups)
    $config.allowAllWhenEmpty = $false
    $config.consolePort = [int]$consolePort
    $config.controlPort = [int]$controlPort
    $config.consoleToken = ''
    Assert-QodexConfig $config
    if ((Test-QodexPortOpen $config.consolePort) -or (Test-QodexPortOpen $config.controlPort)) {
        throw '控制台或控制服务端口已被占用；请更换端口后重新运行。'
    }
    $secrets = [pscustomobject]@{onebot=$onebot;console=(New-QodexToken);control=(New-QodexToken)}
    Write-QodexInitialization $root $config $secrets
    Write-Host 'Qodex 初始化完成。请确认 SnowLuma 已登录 QQ 并启用本机 OneBot HTTP 与 WebSocket，然后双击 Qodex.bat。'
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
