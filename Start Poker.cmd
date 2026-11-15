@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start Poker.ps1"
if errorlevel 1 goto failed
exit /b 0
:failed
echo Startup failed. See the error above.
pause
exit /b 1
