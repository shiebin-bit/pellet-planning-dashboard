[CmdletBinding()]
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'desktop-command.ps1')
$command = Get-MillplanCommand
$launchArgs = @($command.Arguments)
if ($NoBrowser) { $launchArgs += '--hidden' }
if ($launchArgs.Count -gt 0) {
    Start-Process -FilePath $command.Executable -ArgumentList $launchArgs -WindowStyle Hidden
} else {
    Start-Process -FilePath $command.Executable -WindowStyle Hidden
}
Write-Host 'Starting Millplan desktop. Closing its window keeps it in the system tray; choose Quit to stop.'
