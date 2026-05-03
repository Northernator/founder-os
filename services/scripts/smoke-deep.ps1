# services/scripts/smoke-deep.ps1
# End-to-end smoke test for /research/deep.
#
# Posts a deep-research job, polls /research/jobs/{id} until done, then
# verifies research-summary.md + sources.json landed under
# ventures/<slug>/01_research/market-gaps/.
#
# Usage:
#   .\smoke-deep.ps1
#   .\smoke-deep.ps1 -VentureSlug my-test -Topic "agentic browsers 2026"
#   .\smoke-deep.ps1 -Depth 3 -TimeoutMinutes 8
#
# Notes:
#   - Depth 1-3 maps to GPT-Researcher report_type=research_report (single pass).
#   - Depth 4-5 upgrades to report_type=deep (recursive). Slower; bump
#     -TimeoutMinutes accordingly.
#   - Requires OPENAI_API_KEY in services/.env (same key 2c-competitors needs).

param(
    [string] $VentureSlug    = "smoke-deep",
    [string] $Topic          = "AI coding assistants 2026",
    [int]    $Depth          = 2,
    [string] $ReportType     = "research_report",
    [string] $BaseUrl        = "http://localhost:3030",
    [int]    $TimeoutMinutes = 8,
    [int]    $PollSeconds    = 5
)

$ErrorActionPreference = "Stop"
$servicesDir = Split-Path $PSScriptRoot -Parent
$venturesDir = Join-Path $servicesDir "..\ventures"

Write-Host "==> /research/deep smoke test" -ForegroundColor Cyan
Write-Host "    base url:     $BaseUrl"
Write-Host "    venture slug: $VentureSlug"
Write-Host "    topic:        $Topic"
Write-Host "    depth:        $Depth (report_type=$ReportType)"
Write-Host "    timeout:      ${TimeoutMinutes}m`n"

# 1) Liveness check.
try {
    $health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 5
    Write-Host "==> research-py /health: OK" -ForegroundColor Green
} catch {
    Write-Host "ERROR: research-py is not responding at $BaseUrl/health" -ForegroundColor Red
    Write-Host "  Run scripts/up.ps1 first." -ForegroundColor Yellow
    exit 1
}

# 2) POST the job.
$body = @{
    venture_slug = $VentureSlug
    topic        = $Topic
    depth        = $Depth
    report_type  = $ReportType
} | ConvertTo-Json -Compress

Write-Host "`n==> POST /research/deep" -ForegroundColor Cyan
try {
    $accept = Invoke-RestMethod `
        -Uri "$BaseUrl/research/deep" `
        -Method POST `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 30
} catch {
    Write-Host "ERROR: POST failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$jobId = $accept.job_id
Write-Host "    job_id: $jobId"
Write-Host "    poll:   $($accept.poll)`n"

# 3) Poll until done.
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$lastMsg  = ""
$job      = $null
Write-Host "==> Polling every ${PollSeconds}s (up to ${TimeoutMinutes}m)..." -ForegroundColor Cyan

while ((Get-Date) -lt $deadline) {
    try {
        $job = Invoke-RestMethod -Uri "$BaseUrl/research/jobs/$jobId" -TimeoutSec 10
    } catch {
        Write-Host "    poll failed: $($_.Exception.Message)" -ForegroundColor Yellow
        Start-Sleep -Seconds $PollSeconds
        continue
    }

    if ($job.progress_message -ne $lastMsg) {
        $ts = (Get-Date).ToString("HH:mm:ss")
        Write-Host "    [$ts] $($job.status): $($job.progress_message)" -ForegroundColor DarkGray
        $lastMsg = $job.progress_message
    }

    if ($job.status -eq "done")  { break }
    if ($job.status -eq "error") {
        Write-Host "`nERROR: job failed: $($job.error)" -ForegroundColor Red
        exit 1
    }

    Start-Sleep -Seconds $PollSeconds
}

if ($null -eq $job -or $job.status -ne "done") {
    $last = if ($job) { $job.status } else { "(no response)" }
    Write-Host "`nERROR: job did not finish within ${TimeoutMinutes}m. Last status: $last" -ForegroundColor Red
    exit 1
}

# 4) Inspect the result.
Write-Host "`n==> Job done. Result summary:" -ForegroundColor Green
$result = $job.result
Write-Host "    summary chars: $($result.summary_md_chars)"
Write-Host "    sources count: $($result.sources_count)"
Write-Host "    output path:   $($result.output_path)"
Write-Host "    sources path:  $($result.sources_path)"

# Show first few sources (these come from the API response).
if ($result.sources -and $result.sources.Count -gt 0) {
    Write-Host "`n==> First sources (from API):" -ForegroundColor Cyan
    $result.sources | Select-Object -First 5 | ForEach-Object {
        Write-Host "    - $_"
    }
}

# 5) Verify files on disk.
Write-Host "`n==> Verifying files on disk..." -ForegroundColor Cyan
$ventureRoot = Join-Path $venturesDir $VentureSlug
$mgRoot      = Join-Path $ventureRoot "01_research\market-gaps"
$summaryPath = Join-Path $mgRoot "research-summary.md"
$sourcesPath = Join-Path $mgRoot "sources.json"

$fail = $false

foreach ($p in @($summaryPath, $sourcesPath)) {
    if (Test-Path $p) {
        $size = (Get-Item $p).Length
        Write-Host "    OK ($size bytes) $p" -ForegroundColor Green
    } else {
        Write-Host "    MISSING:        $p" -ForegroundColor Red
        $fail = $true
    }
}

# Sanity-check the markdown is non-trivial.
if (Test-Path $summaryPath) {
    $chars = (Get-Item $summaryPath).Length
    if ($chars -lt 500) {
        Write-Host "    WARN: research-summary.md is only $chars bytes - check content" -ForegroundColor Yellow
    }
}

# Sanity-check sources.json parses + has the expected shape.
if (Test-Path $sourcesPath) {
    try {
        $parsed = Get-Content $sourcesPath -Raw | ConvertFrom-Json
        Write-Host "    sources.json parsed OK (topic=$($parsed.topic), depth=$($parsed.depth), sources=$($parsed.sources.Count))" -ForegroundColor Green
    } catch {
        Write-Host "    sources.json parse FAILED: $($_.Exception.Message)" -ForegroundColor Red
        $fail = $true
    }
}

Write-Host ""
if ($fail) {
    Write-Host "SMOKE TEST FAILED" -ForegroundColor Red
    exit 1
}
Write-Host "SMOKE TEST PASSED" -ForegroundColor Green
exit 0
