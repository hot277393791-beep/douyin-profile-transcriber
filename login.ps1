[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\playwright') -PathType Container)) {
    throw 'Run setup.ps1 first.'
}
& node (Join-Path $root 'scripts\douyin-login.js') --storage-state (Join-Path $root '.auth\douyin-storage-state.json')
if ($LASTEXITCODE -ne 0) { throw "Douyin login exited with code $LASTEXITCODE" }
