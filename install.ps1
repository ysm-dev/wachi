$ErrorActionPreference = "Stop"

$Repo = "ysm-dev/wachi"
$Version = "latest"
$Arch = $env:PROCESSOR_ARCHITECTURE

switch ($Arch) {
  "AMD64" { $Arch = "x64" }
  default {
    throw "Unsupported architecture: $Arch"
  }
}

$Asset = "wachi-win32-$Arch.exe"
$Url = "https://github.com/$Repo/releases/$Version/download/$Asset"
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\wachi\bin"
$Dest = Join-Path $InstallDir "wachi.exe"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Write-Host "Downloading $Url"
Invoke-WebRequest -Uri $Url -OutFile $Dest

Write-Host "Installed wachi to $Dest"
Write-Host "Ensure $InstallDir is on your PATH"
