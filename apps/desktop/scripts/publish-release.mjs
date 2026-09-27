#!/usr/bin/env node
/**
 * 发布脚本：把 electron-builder (nsis-web) 产物整理成 electron-updater 可下载的目录。
 *
 * 用法：
 *   # 1. 先打包
 *   pnpm --filter @owncoder/desktop pack:win
 *
 *   # 2. 生成本地发布目录（不上传 OSS）
 *   pnpm --filter @owncoder/desktop publish
 *
 * 客户端 feed（app-update.yml / package.json build.publish）：
 *   https://zy-1310897501.cos.ap-nanjing.myqcloud.com/owncoder/
 *   → 请求 {base}/latest.yml
 *   → 再按 yml 内 path/url 相对 base 下载 Web Setup.exe 与 packages.*.path（.nsis.7z）
 *
 * 本脚本产出（手动上传到上述 base）：
 *   release/publish/
 *     latest.yml                         # 路径已带 {version}/ 前缀
 *     {version}/
 *       OwnCoder Web Setup {version}.exe
 *       @{name}-{version}-x64.nsis.7z    # nsis-web 真正的大包，缺了会「文件下载失败」
 *       （如有）*.blockmap / *.nsis.delta
 */

import { cpSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const RELEASE_ROOT = process.env.OWNCODER_RELEASE_ROOT
  ? resolve(process.env.OWNCODER_RELEASE_ROOT)
  : resolve(__dirname, "..", "release");
// nsis-web 目标写入 release/nsis-web
const RELEASE_DIR = join(RELEASE_ROOT, "nsis-web");
// 整理后的上传目录
const PUBLISH_DIR = process.env.OWNCODER_PUBLISH_DIR
  ? resolve(process.env.OWNCODER_PUBLISH_DIR)
  : join(RELEASE_ROOT, "publish");

async function listReleaseFiles() {
  try {
    return await readdir(RELEASE_DIR);
  } catch {
    return [];
  }
}

function pickArtifacts(files, version) {
  const tag = `Setup ${version}`;
  // nsis-web: "OwnCoder Web Setup X.Y.Z.exe"；nsis: "OwnCoder Setup X.Y.Z.exe"
  const full = files.find((f) => new RegExp(`^OwnCoder[ _]${tag}\\.exe$`, "i").test(f));
  const webInstaller = files.find((f) => new RegExp(`^OwnCoder[ _]Web[ _]${tag}\\.exe$`, "i").test(f));
  const webLegacy = files.find((f) => new RegExp(`^OwnCoder[ _]${tag}-web\\.exe$`, "i").test(f));
  const web = webInstaller || webLegacy;
  const primary = full || web;

  // nsis-web 核心包：@scope-name-version-arch.nsis.7z（文件名可含 @）
  const nsisPackage = files.find((f) => /\.nsis\.7z$/i.test(f));
  const blockmaps = files.filter((f) => /\.blockmap$/i.test(f));
  const deltas = files.filter((f) => /\.nsis\.delta$/i.test(f));

  return {
    full: full ? join(RELEASE_DIR, full) : null,
    web: web ? join(RELEASE_DIR, web) : null,
    primary: primary ? join(RELEASE_DIR, primary) : null,
    nsisPackage: nsisPackage ? join(RELEASE_DIR, nsisPackage) : null,
    blockmaps: blockmaps.map((f) => join(RELEASE_DIR, f)),
    deltas: deltas.map((f) => join(RELEASE_DIR, f)),
  };
}

/**
 * 给 latest.yml 里相对路径加上 `{version}/` 前缀。
 * 必须覆盖：
 *   - 顶层 path:
 *   - files 列表项 "  - url: ..."
 *   - packages.*.path / packages.*.file
 * 并正确处理 YAML 引号（@ 开头的 .nsis.7z 会被 builder 写成 '@xxx'）。
 */
function rewriteLatestYml(yml, version) {
  return yml
    .split(/\r?\n/)
    .map((line) => {
      // 允许 "path:" / "url:" / "file:"，以及列表项 "- url:"
      const match = line.match(/^(\s*(?:-\s+)?(?:url|path|file):\s*)(.+)$/);
      if (!match) return line;

      const prefix = match[1];
      let value = match[2].trim();
      if (!value || /^https?:\/\//i.test(value)) return line;

      // 去掉一层 YAML 引号
      const single = value.startsWith("'") && value.endsWith("'") && value.length >= 2;
      const double = value.startsWith('"') && value.endsWith('"') && value.length >= 2;
      if (single || double) value = value.slice(1, -1);

      // 已带目录前缀则不重复写
      if (value.includes("/")) {
        return `${prefix}${yamlQuote(value)}`;
      }

      return `${prefix}${yamlQuote(`${version}/${value}`)}`;
    })
    .join("\n");
}

/** 路径含空格、@、或 YAML 特殊字符时加单引号。 */
function yamlQuote(value) {
  if (/[@:#\[\]{},&*?|>!%`\s]/.test(value) || value.startsWith("'") || value === "") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
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

  const files = await listReleaseFiles();
  if (files.length === 0) {
    console.error(`[publish] 未找到 release 目录: ${RELEASE_DIR}`);
    console.error("[publish] 请先跑 `pnpm --filter @owncoder/desktop pack:win`");
    process.exit(1);
  }

  const artifacts = pickArtifacts(files, version);
  if (!artifacts.primary) {
    console.error(
      `[publish] 未找到安装包 (OwnCoder Setup ${version}.exe 或 OwnCoder Web Setup ${version}.exe)`,
    );
    console.error("[publish] 请先跑 `pnpm --filter @owncoder/desktop pack:win`");
    process.exit(1);
  }

  // nsis-web 更新时会再下 packages.x64.path 指向的 .nsis.7z；缺了必现「文件下载失败」
  if (!artifacts.nsisPackage) {
    console.error("[publish] 未找到 nsis-web 包 (*.nsis.7z)，自动更新会下载失败");
    console.error(`[publish] 请确认 pack:win 的 target 为 nsis-web，并检查 ${RELEASE_DIR}`);
    process.exit(1);
  }

  const ymlName = "latest.yml";
  const ymlPath = join(RELEASE_DIR, ymlName);
  if (!(await fileExists(ymlPath))) {
    console.error(`[publish] 未找到 ${ymlPath}`);
    console.error("[publish] electron-builder 应在 nsis-web 目录生成 latest.yml；请重新 pack:win");
    process.exit(1);
  }

  const rawYml = await readFile(ymlPath, "utf8");
  const versionedYml = rewriteLatestYml(rawYml, version);

  // ─── 整理上传目录 ─────────────────────────────────────────────
  // owncoder/latest.yml
  // owncoder/{version}/Web Setup.exe + .nsis.7z + ...
  ensureEmptyDir(PUBLISH_DIR);
  const versionDir = join(PUBLISH_DIR, version);
  mkdirSync(versionDir, { recursive: true });

  const publishLatestPath = join(PUBLISH_DIR, ymlName);
  writeFileSync(publishLatestPath, versionedYml, "utf8");

  // 同步一份到 nsis-web，方便对照；以及 latest-{version}.yml 备份
  writeFileSync(join(RELEASE_DIR, ymlName), versionedYml, "utf8");
  writeFileSync(join(RELEASE_DIR, `latest-${version}.yml`), versionedYml, "utf8");

  const copied = [];
  for (const p of [
    artifacts.primary,
    artifacts.nsisPackage,
    ...artifacts.blockmaps,
    ...artifacts.deltas,
  ]) {
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
  console.log(versionedYml.split("\n").map((l) => `  ${l}`).join("\n"));

  // 快速自检：yml 里引用的文件必须都在 versionDir
  const missing = findMissingArtifacts(versionedYml, version, versionDir);
  if (missing.length > 0) {
    console.error("\n[publish] yml 引用了但目录中不存在的文件：");
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }

  console.log("\n[publish] 自检通过：yml 引用文件均已就位");
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

async function fileExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error("[publish] 发布失败:", err);
  process.exit(1);
});
