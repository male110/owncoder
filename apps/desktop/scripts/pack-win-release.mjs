#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

function patchNodePty() {
  const patchScript = resolve(__dirname, "patch-node-pty.mjs");
  const result = spawnSync(process.execPath, [patchScript], {
    cwd: resolve(__dirname, ".."),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const packageDir = resolve(__dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));
const version = packageJson.version;
const publishBaseUrl = "https://zy-1310897501.cos.ap-nanjing.myqcloud.com/owncoder";
const nsisPackageFileName = `@owncoderdesktop-${version}-x64.nsis.7z`;
const appPackageUrl = `${publishBaseUrl}/${version}/${encodeURIComponent(nsisPackageFileName)}`;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid package version for nsis-web appPackageUrl: ${version}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageDir,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

patchNodePty();
run("pnpm", ["build"]);
run("pnpm", ["exec", "electron-builder", "--win", "nsis"]);
patchNodePty();
run("pnpm", ["exec", "electron-builder", "--win", "nsis-web", `-c.nsisWeb.appPackageUrl=${appPackageUrl}`]);
// 内置 MSYS2 运行时冒烟（空 PATH 自足性 + win-unpacked 落位）；失败阻断发布。
run("node", ["./scripts/verify-msys2-runtime.mjs"]);
