@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop Poker.ps1"
if errorlevel 1 (
  echo Could not stop the poker server.
  pause
  exit /b 1
)
timeout /t 3 >nul
exit /b 0