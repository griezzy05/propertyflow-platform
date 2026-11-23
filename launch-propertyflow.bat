@echo off
setlocal
cd /d "%~dp0"

set "NODE_ENV=development"
set "HOST=127.0.0.1"
set "PORT=3000"
set "APP_BASE_URL=http://127.0.0.1:3000"
set "DATABASE_URL="
set "PROPERTYFLOW_STORE_FILE=%~dp0data\store.json"
set "REMINDER_SCHEDULER_ENABLED=true"
set "PROPERTYFLOW_PROJECT_DIR=%~dp0"

if not exist "logs" mkdir "logs"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer, then try again.
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $health = Invoke-RestMethod 'http://127.0.0.1:3000/api/health' -TimeoutSec 2; if ($health.status -eq 'ok') { exit 0 } } catch {}; exit 1" >nul 2>nul
if not errorlevel 1 (
  echo PropertyFlow is already running. Opening the existing local app.
  start "" "http://127.0.0.1:3000"
  exit /b 0
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($listener) { exit 1 } else { exit 0 }" >nul 2>nul
if errorlevel 1 (
  echo Port 3000 is already in use by another application.
  echo Close that application or configure PropertyFlow to use another port.
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$output = Join-Path $env:PROPERTYFLOW_PROJECT_DIR 'logs\propertyflow.log'; $errors = Join-Path $env:PROPERTYFLOW_PROJECT_DIR 'logs\propertyflow-error.log'; $node = (Get-Command node.exe -ErrorAction Stop).Source; $process = Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $env:PROPERTYFLOW_PROJECT_DIR -WindowStyle Hidden -PassThru -RedirectStandardOutput $output -RedirectStandardError $errors; if (-not $process) { exit 1 }"
if errorlevel 1 (
  echo PropertyFlow could not be started. Check the log files under logs.
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "for ($attempt = 0; $attempt -lt 30; $attempt++) { try { $health = Invoke-RestMethod 'http://127.0.0.1:3000/api/health' -TimeoutSec 2; if ($health.status -eq 'ok') { exit 0 } } catch {}; Start-Sleep -Seconds 1 }; exit 1" >nul 2>nul
if errorlevel 1 (
  echo PropertyFlow did not become healthy. Check logs\propertyflow.log and logs\propertyflow-error.log.
  start "" notepad.exe "%~dp0logs\propertyflow-error.log"
  exit /b 1
)

echo PropertyFlow is running locally at http://127.0.0.1:3000
start "" "http://127.0.0.1:3000"
exit /b 0
