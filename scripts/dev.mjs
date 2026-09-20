import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.platform === "win32") {
  try {
    execSync("chcp 65001", { stdio: "ignore" });
  } catch {
    // ignore: chcp unavailable or not needed
  }
}

if (process.env.ELECTRON_RUN_AS_NODE) {
  console.warn("[dev] clearing ELECTRON_RUN_AS_NODE to launch Electron normally");
  delete process.env.ELECTRON_RUN_AS_NODE;
}

function findElectronDir() {
  const pnpmDir = join(resolve("."), "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return null;
  const entries = readdirSync(pnpmDir);
  const electronEntry = entries.find(e => /^electron@\d/.test(e));
  if (!electronEntry) return null;
  return join(pnpmDir, electronEntry, "node_modules", "electron");
}

function ensureElectronInstalled() {
  try {
    const electronDir = findElectronDir();
    if (!electronDir) {
      console.error("[dev] Cannot find electron package in node_modules. Run 'pnpm install' first.");
      process.exit(1);
    }
    const exeName = process.platform === "win32" ? "electron.exe" : "electron";
    const electronExe = join(electronDir, "dist", exeName);
    if (existsSync(electronExe)) {
      return;
    }
    console.log("[dev] Electron binary not found, installing...");
    execSync(`node "${join(electronDir, "install.js")}"`, {
      stdio: "inherit",
      cwd: electronDir,
      env: process.env,
    });
    if (!existsSync(electronExe)) {
      console.error("[dev] Failed to install Electron. Please run 'node node_modules/electron/install.js' manually.");
      process.exit(1);
    }
    console.log("[dev] Electron installed successfully.");
  } catch (err) {
    console.error("[dev] Electron install check failed:", err.message);
    process.exit(1);
  }
}

ensureElectronInstalled();

// 设置开发环境变量
process.env.NODE_ENV = "development";
process.env.OWNCODER_DEV = "true";

const result = spawnSync("pnpm", ["--filter", "@owncoder/desktop", "dev"], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

process.exit(result.status ?? 0);