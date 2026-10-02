@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..\..") do set "ROOT_DIR=%%~fI"
set "LAST_YML=%SCRIPT_DIR%..\release\publish\last.yml"

pushd "%ROOT_DIR%" || exit /b 1
pnpm --filter @owncoder/desktop build:release:win
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
popd

if not "%BUILD_EXIT_CODE%"=="0" (
  echo [ERROR] Windows release build failed.
  exit /b %BUILD_EXIT_CODE%
)

if not exist "%LAST_YML%" (
  echo [ERROR] Cannot find generated last.yml: "%LAST_YML%"
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $path = [IO.Path]::GetFullPath($env:LAST_YML); $content = [IO.File]::ReadAllText($path); $version = [regex]::Match($content, '(?m)^version:\s*''?([^\s'']+)').Groups[1].Value; if (!$version) { throw 'Local version is missing.' }; $pattern = '(?m)^(\s*(?:-\s+)?(?:url|path|file):\s*''?)(?:[^/''\r\n]+/)?([^''\r\n]+)(''?\s*)$'; $updated = [regex]::Replace($content, $pattern, { param($m) $m.Groups[1].Value + $version + '/' + $m.Groups[2].Value + $m.Groups[3].Value }); if ($updated -eq $content) { throw 'No update fields found.' }; Copy-Item -LiteralPath $path -Destination ($path + '.bak') -Force; $encoding = New-Object Text.UTF8Encoding($false); [IO.File]::WriteAllText($path, $updated, $encoding); Write-Host ('Updated: ' + $path); Write-Host ('Backup:  ' + $path + '.bak')"

if errorlevel 1 (
  echo [ERROR] last.yml was not updated.
  exit /b 1
)

echo [OK] Release artifacts are ready in apps\desktop\release\publish\.
exit /b 0
