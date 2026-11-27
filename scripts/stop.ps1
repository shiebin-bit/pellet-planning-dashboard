[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'desktop-command.ps1')
$command = Get-MillplanCommand
$stopArgs = @($command.Arguments) + @('--quit')
Start-Process -FilePath $command.Executable -ArgumentList $stopArgs -WindowStyle Hidden | Out-Null
Write-Host 'Requested safe shutdown of Millplan and its local PostgreSQL database.'
