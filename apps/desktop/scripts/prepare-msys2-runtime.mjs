#!/usr/bin/env node
/**
 * 内置 MSYS2 运行时的唯一准备入口（桌面端 pack:win 前置）。
 *
 * 流程（与上游 ZCode prepare-native-search-tools 同纪律）：
 *   1. 固定 base 归档：本地 dependencies/msys2/ 优先（SHA-256 强制校验，
 *      "warm cache 也不能掩盖损坏依赖"），缺失才按序从镜像下载并校验；
 *   2. 解包到 bundled-tools/msys2（--strip-components=1 去掉 msys64/ 层）；
 *   3. pacman 构建期补装 base 缺失的包（diffutils；best-effort，失败告警不中止）；
 *   4. 收集 pacman local db 的包清单 + 生成 THIRD-PARTY-NOTICES-msys2.txt
 *      （裁剪前进行，/var 后续会被删）；
 *   5. 裁剪（locale/man/info/doc/terminfo/pacman 套件/gpg 套件等）并删除
 *      静态库；chmod +x 全部 usr/bin/*.exe；
 *   6. 校验：严格文件清单 + bash 冒烟（清空 MSYSTEM）+ 体积门禁；
 *   7. 写 bundle-meta.json（版本/归档 sha256/包清单/bash 版本/产物体积）。
 *
 * 前置：构建机 PATH 上有 tar（Git for Windows 自带，支持 -J/--strip-components）。
 * 任何一步失败都以非零码中止——坏依赖不允许进入安装包。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { MSYS2_RUNTIME, msys2ArchiveName } from "./msys2-runtime-config.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptsDir, "..");
const depsDir = join(packageDir, "dependencies", "msys2");
// 构建期指向 staging（outDir.new），完成后目录重命名交换进 outDir——
// Windows 上直接 rmSync 旧 bundle 会因 DLL 句柄占用（Defender 扫描、
// 残留进程）报 EPERM；目录重命名不需要文件句柄，是标准的交换模式。
let outDir = join(packageDir, "bundled-tools", "msys2");
const archiveName = msys2ArchiveName();
const force = process.argv.includes("--force");

const MiB = 1024 * 1024;

function log(msg) {
  console.log(`[msys2-prepare] ${msg}`);
}
function fail(msg) {
  throw new Error(`[msys2-prepare] ${msg}`);
}

function sha256File(path) {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}

function spawnOrThrow(file, args, opts = {}, what) {
  const r = spawnSync(file, args, { windowsHide: true, ...opts });
  if (r.error) fail(`${what}: 无法执行 ${file} — ${r.error.message}`);
  if (r.status !== 0) {
    fail(
      `${what}: ${file} 退出码 ${r.status}\nstdout: ${String(r.stdout || "").slice(0, 800)}\nstderr: ${String(r.stderr || "").slice(0, 800)}`,
    );
  }
  return r;
}

/** 子进程环境：删除 MSYSTEM，避免继承 mintty 登录壳的 MINGW64 等设定。 */
function childEnv() {
  const env = { ...process.env };
  delete env.MSYSTEM;
  return env;
}

/** 查找 tar：PATH 优先，回落 Git for Windows 默认安装位置。 */
function findTar() {
  const r = spawnSync("tar", ["--version"], { windowsHide: true });
  if (!r.error && r.status === 0) return "tar";
  const gitTar = join(process.env.SystemRoot || "C:\\Windows", "..", "Program Files", "Git", "usr", "bin", "tar.exe");
  if (existsSync(gitTar)) return gitTar;
  const gitTarX86 = "C:\\Program Files (x86)\\Git\\usr\\bin\\tar.exe";
  if (existsSync(gitTarX86)) return gitTarX86;
  return fail("找不到 tar（需要 Git for Windows 提供的 bsdtar 支持 -J/--strip-components）");
}

// ── 1. 归档：本地优先，下载兜底，全部 SHA-256 校验 ──────────────────

