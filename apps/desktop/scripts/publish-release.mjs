#!/usr/bin/env node
/**
 * 发布脚本：把 electron-builder 产出的 release 资源分别上传到 OSS 和 Gitee。
 *
 * 用法：
 *   # 1. 先打包（必须先 pack:win，生成本脚本要上传的文件）
 *   pnpm --filter @owncoder/desktop pack:win
 *
 *   # 2. 准备环境变量（参考 scripts/publish-release.example.env）
 *   export OSS_ACCESS_KEY_ID=...
 *   export OSS_ACCESS_KEY_SECRET=...
 *   export OSS_BUCKET=owncoder-releases
 *   export OSS_REGION=oss-cn-hangzhou
 *   export OSS_ENDPOINT=oss-cn-hangzhou.aliyuncs.com
 *   export OSS_PATH_PREFIX=owncoder  # 桶内前缀，默认 owncoder
 *   # 可选：Gitee release 自动上传（提供 GITEE_TOKEN 时启用）
 *   export GITEE_TOKEN=...
 *   export GITEE_OWNER=f6688
 *   export GITEE_REPO=owncoder
 *
 *   # 3. 跑发布脚本
 *   pnpm --filter @owncoder/desktop publish:oss
 *
 * 上传策略：
 *   - 全量安装包（*.exe, *.blockmap, *.nsis.delta, latest.yml）→ OSS
 *   - Web Installer（*-web.exe）→ OSS 同步 + Gitee release 资产（如果给了 GITEE_TOKEN）
 *   - 打印出 Gitee release 的版本号与 URL，方便手动补传
 */

