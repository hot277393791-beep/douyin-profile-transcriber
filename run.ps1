[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$Profile,
    [switch]$CollectOnly,
    [switch]$Resume,
    [ValidateRange(10, 1000)] [int]$MaxScrolls = 300,
    [string]$Python,
    [string]$ModelCache
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$match = [regex]::Match(($Profile -replace '\\:', ':'), 'https?://(?:www\.)?douyin\.com/user/[A-Za-z0-9_-]+|https?://v\.douyin\.com/[A-Za-z0-9_-]+/?', 'IgnoreCase')
if (-not $match.Success) { throw 'Provide a Douyin creator homepage URL or the share text containing a v.douyin.com link.' }
$profileUrl = ($match.Value -replace '^http:', 'https:').TrimEnd('/')
if ($profileUrl.StartsWith('https://v.douyin.com/')) { $profileUrl += '/' }
$algorithm = [Security.Cryptography.SHA256]::Create()
try { $runId = ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($profileUrl)))).Replace('-', '').Substring(0, 16).ToLowerInvariant() }
finally { $algorithm.Dispose() }

$run = Join-Path (Join-Path $root 'runs') $runId
$capture = Join-Path $run 'output'
$state = Join-Path $root '.auth\douyin-storage-state.json'
$slug = 'profile'
$summaryPath = Join-Path $capture "$slug-scrape-summary.json"
$worksPath = Join-Path $capture "$slug-visible-works.json"
$csvPath = Join-Path $capture "$slug-simple.csv"
$videoCsv = Join-Path $run 'videos.csv'
$transcripts = Join-Path $run 'transcripts.csv'
$progress = Join-Path $run 'transcript-progress.json'
$failures = Join-Path $run 'transcript-failures.csv'
if (-not $Python) { $Python = Join-Path $root '.venv\Scripts\python.exe' }
if (-not $ModelCache) { $ModelCache = Join-Path $root '.cache\asr' }
$ModelCache = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ModelCache)

function Read-Capture {
    if (-not (Test-Path -LiteralPath $summaryPath) -or -not (Test-Path -LiteralPath $worksPath) -or -not (Test-Path -LiteralPath $csvPath)) { return $null }
    $summary = Get-Content -Raw -LiteralPath $summaryPath -Encoding UTF8 | ConvertFrom-Json
    $works = Get-Content -Raw -LiteralPath $worksPath -Encoding UTF8 | ConvertFrom-Json
    $expected = if ($summary.bodyAwemeCountText) { [int]$summary.bodyAwemeCountText } else { [int]$summary.profileAwemeCount }
    return [pscustomobject]@{ Summary = $summary; Works = @($works | Where-Object { $null -ne $_ }); Expected = $expected }
}

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\playwright') -PathType Container)) { throw 'Run setup.ps1 first.' }
if (-not (Test-Path -LiteralPath $state -PathType Leaf) -and -not $Resume) { throw 'Run login.ps1 to sign in to Douyin first.' }
if (-not $CollectOnly) {
    $pythonCommand = Get-Command $Python -CommandType Application -ErrorAction SilentlyContinue
    if (-not $pythonCommand) { throw 'Run setup.ps1 to install the local speech runtime.' }
    $Python = $pythonCommand.Source
}
New-Item -ItemType Directory -Path $run -Force | Out-Null
$lock = [IO.File]::Open((Join-Path $run 'run.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)

Push-Location -LiteralPath $run
try {
    if (-not $Resume) {
        $captureUrl = $profileUrl
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            # A new capture replaces page files so the audio runner uses only fresh media URLs.
            if (Test-Path -LiteralPath $capture) {
                Get-ChildItem -LiteralPath $capture -Filter "$slug-post-page-*.json" -File | ForEach-Object { Remove-Item -LiteralPath $_.FullName }
            }
            foreach ($capturePath in @($summaryPath, $worksPath, $csvPath)) {
                if (Test-Path -LiteralPath $capturePath -PathType Leaf) { Remove-Item -LiteralPath $capturePath }
            }
            & node (Join-Path $root 'scripts\scrape-douyin-profile.js') --url $captureUrl --slug $slug --max-scrolls $MaxScrolls --wait-ms 1800 --headful --storage-state $state
            $captureExit = $LASTEXITCODE
            $attemptResult = Read-Capture
            if ($attemptResult.Summary.needsLogin) { throw 'Douyin requires login. Run login.ps1 and retry.' }
            if ($captureExit -eq 0 -and $attemptResult -and $attemptResult.Expected -gt 0 -and $attemptResult.Works.Count -eq $attemptResult.Expected) { break }
            if ($attemptResult.Summary.finalUrl -match '^https://www\.douyin\.com/user/[A-Za-z0-9_-]+') { $captureUrl = $Matches[0] }
            if ($attempt -lt 3) { Write-Host "Capture attempt $attempt was incomplete. Retrying the profile." }
        }
    }
    $snapshot = Read-Capture
    if (-not $snapshot) { throw 'No saved page capture. Run again without -Resume.' }
    $works = $snapshot.Works
    $expected = $snapshot.Expected
    if ($expected -le 0 -or $works.Count -ne $expected) {
        throw "The capture is incomplete. Page reports $expected works, browser found $($works.Count). Check Douyin login or retry. Raw capture: $capture"
    }
    $videos = @($works | Where-Object { $_.url -match '^https://www\.douyin\.com/video/\d+$' } | ForEach-Object { $_.url })
    if ($videos.Count -eq 0) { Write-Host "Found $expected works and no videos to transcribe."; return }
    $rows = @(Import-Csv -LiteralPath $csvPath -Encoding UTF8 | Where-Object { $_.'视频链接' -cin $videos })
    if ($rows.Count -ne $videos.Count -or (Compare-Object @($rows.'视频链接' | Sort-Object) @($videos | Sort-Object))) {
        throw "Video metadata is incomplete. Browser found $($videos.Count) video links, capture contains $($rows.Count) matching rows. Retry the capture. Raw capture: $capture"
    }
    $rows | Export-Csv -LiteralPath $videoCsv -Encoding UTF8 -NoTypeInformation
    Write-Host "Verified $expected works, including $($videos.Count) videos. Video list: $videoCsv"
    if ($CollectOnly) { return }

    & node (Join-Path $root 'scripts\local-douyin-transcribe.js') --input $videoCsv --output $transcripts --progress $progress --failures $failures --cache-dir (Join-Path $run 'media') --asr-cache-dir $ModelCache --storage-state $state --python $Python --slug $slug --device cpu
    if ($LASTEXITCODE -ne 0) { throw "Transcription exited with code $LASTEXITCODE. Run again with -Resume to retry." }
    $result = @(Import-Csv -LiteralPath $transcripts -Encoding UTF8)
    $successful = @($result | Where-Object { -not [string]::IsNullOrWhiteSpace($_.'中文文案') }).Count
    Write-Host "Transcribed $successful/$($videos.Count) videos. CSV: $transcripts"
    if ($successful -ne $videos.Count) { throw "Some videos need a retry. Failures: $failures. Run again with -Resume." }
}
finally {
    Pop-Location
    $lock.Dispose()
}