async function downloadArchive(url) {
  const res = await fetch(`${url}/${archiveName}`);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const part = join(depsDir, `${archiveName}.part`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  return part;
}

async function ensureArchive() {
  const local = join(depsDir, archiveName);
  if (existsSync(local)) {
    const got = sha256File(local);
    if (got !== MSYS2_RUNTIME.archiveSha256) {
      fail(`本地归档校验失败 ${local}\n  期望 ${MSYS2_RUNTIME.archiveSha256}\n  实际 ${got}`);
    }
    log(`使用本地归档 ${archiveName}（SHA-256 已校验）`);
    return local;
  }
  mkdirSync(depsDir, { recursive: true });
  for (const base of MSYS2_RUNTIME.downloadBaseUrls) {
    try {
      log(`下载 ${base}/${archiveName} …`);
      const part = await downloadArchive(base);
      const got = sha256File(part);
      if (got !== MSYS2_RUNTIME.archiveSha256) {
        rmSync(part, { force: true });
        throw new Error(`SHA-256 不匹配: ${got}`);
      }
      const dest = join(depsDir, archiveName);
      renameSync(part, dest);
      log(`下载完成并校验通过 → ${dest}`);
      return dest;
    } catch (e) {
      log(`镜像 ${base} 失败（${e.message}），尝试下一个`);
    }
  }
      fail(`所有镜像下载失败。请手动放置 ${archiveName} 到 ${depsDir}（SHA-256 见 SHA256SUMS）`);
}

// ── 2. 解包 ──────────────────────────────────────────────────────

function extract() {
  mkdirSync(outDir, { recursive: true });
  const tar = findTar();
  // bsdtar 会把带盘符冒号的路径解析成远程主机语法（"E:" → host），
  // 用 cwd + 相对文件名规避；-C 目标目录转正斜杠同样出于稳妥。
  spawnOrThrow(
    tar,
    ["-xJf", archiveName, "-C", outDir.split("\\").join("/"), "--strip-components=1"],
    { cwd: depsDir },
    "解包 base 归档",
  );
  log(`解包完成 → ${outDir}`);
}

/**
 * etc/fstab：base 归档只含 cygdrive 行，缺 /tmp 挂载——bash 启动告警
 * "could not find /tmp" 且 mktemp 等临时文件机制不可用。补 Git Bash 同款
 * usertemp 映射（/tmp → %TEMP%）：随包发布后 bundle 可能在 Program Files
 * 下只读，/tmp 必须落到可写的 Windows TEMP，不能依赖盘上目录。
 */
function writeFstab() {
  writeFileSync(
    join(outDir, "etc", "fstab"),
    [
      "# For a description of the file format, see the Users Guide",
      "# https://cygwin.com/cygwin-ug-net/using.html#mount-table",
      "",
      "# DO NOT REMOVE NEXT LINE. It remove cygdrive prefix from path",
      "none / cygdrive binary,posix=0,noacl,user 0 0",
      "none /tmp usertemp binary,posix=0,noacl 0 0",
      "",
    ].join("\n"),
  );
}

// ── 3. pacman 补装（best-effort） ──────────────────────────────────

function installExtraPackages() {
  const missing = MSYS2_RUNTIME.extraPackageFiles.filter((f) => !existsSync(join(outDir, f)));
  if (missing.length === 0) return { failed: false };
  log(`base 缺失 ${missing.join(", ")}，pacman 补装 ${MSYS2_RUNTIME.extraPackages.join(" ")}（best-effort）`);
  const conf = join(tmpdir(), `owncoder-msys2-pacman-${Date.now()}.conf`);
  const cache = join(tmpdir(), `owncoder-msys2-pkgs-${Date.now()}`);
  mkdirSync(cache, { recursive: true });
  writeFileSync(
    conf,
    // Architecture 必须显式给出，否则 pacman 拒绝展开 Server 里的 $arch。
    // 桌面端 Windows 包仅 x64（electron-builder win.arch），bundle 亦仅 x86_64。
    // SigLevel = Never：base 归档未随包初始化 keyring（pacman-key --init 需
    // 交互），而此步仅 best-effort 补装可选包、HTTPS 传输、失败仅告警不中止；
    // 安全敏感的基础归档仍走严格 SHA-256 钉死，不依赖 pacman 签名链。
    `[options]\nNoUpgrade =\nArchitecture = x86_64\nSigLevel = Never\n\n[msys]\n` +
      MSYS2_RUNTIME.pacmanServers.map((s) => `Server = ${s}`).join("\n") +
      "\n",
  );
  const pacman = join(outDir, "usr", "bin", "pacman.exe");
  const r = spawnSync(
    pacman,
    [
      "-Sy",
      "--noconfirm",
      "--needed",
      "--root", outDir,
      "--config", conf,
      "--cachedir", cache,
      ...MSYS2_RUNTIME.extraPackages,
    ],
    { windowsHide: true, encoding: "utf8", env: childEnv() },
  );
  // 失败判定以退出码 + 文件落盘为准（pacman 正常输出里也可能出现 "error:"
  // 字样——曾因此误判已成功的 diffutils 安装为失败）。
  rmSync(conf, { force: true });
  rmSync(cache, { recursive: true, force: true });
  const stillMissing = MSYS2_RUNTIME.extraPackageFiles.filter((f) => !existsSync(join(outDir, f)));
  if (r.status !== 0 || stillMissing.length > 0) {
    console.warn(
      `[msys2-prepare] WARN pacman 补装未达预期（退出码 ${r.status}，仍缺 ${stillMissing.join(", ") || "无"}），` +
        "diff 系列命令将缺席（模型可用 git diff --no-index / cmp 替代）：" +
        String(r.stderr || "").slice(0, 400),
    );
    return { failed: true };
  }
  log("pacman 补装完成");
  return { failed: false };
}

// ── 4. 许可与包清单（裁剪前收集） ──────────────────────────────────

function readPacmanPackages() {
  const localDb = join(outDir, "var", "lib", "pacman", "local");
  if (!existsSync(localDb)) return [];
  const packages = [];
  for (const entry of readdirSync(localDb)) {
    if (entry === "ALPM_DB_VERSION" || entry.startsWith("sync")) continue;
    const descPath = join(localDb, entry, "desc");
    if (!existsSync(descPath)) continue;
    const desc = readFileSync(descPath, "utf8");
    const name = /^%NAME%\n([^\n]+)/m.exec(desc)?.[1] ?? entry.split("-")[0];
    const version = /^%VERSION%\n([^\n]+)/m.exec(desc)?.[1] ?? "";
    packages.push({ name, version });
  }
  return packages;
}

/**
 * 裁剪前收割许可文本：各包把许可放在 usr/share/licenses/<pkg>/ 或
 * usr/share/doc/<pkg>/{COPYING,LICENSE,...}（如 msys2-runtime 在
 * usr/share/doc/Cygwin/ 下），而裁剪会删除 doc 树——必须先收割到
 * licenses/<pkg>/ 随包发布。
 */
function harvestLicenses(packages) {
  const localDb = join(outDir, "var", "lib", "pacman", "local");
  const destRoot = join(outDir, "licenses");
  mkdirSync(destRoot, { recursive: true });
  const licenseMark = /(^|\/)(COPYING|COPYING\..*|LICENSE|LICENSE\..*|LICENCE|LEGAL|PATENTS|NOTICE)$/i;
  let count = 0;
  for (const pkg of packages) {
    const filesPath = join(localDb, `${pkg.name}-${pkg.version}`, "files");
    if (!existsSync(filesPath)) continue;
    const targets = readFileSync(filesPath, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("usr/share/licenses/") || (l.startsWith("usr/share/doc/") && licenseMark.test(l)));
    if (targets.length === 0) continue;
    const pkgDest = join(destRoot, pkg.name);
    for (const rel of targets) {
      const src = join(outDir, rel);
      // pacman files 清单含目录条目，只收割文件。
      if (!existsSync(src) || !statSync(src).isFile()) continue;
      const dst = join(pkgDest, rel.split("/").slice(3).join("/"));
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      count++;
    }
  }
  return count;
}

function stageNotices(packages, licenseCount) {
  const lines = [
    "OwnCoder 桌面端内置 MSYS2 运行时（resources/msys2）",
    "==================================================",
    "",
    `来源：MSYS2 项目官方 base 归档 ${archiveName}`,
    `归档 SHA-256：${MSYS2_RUNTIME.archiveSha256}`,
    `准备时间：${new Date().toISOString()}`,
    `包数量：${packages.length}`,
    "",
    "随包组件（pacman local db）及版本：",
    ...packages.map((p) => `  ${p.name} ${p.version}`),
    "",
    `各组件许可文本已收割到本目录 licenses/<组件名>/ 下（共 ${licenseCount} 个文件，随包发布）。`,
    "",
    "msys-2.0.dll（MSYS2 运行时，Cygwin 派生）许可要点（见",
    "licenses/msys2-runtime/CYGWIN_LICENSE 与 COPYING）：",
    "  - Cygwin 库部分（链接进本 DLL 的代码）：LGPL-3.0-or-later；",
    "  - cygserver/lsaauth/utils 部分：GPL-3.0-or-later；",
    "  - 附 Linking Exception：允许将库与独立模块链接并按自有条款分发",
    "    可执行文件。应用程序动态链接本运行时，不要求应用程序整体采用",
    "    GPL/LGPL。请勿把该例外误读为对本应用程序其余部分的传染性要求。",
    "",
  ];
  writeFileSync(join(outDir, "THIRD-PARTY-NOTICES-msys2.txt"), lines.join("\n"));
}

// ── 5. 裁剪 ──────────────────────────────────────────────────────

function deleteGlobUnder(parent, pattern) {
  if (!existsSync(parent)) return;
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  for (const entry of readdirSync(parent)) {
    if (re.test(entry)) rmSync(join(parent, entry), { recursive: true, force: true });
  }
}

function trim() {
  for (const d of MSYS2_RUNTIME.trimDirs) {
    rmSync(join(outDir, d), { recursive: true, force: true });
  }
  for (const f of MSYS2_RUNTIME.trimRootFiles) {
    if (f.includes("*")) deleteGlobUnder(outDir, f);
    else rmSync(join(outDir, f), { force: true });
  }
  const binDir = join(outDir, "usr", "bin");
  for (const b of MSYS2_RUNTIME.trimBins) rmSync(join(binDir, b), { force: true });
  // 静态库/导入库（运行期无用）
  pruneStaticLibs(join(outDir, "usr", "lib"));
  rmSync(join(outDir, "var", "log"), { recursive: true, force: true });
}

function pruneStaticLibs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) pruneStaticLibs(p);
    else if (/\.(a|la|dll\.a)$/.test(entry.name)) rmSync(p, { force: true });
  }
}

