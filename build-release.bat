@echo off
setlocal EnableExtensions DisableDelayedExpansion

pushd "%~dp0" || exit /b 1
pnpm --filter @owncoder/desktop build:release:win
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
popd

if not "%BUILD_EXIT_CODE%"=="0" (
  echo [ERROR] Windows release build failed.
  exit /b %BUILD_EXIT_CODE%
)

echo [OK] Release artifacts are ready in apps\desktop\release\publish\.
exit /b 0
