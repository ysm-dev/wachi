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
$ChecksumUrl = "$Url.sha256"
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\wachi\bin"
$Dest = Join-Path $InstallDir "wachi.exe"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Temp = Join-Path $InstallDir (".wachi-{0}.exe" -f [Guid]::NewGuid().ToString("N"))
$ChecksumTemp = "$Temp.sha256"
$Backup = Join-Path $InstallDir (".wachi-{0}.bak" -f [Guid]::NewGuid().ToString("N"))
$ReplacedExisting = $false

try {
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Temp -ErrorAction Stop
  try {
    Invoke-WebRequest -Uri $ChecksumUrl -OutFile $ChecksumTemp -ErrorAction Stop
    $Expected = (Get-Content -LiteralPath $ChecksumTemp -Raw).Trim().ToLowerInvariant()
  } catch {
    # v0.6.0 predates checksum sidecars. This is its GitHub-published digest.
    $Expected = "c23d3fc57ced1d8d5c3e0d83fa3e9f922a36b896ba39a12ba47e663f49b2c958"
  }
  if ($Expected -notmatch "^[0-9a-f]{64}$") {
    throw "Release checksum is invalid"
  }
  $Actual = (Get-FileHash -LiteralPath $Temp -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) {
    throw "Downloaded file failed SHA-256 verification"
  }
  $PreviousNoAutoUpdate = $env:WACHI_NO_AUTO_UPDATE
  $env:WACHI_NO_AUTO_UPDATE = "1"
  & $Temp version | Out-Null
  $env:WACHI_NO_AUTO_UPDATE = $PreviousNoAutoUpdate
  if ($LASTEXITCODE -ne 0) {
    throw "Downloaded file is not a working wachi binary"
  }

  if (Test-Path -LiteralPath $Dest) {
    [IO.File]::Replace($Temp, $Dest, $Backup, $true)
    $ReplacedExisting = $true
  } else {
    [IO.File]::Move($Temp, $Dest)
  }
} catch {
  if (Test-Path -LiteralPath $Backup) {
    try {
      if (Test-Path -LiteralPath $Dest) {
        Remove-Item -LiteralPath $Dest -Force -ErrorAction Stop
      }
      [IO.File]::Move($Backup, $Dest)
    } catch {
      throw "Installation failed and the previous binary could not be restored. Recovery copy: $Backup"
    }
  }
  throw
} finally {
  if (Test-Path -LiteralPath $Temp) {
    Remove-Item -LiteralPath $Temp -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $ChecksumTemp) {
    Remove-Item -LiteralPath $ChecksumTemp -Force -ErrorAction SilentlyContinue
  }
}

if ($ReplacedExisting -and (Test-Path -LiteralPath $Backup)) {
  Remove-Item -LiteralPath $Backup -Force -ErrorAction SilentlyContinue
}

Write-Host "Installed wachi to $Dest"
Write-Host "Ensure $InstallDir is on your PATH"
