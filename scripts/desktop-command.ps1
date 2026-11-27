function Get-MillplanCommand {
    $projectDir = Split-Path -Parent $PSScriptRoot
    $installed = Join-Path $env:LOCALAPPDATA 'Programs\Millplan\Millplan.exe'
    if (Test-Path -LiteralPath $installed) {
        return @{ Executable = $installed; Arguments = @() }
    }
    $electron = Join-Path $projectDir 'node_modules\electron\dist\electron.exe'
    $entry = Join-Path $projectDir 'desktop\main.cjs'
    if (-not (Test-Path -LiteralPath $electron)) { throw 'Install Millplan Setup first, or run scripts/setup.ps1 on a development computer.' }
    if (-not (Test-Path -LiteralPath $entry)) { throw 'Desktop entry is missing. Restore the reviewed application source.' }
    return @{ Executable = $electron; Arguments = @(('"' + $entry + '"')) }
}
