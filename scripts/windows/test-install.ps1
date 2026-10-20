$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixture = [IO.Path]::GetFullPath((Join-Path $tempRoot ('Qodex install 中文 & ^ ! () ' + [Guid]::NewGuid().ToString('N'))))
function Assert([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Import-FixtureFunction([string]$File, [string]$Name) {
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors)
    Assert ($errors.Count -eq 0) "PowerShell parse failed: $File"
    $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name},$true)
    Assert ($null -ne $definition) "Missing function: $Name"
    return $definition.Extent.Text
}
try {
    Assert ($fixture.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)) 'Fixture escaped TEMP.'
    $null=New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts\windows') -Force
    . ([scriptblock]::Create((Import-FixtureFunction (Join-Path $PSScriptRoot 'Common.ps1') 'Get-QodexSystemProxy')))
    $script:proxySettings=[pscustomobject]@{ProxyEnable=0;ProxyServer='stale.invalid:123'}
    function Get-ItemProperty { param($LiteralPath,$ErrorAction) Assert ($LiteralPath -eq 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings') 'Unexpected registry access'; return $script:proxySettings }
    Assert ($null -eq (Get-QodexSystemProxy)) 'Disabled system proxy was not cleared.'
    foreach ($server in @('127.0.0.1:1','127.0.0.1:65535','127.0.0.1:7890')) {
        $script:proxySettings=[pscustomobject]@{ProxyEnable=1;ProxyServer=$server}
        Assert ((Get-QodexSystemProxy) -eq ('http://'+$server)) 'Supported local proxy rejected.'
    }
    foreach ($server in @('localhost:7890','127.0.0.1:0','127.0.0.1:07890','127.0.0.1:65536','192.168.1.1:7890','http://127.0.0.1:7890','http=127.0.0.1:7890;https=127.0.0.1:7890','127.0.0.1:7890/','127.0.0.1:7890?secret=x')) {
        $script:proxySettings=[pscustomobject]@{ProxyEnable=1;ProxyServer=$server}
        $rejected=$false;try { $null=Get-QodexSystemProxy } catch { $rejected=$true }
        Assert $rejected "Unsupported proxy accepted: $server"
    }
    Remove-Item Function:\Get-ItemProperty
    . ([scriptblock]::Create((Import-FixtureFunction (Join-Path $PSScriptRoot 'Install.ps1') 'Install-QodexDependencies')))
    $node=(Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $npm=Join-Path $fixture 'fake-npm.mjs'
    [IO.File]::WriteAllText($npm,@'
import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2),at=args.indexOf('--prefix'),root=at<0?process.cwd():args[at+1];
fs.appendFileSync(new URL('./calls.txt',import.meta.url),args[0]+'\n');
if(args[0]==='ci'){if(fs.existsSync(new URL('./fail',import.meta.url)))process.exit(1);fs.mkdirSync(path.join(root,'node_modules'),{recursive:true});fs.writeFileSync(path.join(root,'node_modules','ready'),'ok');}
if(args[0]==='ls'&&!fs.existsSync(path.join(root,'node_modules','ready')))process.exit(1);
'@,(New-Object Text.UTF8Encoding($false)))
    foreach ($name in @('package.json','package-lock.json','config.json')) { [IO.File]::WriteAllText((Join-Path $fixture $name),'{}') }
    [IO.File]::WriteAllText((Join-Path $fixture 'scripts\patch-snowluma-sdk.mjs'),'// fixture')
    Install-QodexDependencies $node $npm $fixture
    Assert (Test-Path -LiteralPath (Join-Path $fixture 'node_modules\ready')) 'First install failed.'
    Install-QodexDependencies $node $npm $fixture
    $calls=Get-Content -LiteralPath (Join-Path $fixture 'calls.txt') -Raw
    Assert (([regex]::Matches($calls,'(?m)^ci$')).Count -eq 1) 'Repeated installation reran npm ci.'
    Remove-Item -LiteralPath (Join-Path $fixture 'node_modules\ready')
    [IO.File]::WriteAllText((Join-Path $fixture 'node_modules\previous'),'preserve me')
    [IO.File]::WriteAllText((Join-Path $fixture 'fail'),'1')
    $rejected=$false;try { Install-QodexDependencies $node $npm $fixture } catch { $rejected=$true }
    Assert $rejected 'Failed npm install was accepted.'
    Assert ((Get-Content -LiteralPath (Join-Path $fixture 'node_modules\previous') -Raw) -eq 'preserve me') 'Failed staged install damaged existing dependencies.'
    Assert ((Get-Content -LiteralPath (Join-Path $fixture 'config.json') -Raw) -eq '{}') 'Installation changed configuration.'
    Assert (@(Get-ChildItem -LiteralPath $fixture -Directory -Filter '.qodex-install-*').Count -eq 0) 'Installation leaked staging directories.'
    # Execute the real install control flow with mocked dependency/account/script boundaries.
    $common=@'
function Get-QodexRoot { return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')) }
function Get-QodexNode { if ($env:QODEX_FIXTURE_FAIL -eq 'node') { throw 'fixture missing Node' }; return (Get-Command node.exe).Source }
function Get-QodexCodexExe { param($Configured) return (Join-Path (Get-QodexRoot) 'codex.exe') }
function Read-QodexConfig { param($Root) return [pscustomobject]@{controlPort=43110;codex=[pscustomobject]@{exe='fixture'}} }
function Assert-QodexConfig { param($Config) }
function Unprotect-QodexSecretObject { param($Root) return @{} }
function Assert-QodexPort { param($Port,$Name) return $Port }
function Test-QodexPortOpen { param($Port) return ($env:QODEX_FIXTURE_FAIL -eq 'running') }
'@
    [IO.File]::WriteAllText((Join-Path $fixture 'scripts\windows\Common.ps1'),$common,(New-Object Text.UTF8Encoding($true)))
    $overrides=@'
function Install-QodexDependencies { param($Node,$Npm,$Root) Add-Content -LiteralPath (Join-Path $Root 'flow.txt') 'dependencies'; if ($env:QODEX_FIXTURE_FAIL -eq 'dependencies') { throw 'fixture dependency failure' } }
function Test-QodexInstallAccount { param($Node,$Root) Add-Content -LiteralPath (Join-Path $Root 'flow.txt') 'account'; return ($env:QODEX_FIXTURE_READY -eq '1') }
function Invoke-QodexInstallScript {
 param($Root,$Name)
 Add-Content -LiteralPath (Join-Path $Root 'flow.txt') $Name
 if ($env:QODEX_FIXTURE_FAIL -eq $Name) { throw 'fixture script failure' }
 if ($Name -eq 'Setup.ps1' -and -not (Test-Path -LiteralPath (Join-Path $Root 'config.json'))) { [IO.File]::WriteAllText((Join-Path $Root 'config.json'),'first-config') }
}
'@
    $original=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Install.ps1') -Raw -Encoding UTF8
    $controlFlow=$original.Replace('$previousExe = $env:QBOT_CODEX_EXE',($overrides + "`n" + '$previousExe = $env:QBOT_CODEX_EXE'))
    [IO.File]::WriteAllText((Join-Path $fixture 'scripts\windows\Install.ps1'),$controlFlow,(New-Object Text.UTF8Encoding($true)))
    foreach ($case in @('first','repeat','dependencies','Login-Codex.ps1','node','running')) {
        $configPath=Join-Path $fixture 'config.json'
        $flowPath=Join-Path $fixture 'flow.txt'
        Remove-Item -LiteralPath $configPath,$flowPath -Force -ErrorAction SilentlyContinue
        $existing=$case -in @('repeat','running')
        if ($existing) { [IO.File]::WriteAllText($configPath,'existing-config-unchanged') }
        $info=New-Object Diagnostics.ProcessStartInfo
        $info.FileName=Join-Path $PSHOME 'powershell.exe'
        $info.Arguments='-NoProfile -ExecutionPolicy Bypass -STA -File "' + (Join-Path $fixture 'scripts\windows\Install.ps1') + '" -NoLaunch'
        $info.WorkingDirectory=$fixture;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
        $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
        $info.EnvironmentVariables['QODEX_FIXTURE_READY']=$(if($case -eq 'repeat'){'1'}else{'0'})
        $info.EnvironmentVariables['QODEX_FIXTURE_FAIL']=$case
        $process=[Diagnostics.Process]::Start($info)
        try {
            $process.StandardInput.WriteLine('Y');$process.StandardInput.Close()
            Assert ($process.WaitForExit(15000)) "Install flow timed out: $case"
            $resultText=$process.StandardOutput.ReadToEnd()+$process.StandardError.ReadToEnd()
            Assert (($process.ExitCode -eq 0) -eq ($case -in @('first','repeat'))) "Unexpected install result for ${case}: $resultText"
        } finally { $process.Dispose() }
        $flow=@(); if(Test-Path -LiteralPath $flowPath){$flow=@(Get-Content -LiteralPath $flowPath)}
        $expected=switch($case){'first'{@('dependencies','account','Login-Codex.ps1','Setup.ps1')};'repeat'{@('dependencies','account','Setup.ps1')};'dependencies'{@('dependencies')};'Login-Codex.ps1'{@('dependencies','account','Login-Codex.ps1')};default{@()}}
        Assert (($flow -join ',') -eq ($expected -join ',')) "Unexpected install order: $case"
        if($existing){Assert ((Get-Content -LiteralPath $configPath -Raw) -eq 'existing-config-unchanged') 'Repeat install changed configuration.'}
        elseif($case -ne 'first'){Assert (-not(Test-Path -LiteralPath $configPath)) 'Failed install created configuration.'}
    }
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'Install.bat') -Destination (Join-Path $fixture 'Install.bat')
    [IO.File]::WriteAllText((Join-Path $fixture 'scripts\windows\Install.ps1'),"[IO.File]::WriteAllText((Join-Path `$PSScriptRoot 'bat-ok.txt'),'ok')",(New-Object Text.UTF8Encoding($true)))
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$env:ComSpec
    $info.Arguments='/d /s /c ""' + (Join-Path $fixture 'Install.bat') + '" -NoLaunch"'
    $info.WorkingDirectory=$fixture;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $process=[Diagnostics.Process]::Start($info)
    try { Assert ($process.WaitForExit(10000)) 'BAT launch timed out.'; Assert ($process.ExitCode -eq 0) 'BAT launch failed.' } finally { $process.Dispose() }
    Assert (Test-Path -LiteralPath (Join-Path $fixture 'scripts\windows\bat-ok.txt')) 'BAT did not preserve Unicode/spaces/cmd metacharacters.'
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'Qodex.bat') -Destination (Join-Path $fixture 'Qodex.bat')
    [IO.File]::WriteAllText((Join-Path $fixture 'scripts\windows\Launcher.ps1'),"[IO.File]::WriteAllText((Join-Path `$PSScriptRoot 'launcher-bat-ok.txt'),'ok')",(New-Object Text.UTF8Encoding($true)))
    $info.Arguments='/d /v:off /s /c ""' + (Join-Path $fixture 'Qodex.bat') + '""'
    $process=[Diagnostics.Process]::Start($info)
    try { Assert ($process.WaitForExit(10000)) 'Launcher BAT timed out.'; Assert ($process.ExitCode -eq 0) 'Launcher BAT failed.' } finally { $process.Dispose() }
    Assert (Test-Path -LiteralPath (Join-Path $fixture 'scripts\windows\launcher-bat-ok.txt')) 'Launcher BAT did not preserve Unicode/spaces/metacharacters.'
    Write-Output 'PASS installer: PowerShell5 parsing, read-only proxy, staged npm install, repeat/failure preservation, first/repeat/login/dependency/prerequisite/running flow gates, BAT Unicode/spaces/metacharacters.'
} finally {
    if ($fixture.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($fixture) -like 'Qodex install *') { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}
