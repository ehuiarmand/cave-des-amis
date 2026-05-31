#Requires -Version 5.1
<#
  Génère guide.pdf à partir de guide.html (Chrome ou Edge headless).
  Usage : .\scripts\generate-guide-pdf.ps1
  À relancer après modification de guide.html ou GUIDE_UTILISATION.md.
#>
$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Html = Join-Path $RepoRoot "guide.html"
$Pdf = Join-Path $RepoRoot "guide.pdf"

if (-not (Test-Path $Html)) {
    Write-Host "Fichier introuvable : $Html" -ForegroundColor Red
    exit 1
}

$browsers = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
$exe = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
    Write-Host "Chrome ou Edge requis pour generer le PDF." -ForegroundColor Red
    exit 1
}

$htmlPath = (Resolve-Path $Html).Path -replace '\\', '/'
$uri = 'file:///' + ($htmlPath -replace ' ', '%20')

& $exe --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="$Pdf" "$uri" | Out-Null

if (-not (Test-Path $Pdf)) {
    Write-Host "Echec generation PDF." -ForegroundColor Red
    exit 1
}

$size = (Get-Item $Pdf).Length
Write-Host "OK : $Pdf ($size octets)" -ForegroundColor Green
