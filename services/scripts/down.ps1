# services/scripts/down.ps1
# Stop the research sidecars. Use -Volumes to also wipe Redis state.

param(
    [switch]$Volumes
)

$ErrorActionPreference = "Stop"
$servicesDir = Split-Path $PSScriptRoot -Parent

Push-Location $servicesDir
try {
    if ($Volumes) {
        Write-Host "==> docker compose down -v (wiping volumes)" -ForegroundColor Yellow
        docker compose down -v
    } else {
        Write-Host "==> docker compose down" -ForegroundColor Cyan
        docker compose down
    }
} finally {
    Pop-Location
}
