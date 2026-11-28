[CmdletBinding()]
param([string]$VcRuntimeDir = $env:MILLPLAN_VC_RUNTIME_DIR)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$vendorDir = Join-Path $projectDir 'output\vendor'
$archive = Join-Path $vendorDir 'postgresql-16.16-2-windows-x64-binaries.zip'
$expectedHash = 'add1de261b150e6923266abee293f05050795e73f5356158aee4221a2170c073'
$url = 'https://get.enterprisedb.com/postgresql/postgresql-16.16-2-windows-x64-binaries.zip'
function Get-Sha256File([string]$Path) {
    # .NET works in both Windows PowerShell 5.1 and PowerShell 7, including
    # build agents whose inherited module path does not expose Get-FileHash.
    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Test-EqualStreams($Left, $Right) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $a = [Convert]::ToBase64String($algorithm.ComputeHash($Left))
        $b = [Convert]::ToBase64String($algorithm.ComputeHash($Right))
        return $a -eq $b
    } finally { $algorithm.Dispose() }
}
[System.IO.Directory]::CreateDirectory($vendorDir) | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
    & curl.exe --fail --location --retry 3 --output $archive $url
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL download failed. Remove the incomplete archive before retrying.' }
}
if ((Get-Sha256File $archive) -ne $expectedHash) {
    throw 'PostgreSQL archive checksum mismatch. Remove the incomplete archive and retry.'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
try {
    foreach ($entry in $zip.Entries) {
        # Exclude pgAdmin, StackBuilder and development documentation. Retain runtime
        # libraries, initdb resources, command-line tools and distribution notices.
        if ($entry.FullName -notmatch '^pgsql/(bin/|lib/|share/|[^/]*(LICENSE|COPYRIGHT|NOTICE|licence)[^/]*$)' -or -not $entry.Name) { continue }
        $target = [System.IO.Path]::GetFullPath((Join-Path $vendorDir $entry.FullName))
        $allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $vendorDir 'pgsql')) + [System.IO.Path]::DirectorySeparatorChar
        if (-not $target.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive path.' }
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
        if ((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target).Length -eq $entry.Length) {
            $archivedStream = $entry.Open()
            $existingStream = [System.IO.File]::OpenRead($target)
            try { $unchanged = Test-EqualStreams $archivedStream $existingStream }
            finally { $archivedStream.Dispose(); $existingStream.Dispose() }
            if ($unchanged) { continue }
        }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
} finally { $zip.Dispose() }
foreach ($tool in @('postgres', 'pg_ctl', 'initdb', 'pg_dump', 'pg_restore', 'psql', 'createdb')) {
    if (-not (Test-Path -LiteralPath (Join-Path $vendorDir "pgsql\bin\$tool.exe"))) { throw "Missing PostgreSQL tool: $tool" }
}
if (-not $VcRuntimeDir) {
    $vsRoots = @((Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio'), (Join-Path $env:ProgramFiles 'Microsoft Visual Studio'))
    $candidates = foreach ($vsRoot in $vsRoots) {
        if (Test-Path -LiteralPath $vsRoot) {
            Get-ChildItem -Path (Join-Path $vsRoot '*\*\VC\Redist\MSVC\*\x64\Microsoft.VC*.CRT') -Directory -ErrorAction SilentlyContinue
        }
    }
    $selected = $candidates | Sort-Object FullName -Descending | Select-Object -First 1
    if ($selected) { $VcRuntimeDir = $selected.FullName }
}
if (-not $VcRuntimeDir) { throw 'Building requires Visual Studio C++ Redistributable x64 files. Install the C++ Build Tools component or set MILLPLAN_VC_RUNTIME_DIR to its licensed x64 Microsoft.VC*.CRT directory.' }
foreach ($dll in @('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')) {
    $source = Join-Path $VcRuntimeDir $dll
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing redistributable runtime: $dll" }
    $runtimeTarget = Join-Path $vendorDir "pgsql\bin\$dll"
    if (-not (Test-Path -LiteralPath $runtimeTarget) -or (Get-Sha256File $source) -ne (Get-Sha256File $runtimeTarget)) {
        Copy-Item -LiteralPath $source -Destination $runtimeTarget -Force
    }
}
$notice = @'
Microsoft Visual C++ Runtime (x64)
Copyright Microsoft Corporation. All rights reserved.
These application-local redistributable DLLs originate from the build machine's
licensed Visual Studio C++ Redist directory, not its Windows system directory.
Use and redistribution are subject to the applicable Microsoft Software License Terms.
https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files
https://visualstudio.microsoft.com/license-terms/
'@
[System.IO.File]::WriteAllText((Join-Path $vendorDir 'pgsql\MICROSOFT-CRT-NOTICE.txt'), $notice)
Write-Host 'Verified PostgreSQL 16.16 runtime prepared in output/vendor/pgsql.'
