<#
.SYNOPSIS
  Build and prepare the Windows release artifacts.

.DESCRIPTION
  Runs the desktop package's pack:win and publish scripts in order.
#>

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Split-Path -Parent $scriptDir

function Invoke-PnpmScript {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  Write-Host "[build-release] pnpm run $Name" -ForegroundColor Cyan
  & pnpm --dir $desktopDir run $Name
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

Invoke-PnpmScript "pack:win"
Invoke-PnpmScript "publish"
