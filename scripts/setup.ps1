[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectDir '.env'
$automaticBackupDir = Join-Path $projectDir 'backups\automatic'
[System.IO.Directory]::CreateDirectory($automaticBackupDir) | Out-Null
if (Test-Path -LiteralPath $envPath) {
    Write-Host '.env already exists. Existing configuration was preserved.'
    exit 0
}
$randomBytes = New-Object byte[] 32
$generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
$dbPassword = -join ($randomBytes | ForEach-Object { $_.ToString('x2') })
$config = @"
POSTGRES_DB=millplan
POSTGRES_USER=millplan
POSTGRES_PASSWORD=$dbPassword
APP_PORT=8080
DATABASE_URL=postgresql://millplan:${dbPassword}@127.0.0.1:5434/millplan
HOST=127.0.0.1
PORT=8080
ALLOWED_ORIGINS=http://127.0.0.1:5178,http://localhost:5178
AUTOMATIC_BACKUP_INTERVAL_HOURS=24
AUTOMATIC_BACKUP_RETENTION_COUNT=14
"@
[System.IO.File]::WriteAllText($envPath, $config, (New-Object System.Text.UTF8Encoding($false)))
Write-Host 'Created .env with a random database password. Keep this file private.'
