# services/scripts/biome-cleanup.ps1
# Standalone biome cleanup sweep over the monorepo.
#
# Run from a clean working tree on its own branch -- don't mix this PR
# with feature work. The sweep touches hundreds of files via mechanical
# transforms (template literals, hook deps, button types, etc.).
#
# Usage:
#   .\biome-cleanup.ps1               # check only, prints baseline
#   .\biome-cleanup.ps1 -Fix          # apply safe + unsafe fixes
#   .\biome-cleanup.ps1 -Fix -Verify  # apply, then re-check to count remaining

param(
    [switch] $Fix,
    [switch] $Verify
)

$ErrorActionPreference = "Stop"

# Resolve repo root (this script lives in services/scripts/).
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Write-Host "==> Biome cleanup sweep" -ForegroundColor Cyan
Write-Host "    repo root: $repoRoot"
Write-Host "    mode:      $(if ($Fix) { 'fix (safe + unsafe)' } else { 'check only' })`n"

Push-Location $repoRoot
try {
    if (-not (Test-Path "biome.json")) {
        Write-Host "ERROR: biome.json not found at repo root." -ForegroundColor Red
        exit 1
    }

    Write-Host "==> Baseline diagnostics" -ForegroundColor Cyan
    $checkOutput = & pnpm exec biome check . 2>&1
    $countLine = ($checkOutput | Select-String -Pattern "^Found \d+ (errors|warnings)" -SimpleMatch:$false)
    if ($countLine) {
        $countLine | ForEach-Object { Write-Host "    $_" }
    } else {
        Write-Host "    (could not parse counts -- last 5 lines:)"
        $checkOutput | Select-Object -Last 5 | ForEach-Object { Write-Host "    $_" }
    }

    if (-not $Fix) {
        Write-Host "`nDry run only. Re-run with -Fix to apply changes." -ForegroundColor Yellow
        exit 0
    }

    Write-Host "`n==> Applying safe + unsafe fixes" -ForegroundColor Cyan
    & pnpm exec biome check . --fix --unsafe
    $applyExit = $LASTEXITCODE
    Write-Host "    biome exit code: $applyExit"

    Write-Host "`n==> Modified files (git status snapshot)" -ForegroundColor Cyan
    $changed = & git status --porcelain | Where-Object { $_ -match "^.M\s|^M\s" }
    if ($changed) {
        $count = ($changed | Measure-Object).Count
        Write-Host "    $count file(s) modified" -ForegroundColor Green
        $changed | Select-Object -First 20 | ForEach-Object { Write-Host "      $_" }
        if ($count -gt 20) {
            Write-Host "      ...and $($count - 20) more" -ForegroundColor DarkGray
        }
    } else {
        Write-Host "    (no files modified -- biome had nothing to fix)" -ForegroundColor Yellow
    }

    if ($Verify) {
        Write-Host "`n==> Re-checking after fix" -ForegroundColor Cyan
        $afterOutput = & pnpm exec biome check . 2>&1
        $afterCountLine = ($afterOutput | Select-String -Pattern "^Found \d+ (errors|warnings)" -SimpleMatch:$false)
        if ($afterCountLine) {
            $afterCountLine | ForEach-Object { Write-Host "    $_" -ForegroundColor Green }
        } else {
            Write-Host "    (could not parse counts -- last 5 lines:)"
            $afterOutput | Select-Object -Last 5 | ForEach-Object { Write-Host "    $_" }
        }
    }

    Write-Host "`n==> Next steps:" -ForegroundColor Cyan
    Write-Host "    1. Review the diff: git diff --stat"
    Write-Host "    2. Spot-check sensitive files (anything in src-tauri/ should be untouched)."
    Write-Host "    3. Run app smoke (pnpm --filter founder-desktop tauri dev) to confirm nothing broke."
    Write-Host "    4. Commit (likely with --no-verify due to the strict pre-commit hook):"
    Write-Host "       git add -u && git commit --no-verify"
    Write-Host "    5. Push the branch + open the PR."
    exit 0
}
finally {
    Pop-Location
}
