[CmdletBinding()]
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectDir
try {
    & (Join-Path $PSScriptRoot 'setup.ps1')
    & docker compose up --build -d --wait
    if ($LASTEXITCODE -ne 0) { throw 'Docker startup failed. Check Docker Desktop and docker compose logs.' }
    $appPort = 8080
    $portLine = Get-Content -LiteralPath (Join-Path $projectDir '.env') | Where-Object { $_ -match '^APP_PORT=\d+$' } | Select-Object -Last 1
    if ($portLine) { $appPort = [int]($portLine -replace '^APP_PORT=', '') }
    $appUrl = "http://127.0.0.1:$appPort"
    Write-Host "Millplan is ready: $appUrl"
    if (-not $NoBrowser) { Start-Process -FilePath $appUrl }
} finally { Pop-Location }
