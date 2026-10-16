[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$backupDir = Join-Path $projectDir 'backups'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$filename = 'millplan-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.dump'
$backupPath = Join-Path $backupDir $filename
Push-Location -LiteralPath $projectDir
try {
    & docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/millplan-backup.dump'
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL backup failed.' }
    & docker compose cp 'db:/tmp/millplan-backup.dump' $backupPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not copy the backup out of Docker.' }
    & docker compose exec -T db rm -f /tmp/millplan-backup.dump
    Write-Host "Database backup saved: $backupPath"
} finally { Pop-Location }
