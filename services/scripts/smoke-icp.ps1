# services/scripts/smoke-icp.ps1
# End-to-end smoke test for /research/icp.
#
# Posts an ICP synthesis job, polls /research/jobs/{id} until done, then
# verifies icp.yaml + icp.md landed under
# ventures/<slug>/02_validation/icp/.
#
# Usage:
#   .\smoke-icp.ps1
#   .\smoke-icp.ps1 -VentureSlug my-test
#   .\smoke-icp.ps1 -BaseUrl http://localhost:3030 -TimeoutMinutes 5
#
# Notes:
#   - Default slug is `smoke-test`, which has competitor artifacts from
#     the 2026-04-30 smoke-competitors run. If you want to validate against
#     a different venture, point -VentureSlug at one with content under
#     01_research/competitors/ or 01_research/market-gaps/.
#   - Requires OPENAI_API_KEY (or ANTHROPIC_API_KEY for the anthropic
#     provider) -- the agent runs the LLM via pydantic-ai.

param(
    [string] $VentureSlug    = "smoke-test",
    [string] $BaseUrl        = "http://localhost:3030",
    [int]    $TimeoutMinutes = 5,
    [int]    $PollSeconds    = 4
)

$ErrorActionPreference = "Stop"
$servicesDir = Split-Path $PSScriptRoot -Parent
$venturesDir = Join-Path $servicesDir "..\ventures"

Write-Host "==> /research/icp smoke test" -ForegroundColor Cyan
Write-Host "    base url:     $BaseUrl"
Write-Host "    venture slug: $VentureSlug"
Write-Host "    timeout:      ${TimeoutMinutes}m`n"

# 1) Liveness check.
try {
    $health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 5
    Write-Host "==> research-py /health: OK" -ForegroundColor Green
} catch {
    Write-Host "ERROR: research-py is not responding at $BaseUrl/health" -ForegroundColor Red
    Write-Host "  Run scripts/up.ps1 first (and make sure the rebuilt image with [agents] extras is in)." -ForegroundColor Yellow
    exit 1
}

# 2) POST the job.
$body = @{ venture_slug = $VentureSlug } | ConvertTo-Json -Compress

Write-Host "`n==> POST /research/icp" -ForegroundColor Cyan
try {
    $accept = Invoke-RestMethod `
        -Uri "$BaseUrl/research/icp" `
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
Write-Host "    personas:     $($result.personas_count)"
Write-Host "    summary char: $($result.summary_chars)"
Write-Host "    inputs:       $($result.input_count)"
Write-Host "    yaml path:    $($result.yaml_path)"
Write-Host "    md path:      $($result.md_path)"

if ($result.personas -and $result.personas.Count -gt 0) {
    Write-Host "`n==> Personas (from API):" -ForegroundColor Cyan
    foreach ($p in $result.personas) {
        Write-Host ("    {0,-30} {1}" -f $p.id, $p.name)
        if ($p.primaryGoal) {
            Write-Host ("        goal: {0}" -f $p.primaryGoal) -ForegroundColor DarkGray
        }
    }
}

# 5) Verify files on disk.
Write-Host "`n==> Verifying files on disk..." -ForegroundColor Cyan
$ventureRoot = Join-Path $venturesDir $VentureSlug
$icpDir      = Join-Path $ventureRoot "02_validation\icp"
$yamlPath    = Join-Path $icpDir "icp.yaml"
$mdPath      = Join-Path $icpDir "icp.md"

$fail = $false
foreach ($p in @($yamlPath, $mdPath)) {
    if (Test-Path $p) {
        $size = (Get-Item $p).Length
        Write-Host "    OK ($size bytes) $p" -ForegroundColor Green
    } else {
        Write-Host "    MISSING:        $p" -ForegroundColor Red
        $fail = $true
    }
}

# 6) Confirm icp.yaml has the expected top-level shape.
if (Test-Path $yamlPath) {
    $yamlText = Get-Content $yamlPath -Raw
    $hasSummary  = $yamlText -match "(?m)^summary:"
    $hasPersonas = $yamlText -match "(?m)^personas:"
    if ($hasSummary -and $hasPersonas) {
        Write-Host "    icp.yaml has top-level summary + personas keys" -ForegroundColor Green
    } else {
        Write-Host "    WARN: icp.yaml missing expected top-level keys (summary=$hasSummary personas=$hasPersonas)" -ForegroundColor Yellow
        $fail = $true
    }
}

# 7) Confirm icp.md is non-trivial.
if (Test-Path $mdPath) {
    $mdSize = (Get-Item $mdPath).Length
    if ($mdSize -lt 200) {
        Write-Host "    WARN: icp.md is only $mdSize bytes -- check content" -ForegroundColor Yellow
    }
}

Write-Host ""
if ($fail) {
    Write-Host "SMOKE TEST FAILED" -ForegroundColor Red
    exit 1
}
Write-Host "SMOKE TEST PASSED" -ForegroundColor Green
exit 0
