@echo off
setlocal
rem ===========================================================================
rem  Opens the poker table in a standalone app window (no tabs, no address bar).
rem  Double-click this file. If the server is not running it starts it first.
rem ===========================================================================

set "ROOT=%~dp0.."
set "URL=http://127.0.0.1:8787"
set "PROFILE=%ROOT%\.app-profile"

rem --- 1. is the server already answering? ---------------------------------
curl -s -o nul --max-time 2 "%URL%/healthz" >nul 2>&1
if not errorlevel 1 goto open

echo Starting the holdem server...
rem /d sets the working directory, which avoids fragile nested quoting
start "holdem-server" /min /d "%ROOT%" node src/server/main.ts

rem give it a moment to bind the port
for /l %%i in (1,1,15) do (
  curl -s -o nul --max-time 1 "%URL%/healthz" >nul 2>&1
  if not errorlevel 1 goto open
  timeout /t 1 /nobreak >nul
)
echo The server did not come up. Run "npm start" in the project folder to see why.
pause
exit /b 1

:open
call :findbrowser
if not defined BROWSER (
  echo Chrome or Edge was not found; opening in the default browser instead.
  start "" "%URL%"
  exit /b 0
)
start "" "%BROWSER%" --app="%URL%" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check
exit /b 0

rem --- locate a Chromium browser -------------------------------------------
:findbrowser
set "BROWSER="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
) do if not defined BROWSER if exist %%P set "BROWSER=%%~P"
exit /b 0
