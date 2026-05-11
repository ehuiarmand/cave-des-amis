Param(
  [string]$ProjectDir = (Split-Path -Parent $MyInvocation.MyCommand.Path),
  [string]$BackupFolderName = "Maquis-Manager-Backups",
  [int]$Keep = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-OneDriveRoot {
  $candidates = @(
    $env:OneDriveCommercial,
    $env:OneDriveConsumer,
    $env:OneDrive
  ) | Where-Object { $_ -and (Test-Path $_) }
  if ($candidates.Count -gt 0) { return $candidates[0] }
  return $null
}

$oneDrive = Get-OneDriveRoot
if (-not $oneDrive) {
  Write-Error "OneDrive introuvable. Assure-toi d'etre connecte a OneDrive (variable env OneDrive)."
}

$destRoot = Join-Path $oneDrive $BackupFolderName
New-Item -ItemType Directory -Force -Path $destRoot | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dest = Join-Path $destRoot ("backup-" + $stamp)
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$files = @(
  "data.json",
  "app.sqlite3",
  "app.sqlite3-wal",
  "app.sqlite3-shm",
  "audit.log.jsonl"
)

foreach ($name in $files) {
  $src = Join-Path $ProjectDir $name
  if (Test-Path $src) {
    Copy-Item -Force $src (Join-Path $dest $name)
  }
}

# Rotation
$all = Get-ChildItem -Path $destRoot -Directory | Sort-Object Name -Descending
if ($all.Count -gt $Keep) {
  $toDelete = $all | Select-Object -Skip $Keep
  foreach ($d in $toDelete) {
    Remove-Item -Recurse -Force $d.FullName
  }
}

Write-Output ("Backup OK: " + $dest)