function chmodExecutables() {
  const binDir = join(outDir, "usr", "bin");
  if (!existsSync(binDir)) return;
  for (const entry of readdirSync(binDir)) {
    if (entry.endsWith(".exe") || entry === "egrep" || entry === "fgrep" || !entry.includes(".")) {
      try { chmodSync(join(binDir, entry), 0o755); } catch { /* 忽略个别失败 */ }
    }
  }
}

// ── 6. 校验 + 冒烟 + 门禁 ──────────────────────────────────────────

function verifyStrict() {
  for (const f of MSYS2_RUNTIME.requiredFiles) {
    if (!existsSync(join(outDir, f))) fail(`严格校验失败：缺少 ${f}`);
  }
}

function smokeBash() {
  const bash = join(outDir, "usr", "bin", "bash.exe");
  const r = spawnSync(
    bash,
    ["-c", 'echo OC-MSYS2-OK && echo "pipe=$(( $(echo x | wc -c) ))"'],
    { windowsHide: true, encoding: "utf8", env: childEnv() },
  );
  if (r.status !== 0 || !String(r.stdout).includes("OC-MSYS2-OK")) {
    fail(`bash 冒烟失败 code=${r.status} out=${r.stdout} err=${r.stderr}`);
  }
  return String(r.stdout).trim();
}

