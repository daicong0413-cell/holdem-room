<#
  Opens a URL in a standalone app window: no tabs, no address bar, in the
  taskbar as its own entry — the closest thing to a desktop app without
  shipping one.

  Sized 16:9 and centred on the primary screen, and never larger than the
  usable area. Both launchers in this folder call it.

  Usage:  powershell -NoProfile -File open-app.ps1 -Url "http://127.0.0.1:8787"
#>
param([Parameter(Mandatory = $true)][string]$Url)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

function Find-Browser {
  foreach ($candidate in @(
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
      "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
      "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
      "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe")) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

# 16:9, centred. Falls back to a sane window if the screen size is unavailable.
$width = 1280
$height = 720
$x = 80
$y = 60
try {
  Add-Type -AssemblyName System.Windows.Forms
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $height = [Math]::Min([int]($area.Height * 0.92), [int]($area.Width * 9 / 16))
  $width = [int]($height * 16 / 9)
  $x = $area.X + [int](($area.Width - $width) / 2)
  $y = $area.Y + [int](($area.Height - $height) / 2)
} catch {
  # Keep the defaults: a 1280x720 window near the top left.
}

$browser = Find-Browser
if (-not $browser) {
  Start-Process $Url
  exit 0
}

Start-Process -FilePath $browser -ArgumentList @(
  "--app=$Url",
  "--user-data-dir=$root\.app-profile",
  "--window-size=$width,$height",
  "--window-position=$x,$y",
  "--no-first-run",
  "--no-default-browser-check"
)