import { createReadStream, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const RELEASE_DIR = resolve(__dirname, "..", "release");

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[publish] 缺少环境变量 ${name}`);
    process.exit(1);
  }
  return v;
}

function optional(name) {
  return process.env[name] || "";
}

/**
 * 把文件传到阿里云 OSS。
 * 优先用 aliyun-sdk-js（依赖较重）；没装就退化为调用本地 ossutil CLI；
 * 两个都没就只打印路径让用户手动上传。
 */
async function uploadToOss(localPath, remoteKey) {
  const bucket = required("OSS_BUCKET");
  const region = required("OSS_REGION");
  const endpoint = required("OSS_ENDPOINT");
  const accessKeyId = required("OSS_ACCESS_KEY_ID");
  const accessKeySecret = required("OSS_ACCESS_KEY_SECRET");
  const prefix = optional("OSS_PATH_PREFIX") || "owncoder";
  const key = `${prefix}/${remoteKey}`;
  const url = `https://${bucket}.${endpoint}/${key}`;

  // 优先：ali-oss
  try {
    const oss = await import("ali-oss").then((m) => m.default || m);
    const client = new oss({
      accessKeyId,
      accessKeySecret,
      bucket,
      region,
      endpoint,
      secure: true,
    });
    const result = await client.put(key, localPath, {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
    console.log(`[publish] OSS PUT ${basename(localPath)} → ${result.url}`);
    return url;
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") {
      throw new Error(`ali-oss 上传失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 退而求其次：ossutil CLI
  try {
    const { execSync } = await import("node:child_process");
    execSync(
      `ossutil cp "${localPath}" "oss://${bucket}/${key}" --update --force`,
      { stdio: "inherit" },
    );
    console.log(`[publish] ossutil PUT ${basename(localPath)} → ${url}`);
    return url;
  } catch (err) {
    throw new Error(`ossutil 上传失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 把 web installer 上传到 Gitee release 资产（可选）。 */
async function uploadToGitee(localPath, version) {
  const token = optional("GITEE_TOKEN");
  const owner = optional("GITEE_OWNER") || "f6688";
  const repo = optional("GITEE_REPO") || "owncoder";
  if (!token) return null;

  const fileBuffer = await readFile(localPath);
  const { statSync } = await import("node:fs");
  const filename = basename(localPath);
  const tag = `v${version}`;
  const releaseUrl = `https://gitee.com/api/v5/repos/${owner}/${repo}/releases`;

  // 1. 找到或创建 tag 对应的 release
  const listRes = await fetch(`${releaseUrl}?access_token=${token}&per_page=100`);
  const releases = (await listRes.json()) || [];
  let release = releases.find((r) => r.tag_name === tag);
  if (!release) {
    const createRes = await fetch(`${releaseUrl}?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: tag,
        name: tag,
        body: `自动发布 ${tag}`,
      }),
    });
    release = await createRes.json();
    if (!release?.id) {
      throw new Error(`创建 release 失败: ${JSON.stringify(release)}`);
    }
    console.log(`[publish] Gitee 创建 release ${tag}`);
  } else {
    console.log(`[publish] Gitee 复用 release ${tag}`);
  }

  // 2. 上传资产
  const assetsUrl = `https://gitee.com/api/v5/repos/${owner}/${repo}/releases/${release.id}/attach_files`;
  const form = new FormData();
  form.append("access_token", token);
  form.append("file", new Blob([fileBuffer]), filename);
  const upRes = await fetch(assetsUrl, { method: "POST", body: form });
  const upResult = await upRes.json();
  if (!Array.isArray(upResult) || upResult.length === 0) {
    throw new Error(`上传资产失败: ${JSON.stringify(upResult)}`);
  }
  const asset = upResult[0];
  console.log(`[publish] Gitee 资产已上传: ${asset.browser_download_url}`);
  return asset.browser_download_url;
}

async function listReleaseFiles() {
  try {
    return await readdir(RELEASE_DIR);
  } catch {
    return [];
  }
}

function isWindowsArtifact(name) {
  // 文件名匹配 OwnCoder Setup 0.1.10.exe / OwnCoder Setup 0.1.10-web.exe / .blockmap / .nsis.delta
  return /OwnCoder[ _]Setup[ _][\d.]+\.exe(\.blockmap|\.nsis\.delta|-web\.exe)?$/i.test(name);
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

  const prefix = optional("OSS_PATH_PREFIX") || "owncoder";
  const versionDir = `${prefix}/${version}`;

  // 1. 上传全量包 + blockmap + delta 到 OSS
  console.log(`[publish] 上传到 OSS 目录 ${versionDir}/`);
  for (const [label, path] of [
    ["全量安装包", artifacts.full],
    ["blockmap", artifacts.blockmap],
    ...artifacts.deltas.map((p) => [`差量补丁`, p]),
  ]) {
    if (!path) continue;
    const stat = statSync(path);
    console.log(`[publish]   ${label}: ${basename(path)} (${(stat.size / 1024 / 1024).toFixed(2)}M)`);
    await uploadToOss(path, `${version}/${basename(path)}`);
  }

  // 2. 上传 latest.yml 到 OSS 根目录（electron-updater 默认从这里拉清单）
  //    注意：electron-builder 也会在产物目录输出 latest.yml；如果不在就要手动构造
  const ymlName = "latest.yml";
  const ymlPath = join(RELEASE_DIR, ymlName);
  if (await fileExists(ymlPath)) {
    await uploadToOss(ymlPath, ymlName);
  } else {
    console.warn(`[publish] 未找到 ${ymlName}，electron-updater 升级可能失败`);
    console.warn(`[publish] 建议在 pack 时加 --publish always 让 electron-builder 顺带生成`);
  }

  // 3. 上传 web installer 到 OSS（也存一份方便做镜像）
  let webOssUrl = null;
  if (artifacts.web) {
    webOssUrl = await uploadToOss(artifacts.web, `${version}/${basename(artifacts.web)}`);
  }

  // 4. 把 web installer 上传到 Gitee release（可选）
  let giteeAssetUrl = null;
  if (artifacts.web) {
    giteeAssetUrl = await uploadToGitee(artifacts.web, version);
  }

  console.log("\n[publish] 发布完成！");
  console.log(`[publish] OSS 全量包: https://${optional("OSS_BUCKET") || "?"}.${optional("OSS_ENDPOINT") || "?"}/${prefix}/${version}/${basename(artifacts.full)}`);
  if (webOssUrl) console.log(`[publish] OSS Web Installer: ${webOssUrl}`);
  if (giteeAssetUrl) console.log(`[publish] Gitee 引导器资产: ${giteeAssetUrl}`);
  if (!giteeAssetUrl) {
    console.log(`[publish] Gitee release 页面: https://gitee.com/${optional("GITEE_OWNER") || "f6688"}/${optional("GITEE_REPO") || "owncoder"}/releases/tag/v${version}`);
    console.log(`[publish]   提示：手动把 ${artifacts.web ? basename(artifacts.web) : "* -web.exe"} 上传到该 release`);
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