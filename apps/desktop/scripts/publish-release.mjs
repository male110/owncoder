#!/usr/bin/env node
/**
 * 发布脚本：把 electron-builder 的 nsis 完整安装包与 nsis-web 下载器整理成发布目录。
 *
 * 用法：
 *   # 1. 先打包
 *   pnpm --filter @owncoder/desktop pack:win
 *
 *   # 2. 生成本地发布目录（不上传 OSS）
 *   pnpm --filter @owncoder/desktop run publish
 *
 * 客户端 feed（app-update.yml / package.json build.publish）：
 *   https://zy-1310897501.cos.ap-nanjing.myqcloud.com/owncoder/
 *   → 请求 {base}/latest.yml
 *   → 再按 yml 内 path/url 相对 base 下载完整 NSIS 安装包
 *
 * Web Setup.exe 的 .nsis.7z 下载地址在生成 EXE 时由
 * `nsisWeb.appPackageUrl` 写入；该下载器不读取根目录的 latest.yml。
 *
 * 本脚本产出（手动上传到上述 base）：
 *   release/publish/
 *     latest.yml                         # 应用内更新：完整 NSIS 安装包元数据
 *     {version}/
 *       OwnCoder Setup {version}.exe       # 完整离线安装包和应用内更新包
 *       OwnCoder Web Setup {version}.exe   # 内部下载 {version}/ 下的 .nsis.7z
 *       @{name}-{version}-x64.nsis.7z      # 下载器使用的实际安装内容
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const RELEASE_ROOT = process.env.OWNCODER_RELEASE_ROOT
  ? resolve(process.env.OWNCODER_RELEASE_ROOT)
  : resolve(__dirname, "..", "release");
const RELEASE_DIR = RELEASE_ROOT;
const NSIS_WEB_DIR = join(RELEASE_ROOT, "nsis-web");
// 整理后的上传目录
const PUBLISH_DIR = process.env.OWNCODER_PUBLISH_DIR
  ? resolve(process.env.OWNCODER_PUBLISH_DIR)
  : join(RELEASE_ROOT, "publish");

async function listReleaseFiles(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function yamlQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function makeFullInstallerYml({ version, fileName, sha512, size, releaseDate }) {
  const path = `${version}/${fileName}`;
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${yamlQuote(path)}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${yamlQuote(path)}`,
    `sha512: ${sha512}`,
    `releaseDate: ${yamlQuote(releaseDate)}`,
    "",
  ].join("\n");
}

function extractYmlPaths(yml) {
  const paths = [];
  const re = /^\s*(?:-\s+)?(?:url|path|file):\s*(.+)$/gm;
  let match;
  while ((match = re.exec(yml)) !== null) {
    const value = match[1].trim().replace(/^(?:'|")|(?:'|")$/g, "");
    if (value && !/^https?:\/\//i.test(value)) paths.push(value);
  }
  return [...new Set(paths)];
}

function resolveWebArtifact(relativePath) {
  const versioned = join(NSIS_WEB_DIR, relativePath);
  if (existsSync(versioned)) return versioned;

  // 某些 electron-builder 版本会将 nsis-web 文件写到输出根目录；
  // 元数据仍保留版本化 URL，发布时必须按元数据中的路径上传。
  const flat = join(NSIS_WEB_DIR, basename(relativePath));
  return existsSync(flat) ? flat : null;
}

function pickArtifacts(releaseFiles, version, webYml) {
  const tag = `Setup ${version}`;
  const full = releaseFiles.find((f) => new RegExp(`^OwnCoder[ _]${tag}\\.exe$`, "i").test(f));
  const paths = extractYmlPaths(webYml);
  const nsisPackagePath = paths.find((path) => new RegExp(`-${version}-.*\\.nsis\\.7z$`, "i").test(path));

  return {
    full: full ? join(RELEASE_DIR, full) : null,
    web: resolveWebArtifact(`OwnCoder Web Setup ${version}.exe`),
    nsisPackage: nsisPackagePath ? resolveWebArtifact(nsisPackagePath) : null,
  };
}

function ensureEmptyDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function copyInto(dir, filePath) {
  if (!filePath) return null;
  const name = basename(filePath);
  const dest = join(dir, name);
  cpSync(filePath, dest);
  return dest;
}

function formatSize(filePath) {
  const stat = statSync(filePath);
  return `${(stat.size / 1024 / 1024).toFixed(2)}M`;
}

async function main() {
  const pkg = JSON.parse(
    await readFile(resolve(__dirname, "..", "package.json"), "utf8"),
  );
  const version = pkg.version;
  console.log(`[publish] 发布版本 ${version}`);
  console.log(`[publish] 源目录 ${RELEASE_DIR}`);
  console.log(`[publish] 输出目录 ${PUBLISH_DIR}`);

  const releaseFiles = await listReleaseFiles(RELEASE_DIR);
  if (releaseFiles.length === 0) {
    console.error(`[publish] 未找到 release 目录: ${RELEASE_DIR}`);
    console.error("[publish] 请先运行 `pnpm --filter @owncoder/desktop pack:win`");
    process.exit(1);
  }

  const webYmlPath = join(NSIS_WEB_DIR, "latest.yml");
  let webYml;
  try {
    webYml = await readFile(webYmlPath, "utf8");
  } catch {
    console.error(`[publish] 未找到 nsis-web 元数据: ${webYmlPath}`);
    process.exit(1);
  }

  const artifacts = pickArtifacts(releaseFiles, version, webYml);
  if (!artifacts.full) {
    console.error(`[publish] 未在 ${RELEASE_DIR} 找到完整安装包 OwnCoder Setup ${version}.exe`);
    process.exit(1);
  }
  if (!artifacts.web) {
    console.error(`[publish] 未在 ${NSIS_WEB_DIR} 找到下载器 OwnCoder Web Setup ${version}.exe`);
    process.exit(1);
  }
  if (!artifacts.nsisPackage) {
    console.error(`[publish] 未在 ${NSIS_WEB_DIR} 找到当前版本的 nsis-web 安装内容 (*.nsis.7z)，下载器将无法完成安装`);
    process.exit(1);
  }
  const fullFileName = basename(artifacts.full);
  const fullStat = statSync(artifacts.full);
  const fullSha512 = createHash("sha512").update(await readFile(artifacts.full)).digest("base64");
  const fullYml = makeFullInstallerYml({
    version,
    fileName: fullFileName,
    sha512: fullSha512,
    size: fullStat.size,
    releaseDate: new Date(fullStat.mtimeMs).toISOString(),
  });
  const ymlName = "latest.yml";

  // ─── 整理上传目录 ─────────────────────────────────────────────
  // owncoder/latest.yml
  // owncoder/{version}/完整 Setup.exe + Web Setup.exe + .nsis.7z + ...
  ensureEmptyDir(PUBLISH_DIR);
  const versionDir = join(PUBLISH_DIR, version);
  mkdirSync(versionDir, { recursive: true });

  const publishLatestPath = join(PUBLISH_DIR, ymlName);
  writeFileSync(publishLatestPath, fullYml, "utf8");
  writeFileSync(join(RELEASE_DIR, ymlName), fullYml, "utf8");
  writeFileSync(join(RELEASE_DIR, `latest-${version}.yml`), fullYml, "utf8");

  const copied = [];
  for (const p of [artifacts.full, artifacts.web, artifacts.nsisPackage]) {
    const dest = copyInto(versionDir, p);
    if (dest) copied.push(dest);
  }

  // ─── 打印清单 ────────────────────────────────────────────────
  console.log("\n[publish] 请将以下目录内容上传到 feed base（保持相对路径）：");
  console.log("  https://zy-1310897501.cos.ap-nanjing.myqcloud.com/owncoder/");
  console.log(`\n[publish] ${PUBLISH_DIR}`);
  console.log(`  ${ymlName}`);
  console.log(`  ${version}/`);
  for (const p of copied) {
    console.log(`    ${basename(p)} (${formatSize(p)})`);
  }

  console.log("\n[publish] latest.yml 内容：");
  console.log(fullYml.split("\n").map((l) => `  ${l}`).join("\n"));

  // 快速自检：应用更新元数据和 Web 下载器的安装内容必须都在版本目录。
  const missing = findMissingArtifacts(fullYml, version, versionDir);
  for (const artifact of [artifacts.web, artifacts.nsisPackage]) {
    if (!existsSync(join(versionDir, basename(artifact)))) missing.push(`${version}/${basename(artifact)}`);
  }
  if (missing.length > 0) {
    console.error("\n[publish] 发布目录中缺少安装所需文件：");
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }

  console.log("\n[publish] 自检通过：应用更新包和 Web 下载器资源均已就位");
  console.log("[publish] 上传示例（腾讯云 COS CLI，按需改）：");
  console.log(
    `  coscli cp -r "${PUBLISH_DIR}/." cos://<bucket>/owncoder/ --recursive`,
  );
}

function findMissingArtifacts(yml, version, versionDir) {
  const missing = [];
  const re = /^\s*(?:-\s+)?(?:url|path|file):\s*(.+)$/gm;
  let m;
  while ((m = re.exec(yml)) !== null) {
    let value = m[1].trim();
    if (!value || /^https?:\/\//i.test(value)) continue;
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    // 期望 "0.1.19/filename"
    const prefix = `${version}/`;
    if (!value.startsWith(prefix)) {
      missing.push(`${value} (缺少 ${prefix} 前缀)`);
      continue;
    }
    const name = value.slice(prefix.length);
    const full = join(versionDir, name);
    try {
      statSync(full);
    } catch {
      missing.push(value);
    }
  }
  return missing;
}

main().catch((err) => {
  console.error("[publish] 发布失败:", err);
  process.exit(1);
});
