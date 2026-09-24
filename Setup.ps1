$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'scripts\windows\Setup.ps1') @args