function bashVersion() {
  const bash = join(outDir, "usr", "bin", "bash.exe");
  const r = spawnSync(bash, ["--version"], { windowsHide: true, encoding: "utf8" });
  return String(r.stdout || "").split("\n")[0].trim();
}

function dirSizeBytes(root) {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else total += statSync(p).size;
  }
  return total;
}

// ── main ──────────────────────────────────────────────────────────

/** staging → 正式目录交换；旧目录被占用时改名让位，下次运行清理。 */
function swapIn(realOut, staging) {
  if (existsSync(realOut)) {
    try {
      rmSync(realOut, { recursive: true, force: true });
    } catch {
      const aside = `${realOut}.old-${Date.now()}`;
      renameSync(realOut, aside);
      try {
        rmSync(aside, { recursive: true, force: true });
      } catch {
        console.warn(`[msys2-prepare] WARN 旧 bundle 仍被占用，已改名 ${aside}（下次运行清理）`);
      }
    }
  }
  renameSync(staging, realOut);
}

/** 清理上次交换留下的 .new/.old-* 残留（best-effort）。 */
function cleanStrayDirs(realOut) {
  const parent = dirname(realOut);
  if (!existsSync(parent)) return;
  for (const entry of readdirSync(parent)) {
    if (entry === "msys2") continue;
    if (/^msys2\.(new|old-)/.test(entry)) {
      try { rmSync(join(parent, entry), { recursive: true, force: true }); } catch { /* 占用中，下次再说 */ }
    }
  }
}

