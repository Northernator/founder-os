# services/scripts/smoke-competitors.ps1
# End-to-end smoke test for /research/competitors.
#
# Posts a competitor scan, polls /research/jobs/{id} until done, then
# verifies the expected files landed under ventures/<slug>/.
#
# Usage:
#   .\smoke-competitors.ps1
#   .\smoke-competitors.ps1 -VentureSlug my-test -Urls "https://linear.app","https://height.app"
#   .\smoke-competitors.ps1 -TimeoutMinutes 5

param(
    [string]   $VentureSlug    = "smoke-test",
    [string[]] $Urls           = @(
        "https://linear.app",
        "https://raycast.com",
        "https://notion.so"
    ),
    [string]   $BaseUrl        = "http://localhost:3030",
    [int]      $TimeoutMinutes = 10,
    [int]      $PollSeconds    = 5
)

$ErrorActionPreference = "Stop"
$servicesDir = Split-Path $PSScriptRoot -Parent
$venturesDir = Join-Path $servicesDir "..\ventures"

Write-Host "==> /research/competitors smoke test" -ForegroundColor Cyan
Write-Host "    base url:     $BaseUrl"
Write-Host "    venture slug: $VentureSlug"
Write-Host "    urls:         $($Urls -join ', ')"
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

# 2) POST the scan.
$body = @{
    venture_slug = $VentureSlug
    urls         = $Urls
} | ConvertTo-Json -Compress

Write-Host "`n==> POST /research/competitors" -ForegroundColor Cyan
try {
    $accept = Invoke-RestMethod `
        -Uri "$BaseUrl/research/competitors" `
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
Write-Host "    poll:   $($accept.poll)"
Write-Host "    count:  $($accept.competitor_count)`n"

# 3) Poll until done.
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$lastMsg  = ""
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

if ($job.status -ne "done") {
    Write-Host "`nERROR: job did not finish within ${TimeoutMinutes}m. Last status: $($job.status)" -ForegroundColor Red
    exit 1
}

# 4) Inspect the result.
Write-Host "`n==> Job done. Result summary:" -ForegroundColor Green
$result = $job.result
Write-Host "    competitors: $($result.competitor_count)"
Write-Host "    pricing rows: $($result.pricing_rows_total)"
Write-Host "    pricing csv:  $($result.pricing_csv)"

Write-Host "`n==> Per-competitor breakdown:" -ForegroundColor Cyan
$result.competitors | ForEach-Object {
    $marks = @()
    if ($_.wrote_landing) { $marks += "landing" }
    if ($_.wrote_pricing) { $marks += "pricing" } else { $marks += "(no pricing)" }
    if ($_.wrote_about)   { $marks += "about" }   else { $marks += "(no about)" }
    Write-Host ("    {0,-30} {1,-3} rows  {2}" -f $_.slug, $_.pricing_rows, ($marks -join ", "))
    if ($_.errors -and $_.errors.Count -gt 0) {
        $_.errors | ForEach-Object { Write-Host "      ! $_" -ForegroundColor Yellow }
    }
}

# 5) Verify files on disk.
Write-Host "`n==> Verifying files on disk..." -ForegroundColor Cyan
$ventureRoot = Join-Path $venturesDir $VentureSlug
$compRoot    = Join-Path $ventureRoot "01_research\competitors"
$csvPath     = Join-Path $ventureRoot "02_validation\pricing\competitors-pricing.csv"

$fail = $false

foreach ($comp in $result.competitors) {
    $compDir = Join-Path $compRoot $comp.slug
    if (-not (Test-Path $compDir)) {
        Write-Host "    MISSING dir: $compDir" -ForegroundColor Red
        $fail = $true
        continue
    }
    foreach ($f in @("landing.md","pricing-plans.json")) {
        $p = Join-Path $compDir $f
        if (Test-Path $p) {
            $size = (Get-Item $p).Length
            Write-Host "    OK ($size bytes) $p" -ForegroundColor Green
        } else {
            Write-Host "    MISSING:        $p" -ForegroundColor Red
            $fail = $true
        }
    }
}

if (Test-Path $csvPath) {
    $rows = (Get-Content $csvPath | Measure-Object -Line).Lines - 1
    $size = (Get-Item $csvPath).Length
    Write-Host "    OK ($size bytes, $rows data rows) $csvPath" -ForegroundColor Green
} else {
    Write-Host "    MISSING:        $csvPath" -ForegroundColor Red
    $fail = $true
}

Write-Host ""
if ($fail) {
    Write-Host "SMOKE TEST FAILED" -ForegroundColor Red
    exit 1
}
Write-Host "SMOKE TEST PASSED" -ForegroundColor Green
exit 0
