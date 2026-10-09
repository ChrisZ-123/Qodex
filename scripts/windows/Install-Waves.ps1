param([string]$Python = '', [switch]$RemoteLogin)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$root = Get-QodexRoot

function Install-QodexCloudflared([string]$Tools) {
    # The official release metadata supplies the official SHA-256 asset digest.
    $version = '2026.10.0'
    $assetName = 'cloudflared-windows-amd64.exe'
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/cloudflare/cloudflared/releases/tags/$version" -Headers @{'User-Agent'='Qodex-Waves-Installer';Accept='application/vnd.github+json'} -TimeoutSec 60
    if ($release.tag_name -ne $version -or $release.draft -or $release.prerelease) { throw 'Cloudflared 官方发布元数据无效。' }
    $assets = @($release.assets | Where-Object { $_.name -eq $assetName })
    $expectedUrl = "https://github.com/cloudflare/cloudflared/releases/download/$version/$assetName"
    if ($assets.Count -ne 1 -or $assets[0].browser_download_url -ne $expectedUrl -or $assets[0].digest -notmatch '^sha256:([a-f0-9]{64})$') { throw 'Cloudflared 官方资产缺少可验证摘要，未安装。' }
    $expectedDigest = $Matches[1]
    $null = New-Item -ItemType Directory -Path $Tools -Force
    $temporary = Join-Path $Tools ('download.' + [Guid]::NewGuid().ToString('N'))
    $licenseTemporary = "$temporary.LICENSE"
    try {
        Invoke-WebRequest -Uri $expectedUrl -OutFile $temporary -UseBasicParsing -TimeoutSec 120
        $sha = [Security.Cryptography.SHA256]::Create()
        $assetStream = $null
        try {
            $assetStream = [IO.File]::OpenRead($temporary)
            $actualDigest = ([BitConverter]::ToString($sha.ComputeHash($assetStream))).Replace('-', '').ToLowerInvariant()
        } finally {
            if ($assetStream) { $assetStream.Dispose() }
            $sha.Dispose()
        }
        if ($actualDigest -ne $expectedDigest) { throw 'Cloudflared 官方资产摘要不匹配，未安装。' }
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/cloudflare/cloudflared/$version/LICENSE" -OutFile $licenseTemporary -UseBasicParsing -TimeoutSec 60
        if ((Get-Content -LiteralPath $licenseTemporary -Raw) -notmatch 'Apache License') { throw 'Cloudflared 官方 LICENSE 无效。' }
        Move-Item -LiteralPath $temporary -Destination (Join-Path $Tools 'cloudflared.exe') -Force
        Move-Item -LiteralPath $licenseTemporary -Destination (Join-Path $Tools 'LICENSE') -Force
    } finally { Remove-Item -LiteralPath $temporary,$licenseTemporary -Force -ErrorAction SilentlyContinue }
}

try {
    $config = Read-QodexConfig $root
    $null = Unprotect-QodexSecretObject $root
    $wavesConfig = Get-QodexWavesConfig $config
    if (-not $Python) {
        $launcher = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $launcher) { throw '需要 Windows x64 Python 3.11；安装后使用 -Python 指定 python.exe。' }
        $Python = (& $launcher.Source -3.11 -c 'import sys;print(sys.executable)' 2>$null | Select-Object -Last 1)
        if ($LASTEXITCODE -ne 0) { throw '未发现 Python 3.11；请用 -Python 指定 python.exe。' }
    }
    if (-not [IO.Path]::IsPathRooted($Python) -or -not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw '-Python 必须是已存在的 Python 3.11 完整路径。' }
    $pythonVersion = & $Python -c 'import sys,struct;print(str(sys.version_info.major)+chr(46)+str(sys.version_info.minor)+chr(47)+str(struct.calcsize(chr(80))*8))' 2>$null
    if ($LASTEXITCODE -ne 0 -or $pythonVersion -ne '3.11/64') { throw 'Waves 需要 Windows x64 Python 3.11。' }
    $wavesRoot = Join-Path $root 'state\waves'
    & $Python (Join-Path $root 'integrations\waves\install.py') --root $wavesRoot
    if ($LASTEXITCODE -ne 0) { throw 'Waves 安装失败；未启用小游戏或远程登录。' }
    $marker = Get-Content -LiteralPath (Join-Path $wavesRoot 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($marker.version -ne 1 -or $marker.complete -ne $true) { throw 'Waves 依赖尚未完整安装。' }
    Add-QodexWavesSecret $root
    if ($RemoteLogin) {
        Install-QodexCloudflared (Join-Path $wavesRoot 'tools')
        $wavesConfig.remoteLoginEnabled = $true
        $config | Add-Member -NotePropertyName waves -NotePropertyValue $wavesConfig -Force
        $configPath = Join-Path $root 'config.json'
        $temporary = Join-Path $root ('config.' + [Guid]::NewGuid().ToString('N') + '.tmp')
        try {
            [IO.File]::WriteAllText($temporary, (($config | ConvertTo-Json -Depth 30) + "`n"), (New-Object Text.UTF8Encoding($false)))
            [IO.File]::Replace($temporary,$configPath,"$temporary.previous")
        } finally { Remove-Item -LiteralPath $temporary,"$temporary.previous" -Force -ErrorAction SilentlyContinue }
    }
    Write-Output 'Waves 已安装。请重启 Qodex 以加载安全密钥，再在控制台单独启用小游戏。'
    if ($RemoteLogin) { Write-Output '远程登录已配置：仅本机登录端口可经公开 HTTPS 地址访问；小游戏启用后才启动隧道。' }
} catch { Write-Error $_.Exception.Message; exit 1 }
