@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo SSH Nexus GitHub Publisher
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-github.ps1"
set "PUBLISH_EXIT=%ERRORLEVEL%"

if not "%PUBLISH_EXIT%"=="0" (
  echo.
  echo Publishing failed. Review the error message above.
  pause
  exit /b %PUBLISH_EXIT%
)

echo.
echo Publishing completed successfully.
pause
