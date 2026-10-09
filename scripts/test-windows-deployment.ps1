$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRoot = Join-Path $tempRoot ('Qodex 测试 空格 ' + [Guid]::NewGuid().ToString('N'))
$fixtureRoot = [IO.Path]::GetFullPath($fixtureRoot)
if (-not $fixtureRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($fixtureRoot) -notlike 'Qodex 测试 空格 *') {
    throw 'Fixture path escaped the temporary directory.'
}
$foreign = $null
$controlPort = 0
$secrets = $null

function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Get-FreePort {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return [int]$listener.LocalEndpoint.Port }
    finally { $listener.Stop() }
}
function Invoke-FixtureScript([string]$Path, [string]$Action = '') {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $PSHOME 'powershell.exe'
    $info.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $Path + '"'
    if ($Action -eq 'ValidateOnly') { $info.Arguments += ' -ValidateOnly' }
    elseif ($Action) { $info.Arguments += ' -Action ' + $Action }
    $info.WorkingDirectory = $fixtureRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    try {
        if (-not $process.WaitForExit(60000)) { $process.Kill(); throw "Timed out: $Action" }
        return [pscustomobject]@{code=$process.ExitCode;out=$process.StandardOutput.ReadToEnd();err=$process.StandardError.ReadToEnd()}
    } finally { $process.Dispose() }
}
function Check-WrongAuth([int]$Port) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/status" -Headers @{Authorization='Bearer incorrect'} -UseBasicParsing -TimeoutSec 3
        $script:authObservation = "Unexpected HTTP $($response.StatusCode)"
        return $false
    } catch {
        $response = $_.Exception.Response
        if ($response) {
            $script:authObservation = "HTTP $([int]$response.StatusCode)"
            return ([int]$response.StatusCode -eq 401)
        }
        $script:authObservation = $_.Exception.Message
        return $false
    }
}

function Test-CloudflaredInstaller {
    $script:fixtureCloudDigest = $null
    $script:fixtureCloudMismatch = $false
    $bytes = [Text.Encoding]::ASCII.GetBytes('fixture official asset')
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $script:fixtureCloudDigest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
    function Invoke-RestMethod {
        param($Uri,$Headers,$TimeoutSec)
        Assert ($Uri -eq 'https://api.github.com/repos/cloudflare/cloudflared/releases/tags/2026.10.0') 'Cloudflared installer used an unpinned release.'
        return [pscustomobject]@{tag_name='2026.10.0';draft=$false;prerelease=$false;assets=@([pscustomobject]@{name='cloudflared-windows-amd64.exe';browser_download_url='https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-windows-amd64.exe';digest=('sha256:' + $script:fixtureCloudDigest)})}
    }
    function Invoke-WebRequest {
        param($Uri,$OutFile,[switch]$UseBasicParsing,$TimeoutSec)
        if ($Uri -eq 'https://raw.githubusercontent.com/cloudflare/cloudflared/2026.10.0/LICENSE') { [IO.File]::WriteAllText($OutFile,'Apache License fixture') }
        elseif ($Uri -eq 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-windows-amd64.exe') {
            [IO.File]::WriteAllText($OutFile, $(if ($script:fixtureCloudMismatch) {'wrong asset'} else {'fixture official asset'}), [Text.Encoding]::ASCII)
        } else { throw 'Unexpected Cloudflared download source.' }
    }
    $parseErrors = $null
    $tokens = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $fixtureRoot 'scripts\windows\Install-Waves.ps1'), [ref]$tokens, [ref]$parseErrors)
    Assert ($parseErrors.Count -eq 0) 'Install-Waves.ps1 did not parse.'
    $functionAst = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Install-QodexCloudflared'},$true)
    Invoke-Expression $functionAst.Extent.Text
    $tools = Join-Path $fixtureRoot 'mock tools 中文'
    Install-QodexCloudflared $tools
    Assert ((Get-Content -LiteralPath (Join-Path $tools 'cloudflared.exe') -Raw) -eq 'fixture official asset') 'Verified official asset was not installed.'
    Assert (Test-Path -LiteralPath (Join-Path $tools 'LICENSE')) 'Official LICENSE was not installed.'
    $script:fixtureCloudMismatch = $true
    $rejected = $false
    try { Install-QodexCloudflared $tools } catch { $rejected = $true }
    Assert $rejected 'Cloudflared digest mismatch was accepted.'
    Assert ((Get-Content -LiteralPath (Join-Path $tools 'cloudflared.exe') -Raw) -eq 'fixture official asset') 'Digest mismatch overwrote verified asset.'
}

