#!/usr/bin/env node
/**
 * 发布脚本：生成 electron-builder 产出的发布文件。
 *
 * 用法：
 *   # 1. 先打包（必须先 pack:win，生成本脚本需要的文件）
 *   pnpm --filter @owncoder/desktop pack:win
 *
 *   # 2. 跑发布脚本（生成 latest.yml，列出发布文件）
 *   pnpm --filter @owncoder/desktop publish
 *
 * 本脚本只负责：
 *   - 检测 release 产物目录中的安装包、blockmap、delta 等文件
 *   - 生成带版本路径前缀的 latest.yml（供 electron-updater 使用）
 *   - 打印发布文件清单
 */

import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const RELEASE_ROOT = resolve(__dirname, "..", "release");
// The configured nsis-web target writes artifacts into release/nsis-web.
// Keep the publisher aligned with electron-builder's actual output directory.
const RELEASE_DIR = join(RELEASE_ROOT, "nsis-web");

async function listReleaseFiles() {
  try {
    return await readdir(RELEASE_DIR);
  } catch {
    return [];
  }
}

function pickArtifacts(files, version) {
  const tag = `Setup ${version}`;
  const full = files.find((f) => new RegExp(`OwnCoder[ _]${tag}\\.exe$`, "i").test(f));
  const web = files.find((f) => new RegExp(`OwnCoder[ _]${tag}-web\\.exe$`, "i").test(f));
  const blockmap = files.find((f) => new RegExp(`OwnCoder[ _]${tag}\\.exe\\.blockmap$`, "i").test(f));
  const deltas = files.filter((f) =>
    new RegExp(`OwnCoder[ _]\\d+\\.\\d+\\.\\d+-\\d+\\.\\d+\\.\\d+\\.exe\\.nsis\\.delta$`, "i").test(f),
  );
  return {
    full: full ? join(RELEASE_DIR, full) : null,
    web: web ? join(RELEASE_DIR, web) : null,
    blockmap: blockmap ? join(RELEASE_DIR, blockmap) : null,
    deltas: deltas.map((d) => join(RELEASE_DIR, d)),
  };
}

async function main() {
  const pkg = JSON.parse(
    await readFile(resolve(__dirname, "..", "package.json"), "utf8"),
  );
  const version = pkg.version;
  console.log(`[publish] 发布版本 ${version}`);

  const files = await listReleaseFiles();
  if (files.length === 0) {
    console.error(`[publish] 未找到 release 目录: ${RELEASE_DIR}`);
    console.error("[publish] 请先跑 `pnpm --filter @owncoder/desktop pack:win`");
    process.exit(1);
  }

  const artifacts = pickArtifacts(files, version);
  if (!artifacts.full) {
    console.error(`[publish] 未找到全量安装包 (OwnCoder Setup ${version}.exe)`);
    process.exit(1);
  }
  if (!artifacts.web) {
    console.warn(`[publish] 未找到 web installer (OwnCoder Setup ${version}-web.exe)`);
    console.warn("[publish] 检查 apps/desktop/package.json 的 build.nsis.webInstaller");
  }

  // ─── 1. 生成带版本路径的 latest.yml ───────────────────────────
  const ymlName = "latest.yml";
  const ymlPath = join(RELEASE_DIR, ymlName);
  const versionedYmlPath = join(RELEASE_DIR, `latest-${version}.yml`);

  if (await fileExists(ymlPath)) {
    // Artifacts are stored under <prefix>/<version>/, while latest.yml is
    // served from <prefix>/. Rewrite artifact references so electron-updater
    // follows the same versioned directory.
    const yml = await readFile(ymlPath, "utf8");
    const versionedYml = yml
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^(\s*(?:url|path|file):\s*)(?!https?:\/\/)(.+)$/);
        if (!match) return line;
        const value = match[2].trim();
        if (!value || value.includes("/")) return line;
        return `${match[1]}${version}/${value}`;
      })
      .join("\n");
    await writeFile(versionedYmlPath, versionedYml, "utf8");
    console.log(`[publish] 已生成版本化 latest.yml → ${versionedYmlPath}`);
  } else {
    console.warn(`[publish] 未找到 ${ymlName}，electron-updater 升级可能失败`);
    console.warn(`[publish] 建议在 pack 时加 --publish always 让 electron-builder 顺带生成`);
  }

  // ─── 2. 汇总文件信息 ──────────────────────────────────────────
  console.log("\n[publish] 生成的发布文件：");

  for (const [label, path] of [
    ["全量安装包", artifacts.full],
    ["blockmap", artifacts.blockmap],
    ...artifacts.deltas.map((p) => [`差量补丁`, p]),
  ]) {
    if (!path) continue;
    const stat = statSync(path);
    const size = (stat.size / 1024 / 1024).toFixed(2);
    console.log(`  ${label}: ${basename(path)} (${size}M)`);
  }
  if (artifacts.web) {
    const stat = statSync(artifacts.web);
    const size = (stat.size / 1024 / 1024).toFixed(2);
    console.log(`  Web Installer: ${basename(artifacts.web)} (${size}M)`);
  }

  if (await fileExists(versionedYmlPath)) {
    console.log(`\n[publish] 版本化 latest.yml 内容预览：`);
    const content = await readFile(versionedYmlPath, "utf8");
    console.log(content.split("\n").map((l) => `  ${l}`).join("\n"));
  }
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
