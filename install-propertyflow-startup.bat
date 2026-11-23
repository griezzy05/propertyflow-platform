@echo off
setlocal
set "PROPERTYFLOW_PROJECT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$startup = [Environment]::GetFolderPath('Startup'); $target = Join-Path $env:PROPERTYFLOW_PROJECT_DIR 'launch-propertyflow.bat'; if (-not (Test-Path $target)) { Write-Error 'PropertyFlow launcher was not found.'; exit 1 }; $shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut((Join-Path $startup 'PropertyFlow.lnk')); $shortcut.TargetPath = $target; $shortcut.WorkingDirectory = $env:PROPERTYFLOW_PROJECT_DIR; $shortcut.WindowStyle = 7; $shortcut.Description = 'Start the local PropertyFlow service when you sign in'; $shortcut.Save(); Write-Output 'PropertyFlow will start automatically when this Windows account signs in.'"
if errorlevel 1 (
  echo Could not register PropertyFlow in the Windows Startup folder.
  exit /b 1
)
