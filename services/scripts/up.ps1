# services/scripts/up.ps1
# Bring up the research sidecars (SearXNG + Firecrawl).
# Run from anywhere - script resolves paths relative to itself.

$ErrorActionPreference = "Stop"
$servicesDir = Split-Path $PSScriptRoot -Parent

Write-Host "==> Founder OS research services" -ForegroundColor Cyan
Write-Host "    services dir: $servicesDir`n"

# 1) Generate a SearXNG secret_key on first run if still placeholder.
$settings = Join-Path $servicesDir "searxng\settings.yml"
$content  = Get-Content $settings -Raw
if ($content -match "REPLACE_ME_with_openssl_rand_hex_32") {
    Write-Host "==> Generating SearXNG secret_key (first run)" -ForegroundColor Yellow
    $bytes  = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
    $content = $content -replace "REPLACE_ME_with_openssl_rand_hex_32", $secret
    Set-Content -Path $settings -Value $content -NoNewline
    Write-Host "    secret written to searxng/settings.yml`n"
}

# 2) Verify Docker daemon is reachable. `docker info` returns non-zero
#    when the daemon is down; PowerShell try/catch alone won't catch that.
$null = & docker info 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Docker daemon not reachable." -ForegroundColor Red
    Write-Host "  Start Docker Desktop, wait until the whale icon stops animating, then retry." -ForegroundColor Yellow
    exit 1
}

# 3) Pull images first so any 401s surface clearly.
Write-Host "==> Pulling images" -ForegroundColor Cyan
Push-Location $servicesDir
try {
    docker compose pull
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`nIf you saw a 401 on a ghcr.io image, authenticate:" -ForegroundColor Yellow
        Write-Host "  echo `$env:GHCR_PAT | docker login ghcr.io -u <github-user> --password-stdin"
        exit 1
    }

    # 4) Bring up. --build forces a rebuild of locally-built images
    #    (research-py) when source has changed; cache makes it fast when not.
    #    --remove-orphans clears containers from older compose revisions.
    Write-Host "`n==> docker compose up -d --build --remove-orphans" -ForegroundColor Cyan
    docker compose up -d --build --remove-orphans
    if ($LASTEXITCODE -ne 0) { exit 1 }
} finally {
    Pop-Location
}

# Wait for the slowest service in each stack to bind. Firecrawl's harness
# allows itself up to 60s (HARNESS_STARTUP_TIMEOUT_MS); research-py is
# normally fast but waits on Firecrawl + SearXNG before serving.
function Wait-ForBind {
    param([string]$Name, [string]$Url, [int]$MaxSeconds = 60)
    Write-Host "`n==> Waiting up to ${MaxSeconds}s for $Name on $Url..." -ForegroundColor Cyan
    $deadline = (Get-Date).AddSeconds($MaxSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -TimeoutSec 2 `
                 -UseBasicParsing -ErrorAction Stop
            $elapsed = [int]((Get-Date) - ($deadline.AddSeconds(-$MaxSeconds))).TotalSeconds
            Write-Host "    $Name bound after ${elapsed}s" -ForegroundColor Green
            return $true
        } catch {
            Write-Host "    still booting..." -ForegroundColor DarkGray
            Start-Sleep -Seconds 2
        }
    }
    Write-Host "    $Name did not bind within ${MaxSeconds}s - continuing" -ForegroundColor Yellow
    return $false
}

Wait-ForBind "Firecrawl"  "http://localhost:3002/"  60 | Out-Null
# research-py binds fast on rebuilds, but the first 2b build pulls
# gpt-researcher + langchain + tiktoken + lxml; allow a longer window so a
# first-time `up.ps1` doesn't fail the health check while the container
# is still finishing its venv install.
Wait-ForBind "research-py" "http://localhost:3030/health" 90 | Out-Null

# 5) Run health check.
& (Join-Path $PSScriptRoot "health-check.ps1")
