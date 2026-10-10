@echo off
setlocal
rem ===========================================================================
rem  Rebuilds docs/git-graph.svg from the current history, then opens it in a
rem  standalone app window. Double-click this file.
rem ===========================================================================

set "ROOT=%~dp0.."
set "SVG=%ROOT%\docs\git-graph.svg"

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

rem file:// needs forward slashes
set "SVGURL=file:///%SVG:\=/%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-app.ps1" -Url "%SVGURL%" -TitleLike "*git-graph*"
exit /b 0