try {
    $null = New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'scripts\windows'), (Join-Path $fixtureRoot 'src'), (Join-Path $fixtureRoot 'fake SnowLuma 中文') -Force
    foreach ($file in @('Common.ps1','Setup.ps1','Control.ps1','Launcher.ps1','supervisor.mjs','waves-supervisor.mjs','Install-Waves.ps1')) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot "scripts\windows\$file") -Destination (Join-Path $fixtureRoot "scripts\windows\$file")
    }
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'Setup.ps1') -Destination (Join-Path $fixtureRoot 'Setup.ps1')
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'config.example.json') -Destination (Join-Path $fixtureRoot 'config.example.json')
    $missing = Invoke-FixtureScript (Join-Path $fixtureRoot 'Setup.ps1')
    Assert ($missing.code -ne 0 -and $missing.err -match 'npm ci') ("Setup did not reject missing dependencies: " + $missing.out + $missing.err)
    Assert (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'config.json'))) 'Setup wrote config after dependency failure.'

    . (Join-Path $fixtureRoot 'scripts\windows\Common.ps1')
    Test-CloudflaredInstaller
    $ports = @()
    while ($ports.Count -lt 5) {
        $candidate = Get-FreePort
        if ($candidate -ge 1024 -and $candidate -notin $ports) { $ports += $candidate }
    }
    $controlPort = $ports[4]
    $fakeExe = Join-Path $fixtureRoot 'codex.exe'
    [IO.File]::WriteAllBytes($fakeExe, (New-Object byte[] 0))
    $batchPath = Join-Path $fixtureRoot 'fake SnowLuma 中文\launcher with space.bat'
    [IO.File]::WriteAllText($batchPath, "@echo off`r`necho started> `"%~dp0started.txt`"`r`nping -n 60 127.0.0.1 >nul`r`n", [Text.Encoding]::ASCII)
    $config = Get-Content -LiteralPath (Join-Path $fixtureRoot 'config.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $config.codex.exe = $fakeExe
    $config.codex.model = 'fixture-model'
    $config.codex.reasoningEffort = 'max'
    # The console writes null for standard speed; startup must accept it after an upgrade.
    $config.codex.serviceTier = $null
    $config.snowluma.wsUrl = "ws://127.0.0.1:$($ports[0])"
    $config.snowluma.httpUrl = "http://127.0.0.1:$($ports[1])"
    $config.snowluma.webUiUrl = "http://127.0.0.1:$($ports[2])"
    $config.snowluma.launcherPath = $batchPath
    $config.ownerQQ = '12345678'
    $config.allow.private = @('12345678')
    $config.allow.groups = @()
    $config.consolePort = $ports[3]
    $config.controlPort = $controlPort
    $secrets = [pscustomobject]@{onebot='fixture-onebot';console=(New-QodexToken);control=(New-QodexToken)}
    Write-QodexInitialization $fixtureRoot $config $secrets
    $launcherCheck = Invoke-FixtureScript (Join-Path $fixtureRoot 'scripts\windows\Launcher.ps1') 'ValidateOnly'
    Assert ($launcherCheck.code -eq 0 -and $launcherCheck.out -match '11 actions') ("Launcher validation failed: " + $launcherCheck.err)
    $encrypted = Get-Content -LiteralPath (Join-Path $fixtureRoot 'state\secrets.dpapi') -Raw
    $plainConfig = Get-Content -LiteralPath (Join-Path $fixtureRoot 'config.json') -Raw
    Assert ($encrypted -notmatch 'fixture-onebot' -and $plainConfig -notmatch 'fixture-onebot' -and $plainConfig -notmatch [regex]::Escape($secrets.control)) 'A secret leaked to config or DPAPI ciphertext.'
    $decoded = Unprotect-QodexSecretObject $fixtureRoot
    Assert ($decoded.onebot -eq $secrets.onebot -and $decoded.control -eq $secrets.control) 'DPAPI roundtrip failed.'
    Add-QodexWavesSecret $fixtureRoot
    $withWaves = Unprotect-QodexSecretObject $fixtureRoot
    Assert ($withWaves.waves -match '^[a-f0-9]{64}$' -and $withWaves.onebot -eq $decoded.onebot -and $withWaves.control -eq $decoded.control -and $withWaves.console -eq $decoded.console) 'Adding Waves secret changed existing DPAPI fields.'
    Add-QodexWavesSecret $fixtureRoot
    Assert ((Unprotect-QodexSecretObject $fixtureRoot).waves -eq $withWaves.waves) 'Repeated Waves secret installation changed the secret.'
    Assert ((Get-Content -LiteralPath (Join-Path $fixtureRoot 'state\waves-settings.json') -Raw | ConvertFrom-Json).enabled -eq $false) 'Base setup enabled Waves.'
    # Load the production validator instead of mirroring its required fields.
    $node = Get-QodexNode
    $env:QODEX_WAVES_FIXTURE_FILE = Join-Path $fixtureRoot 'state\waves-settings.json'
    try {
        $wavesModule = ([Uri](Join-Path $sourceRoot 'src\waves-client.js')).AbsoluteUri
        $validator = 'import {WavesSettings} from ' + (ConvertTo-Json -InputObject $wavesModule -Compress) + '; const settings=new WavesSettings(process.env.QODEX_WAVES_FIXTURE_FILE); if(settings.enabled("group:12345")||settings.data.revision!==0)throw Error("Invalid base Waves defaults");'
        $validatorPath = Join-Path $fixtureRoot 'validate-waves-settings.mjs'
        [IO.File]::WriteAllText($validatorPath, $validator, (New-Object Text.UTF8Encoding($false)))
        & $node $validatorPath
        Assert ($LASTEXITCODE -eq 0) 'Production WavesSettings rejected the initialized defaults.'
    } finally { Remove-Item Env:\QODEX_WAVES_FIXTURE_FILE -ErrorAction SilentlyContinue }
    $repeat = $false
    try { Write-QodexInitialization $fixtureRoot $config $secrets } catch { $repeat = $true }
    Assert $repeat 'Repeated initialization did not refuse overwrite.'
    Assert ((Get-Content -LiteralPath (Join-Path $fixtureRoot 'config.json') -Raw) -eq $plainConfig) 'Repeated initialization changed config.'

    $fakeBridge = @'
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
const server=http.createServer((req,res)=>{
  if(req.headers['x-console-token']!==process.env.QBOT_CONSOLE_TOKEN){res.writeHead(401).end();return;}
  res.setHeader('content-type','application/json');
  if(req.url==='/api/status'){res.end(JSON.stringify({backend:'codex',model:config.codex.model,reasoningEffort:config.codex.reasoningEffort,serviceTier:'default',dshReady:true,mode:'model'}));return;}
  if(req.url==='/api/backend/stop'&&req.method==='POST'){fs.writeFileSync(path.join(root,'state','graceful-called'),'yes');res.end('{"ok":true}');return;}
  res.writeHead(404).end('{}');
});
server.listen(config.consolePort,'127.0.0.1');
'@
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'src\bridge.js'), $fakeBridge, (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'package.json'), '{"type":"module"}', [Text.Encoding]::ASCII)
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'foreign.mjs'), 'setInterval(()=>{},1000);', [Text.Encoding]::ASCII)
    $node = Get-QodexNode
    $foreignInfo = New-Object Diagnostics.ProcessStartInfo
    $foreignInfo.FileName = $node
    $foreignInfo.Arguments = '"' + (Join-Path $fixtureRoot 'foreign.mjs') + '"'
    $foreignInfo.WorkingDirectory = $fixtureRoot
    $foreignInfo.UseShellExecute = $false
    $foreignInfo.CreateNoWindow = $true
    $foreign = [Diagnostics.Process]::Start($foreignInfo)

    $busy = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $controlPort)
    $busy.Start()
    try {
        $occupied = Invoke-FixtureScript (Join-Path $fixtureRoot 'scripts\windows\Control.ps1') 'Start'
        Assert ($occupied.code -ne 0) 'Start ignored an occupied control port.'
    } finally { $busy.Stop() }
    $busyConsole = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $config.consolePort)
    $busyConsole.Start()
    try {
        $occupiedConsole = Invoke-FixtureScript (Join-Path $fixtureRoot 'scripts\windows\Control.ps1') 'Start'
        Assert ($occupiedConsole.code -ne 0) 'Start ignored an occupied console port.'
    } finally { $busyConsole.Stop() }
    $started = Invoke-FixtureScript (Join-Path $fixtureRoot 'scripts\windows\Control.ps1') 'Start'
    Assert ($started.code -eq 0) ("Fixture start failed: " + $started.err + $started.out)
    $startedStatus = $started.out | ConvertFrom-Json
    Assert ($startedStatus.bridgeReady -and $startedStatus.modelReady) 'Fixture bridge was not ready.'
    Assert ($startedStatus.waves.enabled -eq $false -and $startedStatus.waves.ready -eq $false -and $startedStatus.waves.remoteReady -eq $false) 'Disabled Waves started optional children.'
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'state\waves-settings.json'), '{"enabled":true}', [Text.Encoding]::ASCII)
    $sync = Invoke-RestMethod -Uri "http://127.0.0.1:$controlPort/waves/sync" -Method Post -Headers @{Authorization="Bearer $($secrets.control)"} -TimeoutSec 5
    Assert ($sync.enabled -and -not $sync.ready -and $sync.error -match 'dependencies missing') 'Optional missing dependency was not reported.'
    $baseAfterOptionalFailure = Invoke-RestMethod -Uri "http://127.0.0.1:$controlPort/status" -Headers @{Authorization="Bearer $($secrets.control)"} -TimeoutSec 3
    Assert ($baseAfterOptionalFailure.bridgeReady -and -not $baseAfterOptionalFailure.startupError) 'Optional failure stopped ordinary chat.'
    Assert (Check-WrongAuth $controlPort) ("Control wrong-token check failed: " + $script:authObservation)
    $verify = Invoke-FixtureScript (Join-Path $fixtureRoot 'scripts\windows\Control.ps1') 'Verify'
    Assert ($verify.code -eq 0 -and (($verify.out | ConvertFrom-Json).qqOnline -eq $false)) 'Read-only verify failed.'
    Assert (Test-Path -LiteralPath (Join-Path $fixtureRoot 'fake SnowLuma 中文\started.txt')) 'SnowLuma batch launcher with spaces/Chinese path did not start.'
    $stopped = Invoke-FixtureScript (Join-Path $fixtureRoot 'scripts\windows\Control.ps1') 'Stop'
    Assert ($stopped.code -eq 0 -and -not (Test-QodexPortOpen $controlPort)) ("Fixture stop failed: " + $stopped.err)
    Assert (Test-Path -LiteralPath (Join-Path $fixtureRoot 'state\graceful-called')) 'Stop skipped graceful bridge cancellation.'
    $foreign.Refresh()
    Assert (-not $foreign.HasExited) 'Stop terminated an unrelated node process.'
    Write-Output 'Windows deployment fixture passed: dependencies, paths, DPAPI, idempotence, port guard, auth, launcher and owned lifecycle.'
} finally {
    if ($foreign) { try { if (-not $foreign.HasExited) { $foreign.Kill(); $foreign.WaitForExit(5000) | Out-Null } } catch {} ; $foreign.Dispose() }
    if ($controlPort -and (Test-QodexPortOpen $controlPort) -and $secrets) {
        try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:$controlPort/stop" -Method Post -Headers @{Authorization="Bearer $($secrets.control)"} -TimeoutSec 3 } catch {}
        Start-Sleep -Seconds 2
    }
    if ($controlPort -eq 0 -or -not (Test-QodexPortOpen $controlPort)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
