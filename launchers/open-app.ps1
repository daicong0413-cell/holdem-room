<#
  Opens a URL in a standalone app window: no tabs, no address bar, in the
  taskbar as its own entry — the closest thing to a desktop app without
  shipping one.

  Sized 16:9, centred on the primary screen, and never larger than the usable
  area. Both launchers in this folder call it.

  Usage:
    powershell -NoProfile -File open-app.ps1 -Url "http://127.0.0.1:8787"
    powershell -NoProfile -File open-app.ps1 -Url "..." -DryRun   # just print geometry
#>
param(
  [Parameter(Mandatory = $true)][string]$Url,
  # Window title of the app window to close first, e.g. "*德州扑克*".
  [string]$TitleLike = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$profileDir = Join-Path $root ".app-profile"

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

# ---------------------------------------------------------------- 16:9, centred
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

if ($DryRun) {
  Write-Host "窗口 ${width}x${height}  位置 ($x, $y)  比例 $([Math]::Round($width / $height, 3))"
  exit 0
}

$browser = Find-Browser
if (-not $browser) {
  Start-Process $Url
  exit 0
}

# Chrome drops --window-size/--window-position when an instance with the same
# user-data-dir is already running: the request is forwarded to it and the new
# window keeps whatever geometry that instance used last. So close our own app
# window first, then launch fresh and the flags take effect.
#
# Matched by window title rather than by command line: reading another process's
# command line needs CIM, which is not always permitted. Ordinary browsing
# windows have different titles, so they are left alone.
if ($TitleLike.Length -gt 0) {
  Get-Process chrome, msedge -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -like $TitleLike } |
    ForEach-Object {
      Write-Host "关闭已打开的 $($_.MainWindowTitle)"
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  Start-Sleep -Milliseconds 800
}

$process = Start-Process -FilePath $browser -PassThru -ArgumentList @(
  "--app=$Url",
  "--user-data-dir=$profileDir",
  "--window-size=$width,$height",
  "--window-position=$x,$y",
  "--no-first-run",
  "--no-default-browser-check"
)

# Belt and braces: those flags are advisory, so place the window ourselves.
try {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AppWindow {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
}
"@

  $placed = $false

  # Normally we started the browser ourselves, so its handle is the app window.
  for ($attempt = 0; $attempt -lt 32 -and -not $placed; $attempt++) {
    Start-Sleep -Milliseconds 250
    $live = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    if ($live -and $live.MainWindowHandle -ne 0) {
      $placed = [AppWindow]::MoveWindow($live.MainWindowHandle, $x, $y, $width, $height, $true)
    }
  }

  # If Chrome handed the request to an instance that was already running, the
  # process we started is not the one holding the window. Fall back to the title.
  if (-not $placed -and $TitleLike.Length -gt 0) {
    Get-Process chrome, msedge -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like $TitleLike } |
      Select-Object -First 1 |
      ForEach-Object { [AppWindow]::MoveWindow($_.MainWindowHandle, $x, $y, $width, $height, $true) | Out-Null }
  }
} catch {
  # Positioning is best-effort; the flags above usually got us close.
}
