# services/scripts/health-check.ps1
# Verify SearXNG and Firecrawl are responding.
# Exit 0 = both healthy. Exit 1 = at least one failed.

$ErrorActionPreference = "Continue"

$results = @()

function Test-Endpoint {
    param([string]$Name, [string]$Url, [string]$Method = "GET", $Body = $null)
    Write-Host "==> $Name`: $Url" -ForegroundColor Cyan
    try {
        if ($Body) {
            $r = Invoke-WebRequest -Uri $Url -Method $Method -Body $Body `
                 -ContentType "application/json" -TimeoutSec 10 -UseBasicParsing
        } else {
            $r = Invoke-WebRequest -Uri $Url -Method $Method `
                 -TimeoutSec 10 -UseBasicParsing
        }
        if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) {
            Write-Host "    OK ($($r.StatusCode))`n" -ForegroundColor Green
            return $true
        }
        Write-Host "    FAIL ($($r.StatusCode))`n" -ForegroundColor Red
        return $false
    } catch {
        Write-Host "    FAIL ($($_.Exception.Message))`n" -ForegroundColor Red
        return $false
    }
}

# 1) SearXNG - JSON search must work, that's the contract research-runner needs.
$results += @{
    name = "SearXNG (JSON API)"
    ok   = Test-Endpoint "SearXNG" "http://localhost:8080/search?q=test&format=json"
}

# 2) Firecrawl API root - should respond, even if just with an info banner.
$results += @{
    name = "Firecrawl API"
    ok   = Test-Endpoint "Firecrawl" "http://localhost:3002/"
}

# 3) Firecrawl scrape - the actual capability we care about.
$body = '{"url":"https://example.com","formats":["markdown"]}'
$results += @{
    name = "Firecrawl /v1/scrape"
    ok   = Test-Endpoint "Firecrawl scrape" "http://localhost:3002/v1/scrape" "POST" $body
}

# 4) research-py - liveness only. /health/deps probes searxng + firecrawl
#    from inside the container, so it gives us a more accurate view than
#    pinging both from the host.
$results += @{
    name = "research-py /health"
    ok   = Test-Endpoint "research-py" "http://localhost:3030/health"
}

$results += @{
    name = "research-py /health/deps (sees SearXNG + Firecrawl?)"
    ok   = Test-Endpoint "research-py deps" "http://localhost:3030/health/deps"
}

# Summary.
$failed = $results | Where-Object { -not $_.ok }
if ($failed.Count -eq 0) {
    Write-Host "ALL HEALTHY" -ForegroundColor Green
    exit 0
} else {
    Write-Host "FAILED:" -ForegroundColor Red
    $failed | ForEach-Object { Write-Host "  - $($_.name)" -ForegroundColor Red }
    Write-Host "`nDebug:" -ForegroundColor Yellow
    Write-Host "  docker compose -f services/docker-compose.yml ps"
    Write-Host "  docker compose -f services/docker-compose.yml logs --tail=50 <service>"
    exit 1
}
