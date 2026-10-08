#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
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

run("pnpm", ["build"]);
run("pnpm", ["exec", "electron-builder", "--win", "nsis"]);
run("pnpm", ["exec", "electron-builder", "--win", "nsis-web", `-c.nsisWeb.appPackageUrl=${appPackageUrl}`]);
