<#
.SYNOPSIS
  OwnCoder Desktop v0.1.19 一键打包脚本（手动执行版）
.DESCRIPTION
  将 Electron 应用完整构建到独立临时目录，校验产物完整性后，
  才替换正式发布目录 apps/desktop/release/publish。
  
  脚本不会自动运行，需用户在 PowerShell 中手动执行。
.NOTES
  使用前确保已安装：Node.js >= 20.0.0、pnpm
  若存在企业代理 / 自签 CA，请设置环境变量 NODE_EXTRA_CA_CERTS 指向 CA 文件。
.EXAMPLE
  # 在仓库根目录执行：
  pwsh -File apps/desktop/scripts/build-release-0.1.19.ps1
  
  # 或在 PowerShell 中直接运行：
  .\apps\desktop\scripts\build-release-0.1.19.ps1
#>
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Version = "0.1.19"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopDir = Split-Path -Parent $ScriptDir
$RepoDir = Split-Path -Parent (Split-Path -Parent $DesktopDir)
$ReleaseDir = Join-Path $DesktopDir "release"
$FormalPublishDir = Join-Path $ReleaseDir "publish"
$TempRoot = Join-Path $RepoDir ".tmp\desktop-release-$Version-manual"
$TempReleaseDir = Join-Path $TempRoot "release"
$TempPublishDir = Join-Path $TempRoot "publish"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)] [string] $Command,
    [Parameter(Mandatory = $true)] [string[]] $Arguments
  )

  Write-Host "`n[build] $Command $($Arguments -join ' ')" -ForegroundColor Cyan
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "命令失败，退出码 $LASTEXITCODE：$Command"
  }
}

function Assert-File {
  param(
    [Parameter(Mandatory = $true)] [string] $Path,
    [Parameter(Mandatory = $true)] [string] $Description
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "缺少$Description：$Path"
  }

  $file = Get-Item -LiteralPath $Path
  if ($file.Length -le 0) {
    throw "$Description为空：$Path"
  }
}

function Get-YamlValue {
  param([Parameter(Mandatory = $true)] [string] $Value)

  $value = $Value.Trim()
  if (($value.StartsWith("'") -and $value.EndsWith("'")) -or
      ($value.StartsWith('"') -and $value.EndsWith('"'))) {
    return $value.Substring(1, $value.Length - 2)
  }
  return $value
}

