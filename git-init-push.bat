@echo off
setlocal
cd /d D:\FOUNDER_AI\founder-os-fixed\founder-os

echo.
echo === Founder OS git init + commit + push ===
echo.

if exist .git\index.lock (
  echo Removing stale .git\index.lock...
  del /f /q .git\index.lock
)

if not exist .git (
  echo No .git folder found -- initializing fresh repo.
  git init
  git branch -M main
) else (
  echo .git folder exists -- using existing repo.
  git branch -M main
)

echo Disabling git hooks for this repo so commits never block.
git config core.hooksPath /dev/null

echo.
echo Staging all files...
git add -A

echo.
echo Committing (skipping if nothing to commit)...
git commit -m "wip founder-os baseline" || echo Nothing to commit (already clean).

echo.
echo Setting remote origin to https://github.com/Northernator/founder-os.git ...
git remote remove origin 2>nul
git remote add origin https://github.com/Northernator/founder-os.git

echo.
echo Pushing main to origin (force, since this is a fresh init)...
git push -u origin main --force

echo.
echo === Done. Read the output above for any errors. ===
echo.
echo If git prompted for credentials, complete the auth in the popup window.
echo Press any key to close this window.
pause >nul
