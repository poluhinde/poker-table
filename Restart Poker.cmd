@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restart Poker.ps1"
if errorlevel 1 (
  pause
  exit /b 1
)
call "%~dp0Start Poker.cmd"
