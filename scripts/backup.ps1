[CmdletBinding()]
param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'desktop-command.ps1')
$command = Get-MillplanCommand
if (-not $OutputPath) {
    $backupDir = Join-Path $env:LOCALAPPDATA 'FFM\MillPlan\backups\database'
    $OutputPath = Join-Path $backupDir ('millplan-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.dump')
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $OutputPath) { throw 'The requested backup file already exists. Choose a new filename.' }
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($OutputPath)) | Out-Null
$statusPath = $OutputPath + '.status.json'
if (Test-Path -LiteralPath $statusPath) { throw 'Backup status file already exists. Choose a new filename.' }
$backupArgs = @($command.Arguments) + @('--backup-and-exit', ('"--backup-output=' + $OutputPath + '"'))
Start-Process -FilePath $command.Executable -ArgumentList $backupArgs -WindowStyle Hidden | Out-Null
$deadline = [DateTime]::UtcNow.AddMinutes(3)
while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $statusPath) {
        $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
        if (-not $status.ok) { throw ('Database backup failed: ' + $status.error) }
        if (-not (Test-Path -LiteralPath $OutputPath)) { throw 'Backup completed without the requested output file.' }
        Write-Host "Database backup saved: $OutputPath"
        return
    }
    Start-Sleep -Milliseconds 300
}
throw 'Backup confirmation timed out. Check the private desktop log and destination before retrying.'