function isBundleCurrent() {
  const metaPath = join(outDir, "bundle-meta.json");
  if (!existsSync(metaPath)) return false;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    if (meta.version !== MSYS2_RUNTIME.version || meta.archiveSha256 !== MSYS2_RUNTIME.archiveSha256) return false;
  } catch {
    return false;
  }
  return MSYS2_RUNTIME.requiredFiles.every((f) => existsSync(join(outDir, f)));
}

async function main() {
  const realOut = outDir;
  cleanStrayDirs(realOut);
  if (!force && isBundleCurrent()) {
    log("bundle 已是当前版本（--force 强制重建），跳过");
    return;
  }
  const staging = `${realOut}.new`;
  rmSync(staging, { recursive: true, force: true });
  outDir = staging;
  await ensureArchive();
  extract();
  writeFstab();
  const pacman = installExtraPackages();
  const packages = readPacmanPackages();
  const licenseCount = harvestLicenses(packages);
  stageNotices(packages, licenseCount);
  trim();
  chmodExecutables();
  verifyStrict();
  const smoke = smokeBash();
  const sizeMiB = Math.round((dirSizeBytes(outDir) / MiB) * 10) / 10;
  if (sizeMiB > MSYS2_RUNTIME.maxTrimmedSizeMiB) {
    fail(`体积门禁：裁剪后 ${sizeMiB}MiB > 上限 ${MSYS2_RUNTIME.maxTrimmedSizeMiB}MiB，需复议裁剪策略`);
  }
  const meta = {
    version: MSYS2_RUNTIME.version,
    archiveName,
    archiveSha256: MSYS2_RUNTIME.archiveSha256,
    packageCount: packages.length,
    bashVersion: bashVersion(),
    pacmanExtraFailed: pacman.failed,
    extraPackageFilesPresent: MSYS2_RUNTIME.extraPackageFiles.filter((f) => existsSync(join(outDir, f))),
    sizeMiB,
    preparedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "bundle-meta.json"), JSON.stringify(meta, null, 2) + "\n");
  swapIn(realOut, staging);
  outDir = realOut;
  log(`冒烟输出：${smoke.replace(/\n/g, " | ")}`);
  log(`完成：${sizeMiB}MiB，${packages.length} 个组件，bash: ${meta.bashVersion}`);
  log(`bundle → ${realOut}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
