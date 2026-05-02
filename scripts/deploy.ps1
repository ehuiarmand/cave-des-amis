#Requires -Version 5.1
<#
  Déploiement manuel vers le VPS : archive Git (fichiers suivis uniquement) + copie SSH + extraction.
  Ne remplace pas GitHub Actions ; utile pour pousser depuis ton PC sans attendre le workflow.

  Usage (depuis la racine du dépôt ou n'importe où) :
    .\scripts\deploy.ps1
    .\scripts\deploy.ps1 -Push              # git push puis déploiement
    .\scripts\deploy.ps1 -Branch master
    .\scripts\deploy.ps1 -SkipRestart

  Configuration : copier deploy.local.env.example vers deploy.local.env
#>
param(
    [switch]$Push,
    [switch]$SkipRestart,
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")
Set-Location $RepoRoot

$envFile = Join-Path $RepoRoot "deploy.local.env"
if (-not (Test-Path $envFile)) {
    Write-Host "Créez le fichier deploy.local.env (voir deploy.local.env.example)." -ForegroundColor Red
    exit 1
}

Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -match '^\s*#' -or $line -eq "") { return }
    if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
        $name = $Matches[1]
        $value = $Matches[2].Trim().Trim('"')
        Set-Item -Path "Env:$name" -Value $value
    }
}

foreach ($key in @("DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_PATH")) {
    if ([string]::IsNullOrWhiteSpace((Get-Item "Env:$key" -ErrorAction SilentlyContinue).Value)) {
        Write-Host "Variable $key manquante dans deploy.local.env" -ForegroundColor Red
        exit 1
    }
}

$gitCheck = & git rev-parse --is-inside-work-tree 2>$null
if ($LASTEXITCODE -ne 0 -or $gitCheck -ne "true") {
    Write-Host "Ce dossier n'est pas un dépôt Git." -ForegroundColor Red
    exit 1
}

foreach ($cmd in @("git", "ssh", "scp")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "Commande requise introuvable : $cmd (installez Git et OpenSSH Client)." -ForegroundColor Red
        exit 1
    }
}

if ($Push) {
    Write-Host "git push origin $Branch ..." -ForegroundColor Cyan
    & git push origin $Branch
    if ($LASTEXITCODE -ne 0) {
        Write-Host "git push a échoué." -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Host "Création de l'archive Git (fichiers versionnés uniquement)..." -ForegroundColor Cyan
$tmpTar = Join-Path ([System.IO.Path]::GetTempPath()) ("cave-deploy-" + [Guid]::NewGuid().ToString() + ".tar")
& git archive --format=tar -o $tmpTar HEAD
if ($LASTEXITCODE -ne 0) {
    Write-Host "git archive a échoué." -ForegroundColor Red
    exit $LASTEXITCODE
}

$remote = "$env:DEPLOY_USER@$env:DEPLOY_HOST"
$remoteTar = "/tmp/cave-deploy-$([Guid]::NewGuid().ToString('N').Substring(0,8)).tar"

try {
    Write-Host "Copie vers $remote ..." -ForegroundColor Cyan
    & scp $tmpTar "${remote}:$remoteTar"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "scp a échoué." -ForegroundColor Red
        exit $LASTEXITCODE
    }

    $path = $env:DEPLOY_PATH
    $extractCmd = "tar -xf $remoteTar -C `"$path`" && rm -f $remoteTar"
    Write-Host "Extraction sur le serveur dans $path ..." -ForegroundColor Cyan
    & ssh $remote $extractCmd
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ssh / tar a échoué." -ForegroundColor Red
        exit $LASTEXITCODE
    }

    if (-not $SkipRestart -and -not [string]::IsNullOrWhiteSpace($env:RESTART_SERVICE)) {
        Write-Host "systemctl restart $($env:RESTART_SERVICE) ..." -ForegroundColor Cyan
        & ssh $remote "sudo systemctl restart $($env:RESTART_SERVICE)"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Redémarrage du service a échoué (vérifiez sudo sur le VPS)." -ForegroundColor Yellow
        }
    }
}
finally {
    if (Test-Path $tmpTar) { Remove-Item $tmpTar -Force -ErrorAction SilentlyContinue }
}

Write-Host "Déploiement terminé." -ForegroundColor Green
