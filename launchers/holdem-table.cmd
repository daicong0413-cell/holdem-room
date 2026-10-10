@echo off
setlocal
rem ===========================================================================
rem  Opens the poker table in a standalone app window (16:9, centred).
rem  Double-click this file. If the server is not running it starts it first.
rem ===========================================================================

set "ROOT=%~dp0.."
set "URL=http://127.0.0.1:8787"

rem --- 1. is the server already answering? ---------------------------------
curl -s -o nul --max-time 2 "%URL%/healthz" >nul 2>&1
if not errorlevel 1 goto open

echo Starting the holdem server...
rem /d sets the working directory, which avoids fragile nested quoting
start "holdem-server" /min /d "%ROOT%" node src/server/main.ts

rem give it a moment to bind the port
for /l %%i in (1,1,20) do (
  curl -s -o nul --max-time 1 "%URL%/healthz" >nul 2>&1
  if not errorlevel 1 goto open
  timeout /t 1 /nobreak >nul
)
echo The server did not come up. Run "npm start" in the project folder to see why.
pause
exit /b 1

:open
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-app.ps1" -Url "%URL%" -TitleLike "*德州扑克*"
exit /b 0
