@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS first.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm.cmd ci
  if errorlevel 1 goto failed
)
if not exist dist-server\server\index.js (
  call npm.cmd run build
  if errorlevel 1 goto failed
)
node dist-server\server\index.js --open
if errorlevel 1 goto failed
exit /b 0
:failed
echo Startup failed. See the error above.
pause
exit /b 1
