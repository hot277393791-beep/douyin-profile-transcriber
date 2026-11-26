[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable exited with code $LASTEXITCODE" }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 22 or newer for Windows and reopen the terminal.'
}
$version = [version]((& node --version).TrimStart('v'))
if ($version.Major -lt 22) {
    throw 'Install Node.js 22 or newer for Windows and reopen the terminal.'
}

Push-Location -LiteralPath $root
try {
    Invoke-Checked 'npm.cmd' @('ci')
    Invoke-Checked (Join-Path $root 'node_modules\.bin\playwright.cmd') @('install', 'chromium')
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        if (-not (Get-Command py -ErrorAction SilentlyContinue)) { throw 'Install Python 3.11 for Windows with the Python Launcher.' }
        Invoke-Checked 'py' @('-3.11', '-m', 'venv', (Join-Path $root '.venv'))
    }
    Invoke-Checked $python @('-m', 'pip', 'install', 'torch', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cpu')
    Invoke-Checked $python @('-m', 'pip', 'install', '-r', 'requirements.txt')
    Invoke-Checked $python @('-c', 'import torch, torchaudio, funasr, modelscope, soundfile, yt_dlp; print(''Local ASR dependencies OK'')')
    Invoke-Checked 'node' @('-e', 'const {spawnSync} = require(''node:child_process''); const result = spawnSync(require(''@ffmpeg-installer/ffmpeg'').path, [''-version''], {stdio: ''ignore''}); process.exit(result.status === 0 ? 0 : 1);')
    Write-Host 'Setup complete. Run login.ps1 next.'
}
finally { Pop-Location }
