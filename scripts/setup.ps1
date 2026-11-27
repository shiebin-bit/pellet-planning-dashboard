[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectDir
try {
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'For source development, install Node.js 24. Company PCs should use the Millplan Setup installer instead.' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDir 'node_modules\electron\dist\electron.exe'))) {
        & npm.cmd ci --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    & (Join-Path $PSScriptRoot 'prepare-postgres.ps1')
    & npm.cmd run desktop:prepare
    if ($LASTEXITCODE -ne 0) { throw 'Desktop preparation failed.' }
    Write-Host 'Desktop build prepared. Existing workspace data and private .env were preserved.'
} finally { Pop-Location }
