@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed. Please install Node.js 22.12 or newer.
    pause
    exit /b 1
  )
)
set ELECTRON_RUN_AS_NODE=
start "LanDrop" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
