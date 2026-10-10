@echo off
setlocal
rem ===========================================================================
rem  Rebuilds docs/git-graph.svg from the current history, then opens it in a
rem  standalone app window (no tabs, no address bar). Double-click this file.
rem ===========================================================================

set "ROOT=%~dp0.."
set "SVG=%ROOT%\docs\git-graph.svg"
set "PROFILE=%ROOT%\.app-profile"

cd /d "%ROOT%"

rem --- refresh the graph; if this fails the existing file is still shown ----
echo Rebuilding the commit graph...
call npm run --silent graph
if errorlevel 1 echo (could not rebuild; showing the last generated graph)

if not exist "%SVG%" (
  echo %SVG% is missing. Run "npm run graph" in the project folder first.
  pause
  exit /b 1
)

call :findbrowser
if not defined BROWSER (
  echo Chrome or Edge was not found; opening in the default browser instead.
  start "" "%SVG%"
  exit /b 0
)

rem file:// needs forward slashes
set "SVGURL=file:///%SVG:\=/%"
start "" "%BROWSER%" --app="%SVGURL%" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check
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
