@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0scripts\windows\Launcher.ps1" %*
set "qodex_result=%errorlevel%"
if not "%qodex_result%"=="0" pause
exit /b %qodex_result%