function Rewrite-LatestYml {
  param(
    [Parameter(Mandatory)] [string] $YmlPath,
    [Parameter(Mandatory)] [string] $Version,
    [Parameter(Mandatory)] [string] $DestPath
  )

  $lines = Get-Content -LiteralPath $YmlPath
  $outLines = foreach ($line in $lines) {
    $m = [regex]::Match($line, '^(\s*(?:-\s+)?(?:url|path|file):\s*)(.+)$')
    if (-not $m.Success) { $line; continue }
    $prefix = $m.Groups[1].Value
    $value = Get-YamlValue $m.Groups[2].Value
    if (-not $value -or $value -match '^https?://') { $line; continue }
    if ($value -notmatch '/' -and $value -notmatch [regex]::Escape('\')) {
      $value = "$Version/$value"
    }
    $needsQuote = $value -match '[@#\[\]{},&*?|>!%`\s]' -or $value.StartsWith("'")
    if ($needsQuote) {
      "${prefix}'$($value -replace "'","''")'"
    } else {
      "${prefix}$value"
    }
  }
  $destDir = Split-Path -Parent $DestPath
  if (-not (Test-Path -LiteralPath $destDir)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  }
  Set-Content -LiteralPath $DestPath -Value ($outLines -join "`n") -Encoding UTF8
}

try {
  # ── [1/9] 环境检查 ─────────────────────────────────────────────
  Write-Host "`n========== [1/9] 环境检查 ==========" -ForegroundColor Cyan
  
  # 检查 Node.js 版本（--use-system-ca 需要 Node >= 20.0.0）
  $nodeVersionRaw = & node --version 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "未找到 Node.js，请先安装 Node.js >= 20.0.0"
  }
  $nodeVersionRaw = $nodeVersionRaw.ToString().Trim()
  $nodeVersionMatch = [regex]::Match($nodeVersionRaw, 'v(\d+)\.(\d+)\.(\d+)')
  if (-not $nodeVersionMatch.Success) {
    throw "无法解析 Node.js 版本：$nodeVersionRaw"
  }
  $nodeMajor = [int]$nodeVersionMatch.Groups[1].Value
  Write-Host "[build] Node.js 版本：$nodeVersionRaw"
  if ($nodeMajor -lt 20) {
    throw "Node.js 版本过低（$nodeVersionRaw），--use-system-ca 需要 >= v20.0.0"
  }
  
  # 检查 pnpm
  & pnpm --version 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "未找到 pnpm，请先安装 pnpm"
  }
  Write-Host "[build] pnpm 已就绪"
  
  # ── [2/9] TLS 根证书配置 ───────────────────────────────────────
  Write-Host "`n========== [2/9] TLS 根证书配置 ==========" -ForegroundColor Cyan
  # electron-builder 在打包时需通过 HTTPS 下载 Electron / NSIS 资源。
  # 若当前网络环境存在企业代理或自签根 CA，Node.js 默认证书链可能不包含该 CA，
  # 导致 "unable to verify the first certificate" 错误。
  #
  # 解决方式（按优先级）：
  #   1. 使用 --use-system-ca 让 Node.js 信任 Windows 系统根证书存储（推荐）
  #   2. 设置 NODE_EXTRA_CA_CERTS 指向企业 CA 文件（适用于自签 CA）
  #   3. 若以上都不行，联系 IT 部门获取正确的 CA 文件
  
  $currentNodeOptions = if ($env:NODE_OPTIONS) { $env:NODE_OPTIONS } else { "" }
  $useSystemCa = $nodeMajor -ge 20
  if ($useSystemCa -and $currentNodeOptions -notmatch "--use-system-ca") {
    $env:NODE_OPTIONS = "$currentNodeOptions --use-system-ca".Trim()
  }
  Write-Host "[build] NODE_OPTIONS: $env:NODE_OPTIONS"
  if ($env:NODE_EXTRA_CA_CERTS) {
    Write-Host "[build] NODE_EXTRA_CA_CERTS: $env:NODE_EXTRA_CA_CERTS"
  }
  if (-not $useSystemCa) {
    Write-Host "[build] 警告：Node.js < v20，无法使用 --use-system-ca，请手动设置 NODE_EXTRA_CA_CERTS" -ForegroundColor Yellow
  }
  
  # 禁止使用 NODE_TLS_REJECT_UNAUTHORIZED=0（不安全）
  if ($env:NODE_TLS_REJECT_UNAUTHORIZED -eq "0") {
    Write-Host "[build] 警告：检测到 NODE_TLS_REJECT_UNAUTHORIZED=0，已自动恢复为安全模式" -ForegroundColor Yellow
    Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED -ErrorAction SilentlyContinue
  }

  # ── [3/9] 创建临时目录 ─────────────────────────────────────────
  Write-Host "`n========== [3/9] 创建临时目录 ==========" -ForegroundColor Cyan
  Write-Host "[build] 版本：$Version"
  Write-Host "[build] 临时目录：$TempRoot"
  Write-Host "[build] 正式目录：$FormalPublishDir"

  if (Test-Path -LiteralPath $TempRoot) {
    Write-Host "[build] 清理残留临时目录..."
    # Windows 上 Windows Defender 实时扫描可能锁定 win-unpacked 目录，
    # 导致 electron-builder 的 rename (.tmp -> final) 触发 EPERM。
    # 先移除可能的 win-unpacked / win-unpacked.tmp 残留，等待文件锁释放。
    $releaseSubdir = Join-Path $TempRoot "release"
    if (Test-Path -LiteralPath $releaseSubdir) {
      Get-ChildItem -LiteralPath $releaseSubdir -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^win-unpacked' } |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $TempRoot) {
      Start-Sleep -Seconds 5
      # 第二次尝试：用 cmd 强制删除
      & cmd /c "rd /s /q `"$TempRoot`"" 2>$null
      Start-Sleep -Seconds 2
    }
    if (Test-Path -LiteralPath $TempRoot) {
      Write-Host "[build] 警告：残留目录无法完全清理，将覆盖使用" -ForegroundColor Yellow
    }
  }
  New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null

  # ── [4/9] TLS 连通性预检 ───────────────────────────────────────
  Write-Host "`n========== [4/9] TLS 连通性预检 ==========" -ForegroundColor Cyan
  Write-Host "[build] 测试 HTTPS 连接到 GitHub（electron-builder 需下载资源）..."
  $tlsTestScript = @"
const https = require('https');
const req = https.get('https://github.com', { timeout: 15000 }, res => {
  console.log('[build] TLS 连接成功，状态码: ' + res.statusCode);
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('error', e => {
  console.error('[build] TLS 连接失败: ' + e.message);
  if (e.message.includes('unable to verify') || e.message.includes('certificate')) {
    console.error('');
    console.error('========================================');
    console.error('  TLS 证书验证失败！');
    console.error('  可能原因：企业代理或自签 CA 未被信任');
    console.error('');
    console.error('  解决方案（按优先级）：');
    console.error('  1. 确保 NODE_OPTIONS 包含 --use-system-ca');
    console.error('  2. 设置 NODE_EXTRA_CA_CERTS 指向 CA 文件：');
    console.error('     $env:NODE_EXTRA_CA_CERTS = "C:\path\to\ca-bundle.crt"');
    console.error('  3. 联系 IT 部门获取正确的根 CA 文件');
    console.error('========================================');
  }
  process.exit(2);
});
req.on('timeout', () => {
  req.destroy();
  console.error('[build] TLS 连接超时（15秒）');
  process.exit(3);
});
"@
  $tlsTestScriptPath = Join-Path $TempRoot "tls-test.js"
  Set-Content -LiteralPath $tlsTestScriptPath -Value $tlsTestScript -Encoding UTF8
  try {
    & node $tlsTestScriptPath
    if ($LASTEXITCODE -ne 0) {
      Write-Host "[build] 警告：TLS 预检失败，electron-builder 可能无法下载资源" -ForegroundColor Yellow
      Write-Host "[build] 继续尝试构建（可能因网络问题失败）..." -ForegroundColor Yellow
    }
  } catch {
    Write-Host "[build] 警告：TLS 预检异常 - $($_.Exception.Message)" -ForegroundColor Yellow
  }

  # ── [5/9] 构建前端 ─────────────────────────────────────────────
  Write-Host "`n========== [5/9] 构建前端 ==========" -ForegroundColor Cyan
  Invoke-Checked "pnpm" @("--dir", $DesktopDir, "build")

  # ── [6/9] Electron 打包（带 EPERM 重试）────────────────────────
  Write-Host "`n========== [6/9] Electron 打包 ==========" -ForegroundColor Cyan
  Write-Host "[build] electron-builder 输出目录：$TempReleaseDir"
  
  # 前置检查：检测正在运行的 OwnCoder 应用。
  # 已安装的 Electron 应用运行时会锁定运行时文件（electron.exe、node.dll 等），
  # 导致 electron-builder 在解压 Electron 框架后执行 rename (.tmp -> final) 时触发 EPERM。
  $runningApp = Get-Process -Name "OwnCoder" -ErrorAction SilentlyContinue
  if ($runningApp) {
    $pids = ($runningApp | ForEach-Object { $_.Id }) -join ', '
    throw @"
检测到 OwnCoder 应用正在运行（PID: $pids）。
正在运行的 Electron 实例会锁定运行时文件，导致 electron-builder 打包时
rename 'win-unpacked.tmp' -> 'win-unpacked' 触发 EPERM 错误。
请先关闭 OwnCoder 应用，然后重新运行本脚本。
"@
  }
  Write-Host "[build] 未检测到正在运行的 OwnCoder 进程，继续打包..." -ForegroundColor Green
  
  # electron-builder 在 Windows 上打包时，Windows Defender 实时扫描可能锁定
  # 解压中的 win-unpacked.tmp 目录，导致 rename 触发 EPERM。
  # 采用重试策略：最多尝试 3 次，每次失败后清理 win-unpacked 残留并等待文件锁释放。
  $ebMaxRetries = 3
  $ebSuccess = $false
  for ($ebAttempt = 1; $ebAttempt -le $ebMaxRetries; $ebAttempt++) {
    try {
      if ($ebAttempt -gt 1) {
        Write-Host "`n[build] 第 $ebAttempt 次重试 electron-builder..." -ForegroundColor Yellow
        # 清理上次可能残留的 win-unpacked / win-unpacked.tmp
        Get-ChildItem -LiteralPath $TempReleaseDir -Force -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -match '^win-unpacked' } |
          Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 5
      }
      Invoke-Checked "pnpm" @(
        "--dir", $DesktopDir,
        "exec", "electron-builder", "--win",
        "--config.directories.output=$TempReleaseDir"
      )
      $ebSuccess = $true
      break
    } catch {
      $errMsg = $_.Exception.Message
      if ($errMsg -match 'EPERM' -and $ebAttempt -lt $ebMaxRetries) {
        Write-Host "[build] EPERM 错误，可能是 Windows Defender 锁定文件，将重试..." -ForegroundColor Yellow
      } else {
        throw
      }
    }
  }
  if (-not $ebSuccess) { throw "electron-builder 在 $ebMaxRetries 次尝试后仍然失败" }

  # ── [7/9] 整理发布目录（直接复制，不调用 JS 脚本）─────────────
  Write-Host "`n========== [7/9] 整理发布目录 ==========" -ForegroundColor Cyan
  $nsisDir = Join-Path $TempReleaseDir "nsis-web"
  if (-not (Test-Path -LiteralPath $nsisDir -PathType Container)) {
    throw "electron-builder 未生成 nsis-web 输出目录：$nsisDir"
  }

  # 从 nsis-web 目录发现安装包和 nsis-web 包
  $nsisFiles = @(Get-ChildItem -LiteralPath $nsisDir -File)
  $installer = $nsisFiles | Where-Object {
    $_.Name -match "^OwnCoder([ _]Web)?[ _]Setup[ _]$([regex]::Escape($Version))(-web)?\.exe$"
  } | Select-Object -First 1
  $nsisPackage = $nsisFiles | Where-Object { $_.Name -match "\.nsis\.7z$" } | Select-Object -First 1
  if ($null -eq $installer) { throw "nsis-web 目录缺少 $Version 安装包" }
  if ($null -eq $nsisPackage) { throw "nsis-web 目录缺少 .nsis.7z 包" }

  # 改写 latest.yml（给相对路径加版本前缀）
  $srcLatest = Join-Path $nsisDir "latest.yml"
  Assert-File $srcLatest "nsis-web latest.yml"
  Rewrite-LatestYml -YmlPath $srcLatest -Version $Version -DestPath (Join-Path $TempPublishDir "latest.yml")

  # 直接复制 nsis-web 产物到临时发布目录
  $tempVersionDir = Join-Path $TempPublishDir $Version
  New-Item -ItemType Directory -Path $tempVersionDir -Force | Out-Null
  foreach ($f in $nsisFiles) {
    Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $tempVersionDir $f.Name) -Force
    $destPath = Join-Path $tempVersionDir $f.Name
    $copied = Get-Item -LiteralPath $destPath
    if ($copied.Length -ne $f.Length) {
      throw "复制校验失败：$($f.Name)（源 $($f.Length) 字节，目标 $($copied.Length) 字节）"
    }
  }
  Write-Host "[build] 已复制 $($nsisFiles.Count) 个文件到 $tempVersionDir" -ForegroundColor Green

  # ── [8/9] 产物校验 ─────────────────────────────────────────────
  Write-Host "`n========== [8/9] 产物校验 ==========" -ForegroundColor Cyan
  $tempLatest = Join-Path $TempPublishDir "latest.yml"
  $tempVersionDir = Join-Path $TempPublishDir $Version
  Assert-File $tempLatest "临时 latest.yml"
  if (-not (Test-Path -LiteralPath $tempVersionDir -PathType Container)) {
    throw "临时发布目录缺少版本目录：$tempVersionDir"
  }

  $artifacts = @(Get-ChildItem -LiteralPath $tempVersionDir -File)
  $installer = $artifacts | Where-Object {
    $_.Name -match "^OwnCoder([ _]Web)?[ _]Setup[ _]$([regex]::Escape($Version))(-web)?\.exe$"
  } | Select-Object -First 1
  $nsisPackage = $artifacts | Where-Object { $_.Name -match "\.nsis\.7z$" } | Select-Object -First 1
  if ($null -eq $installer) { throw "临时发布目录缺少 $Version 安装包" }
  if ($null -eq $nsisPackage) { throw "临时发布目录缺少 nsis-web .nsis.7z 包" }
  Assert-File $installer.FullName "安装包"
  Assert-File $nsisPackage.FullName "nsis-web 包"

  $yamlLines = Get-Content -LiteralPath $tempLatest
  $references = @(
    $yamlLines |
      Where-Object { $_ -match '^\s*(?:-\s+)?(?:url|path|file):\s*(.+)$' } |
      ForEach-Object { Get-YamlValue $Matches[1] } |
      Where-Object { $_ -and ($_ -notmatch '^https?://') }
  )
  if ($references.Count -eq 0) { throw "latest.yml 未找到本地文件引用" }
  foreach ($reference in $references) {
    if (-not $reference.StartsWith("$Version/")) {
      throw "latest.yml 路径未包含版本目录：$reference"
    }
    $relativePath = $reference.Substring($Version.Length + 1) -replace '/', '\'
    Assert-File (Join-Path $tempVersionDir $relativePath) "latest.yml 引用文件"
  }

  # ── [9/9] 复制到正式发布目录 ───────────────────────────────────
  Write-Host "`n========== [9/9] 复制到正式发布目录 ==========" -ForegroundColor Cyan
  Write-Host "[build] 临时产物校验通过：$($artifacts.Count) 个文件" -ForegroundColor Green
  $stagingPublishDir = Join-Path $ReleaseDir ".publish-$Version-staging"
  if (Test-Path -LiteralPath $stagingPublishDir) {
    Remove-Item -LiteralPath $stagingPublishDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $stagingPublishDir -Force | Out-Null
  Get-ChildItem -LiteralPath $TempPublishDir -Force | Copy-Item -Destination $stagingPublishDir -Recurse -Force

  Assert-File (Join-Path $stagingPublishDir "latest.yml") "待切换 latest.yml"
  Assert-File (Join-Path $stagingPublishDir "$Version\$($installer.Name)") "待切换安装包"
  Assert-File (Join-Path $stagingPublishDir "$Version\$($nsisPackage.Name)") "待切换 nsis-web 包"

  if (Test-Path -LiteralPath $FormalPublishDir) {
    Remove-Item -LiteralPath $FormalPublishDir -Recurse -Force
  }
  Move-Item -LiteralPath $stagingPublishDir -Destination $FormalPublishDir
  Write-Host "`n[build] 发布目录更新完成：$FormalPublishDir" -ForegroundColor Green
  Write-Host "[build] 临时构建目录已保留：$TempRoot"
} catch {
  $errMsg = $_.Exception.Message
  Write-Host "`n========== 构建失败 ==========" -ForegroundColor Red
  Write-Host "[build] 错误：$errMsg" -ForegroundColor Red
  
  # ── 智能排障提示 ──
  if ($errMsg -match 'unable to verify|certificate|CERT_|UNABLE_TO_GET_ISSUER') {
    Write-Host @"

========================================
  TLS 证书验证失败 — 排障指引
========================================
  原因：electron-builder 通过 HTTPS 下载 Electron/NSIS 资源时，
        当前网络环境的根 CA 未被 Node.js 信任。
  
  解决方案（按优先级）：
  1. 确认 NODE_OPTIONS 包含 --use-system-ca（本脚本已自动配置）
  2. 设置企业 CA 文件路径：
     $env:NODE_EXTRA_CA_CERTS = "C:\path\to\enterprise-ca.crt"
  3. 联系 IT 部门获取正确的根 CA 文件
  4. 检查是否有代理软件拦截 HTTPS（如 Zscaler、Fiddler）
  
  ⚠️ 请勿使用 NODE_TLS_REJECT_UNAUTHORIZED=0（不安全）
========================================
"@ -ForegroundColor Yellow
  } elseif ($errMsg -match 'EPERM') {
    Write-Host @"

========================================
  EPERM 文件锁定错误 — 排障指引
========================================
  原因：目标文件被其他进程锁定。常见场景：
    • OwnCoder 应用正在运行（Electron 运行时文件被占用）
    • Windows Defender 实时扫描锁定解压中的文件
  
  解决方案（按优先级）：
  1. 关闭正在运行的 OwnCoder 应用，然后重新运行本脚本
  2. 将仓库目录加入 Windows Defender 排除列表：
     设置 → 隐私和安全 → Windows 安全中心 → 病毒和威胁防护 → 排除项
     添加 E:\owncoder
  3. 若仍失败，临时关闭 Windows Defender 实时保护后重试
========================================
"@ -ForegroundColor Yellow
  } elseif ($errMsg -match 'EBUSY|locked') {
    Write-Host "[build] 提示：文件被锁定，可能需要关闭其他占用程序或添加杀毒软件排除" -ForegroundColor Yellow
  }
  
  Write-Host "[build] 临时目录（便于排查）：$TempRoot" -ForegroundColor Yellow
  Write-Host "[build] 正式发布目录未被修改：$FormalPublishDir" -ForegroundColor Green
  exit 1
}
