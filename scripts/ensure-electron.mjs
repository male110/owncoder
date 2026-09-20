import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

function findElectronDir() {
  const pnpmDir = join(resolve("."), "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return null;
  const entries = readdirSync(pnpmDir);
  const electronEntry = entries.find(e => /^electron@\d/.test(e));
  if (!electronEntry) return null;
  return join(pnpmDir, electronEntry, "node_modules", "electron");
}

const electronDir = findElectronDir();
if (!electronDir) {
  // Electron package not yet installed via pnpm, skip silently
  process.exit(0);
}

const exeName = process.platform === "win32" ? "electron.exe" : "electron";
const electronExe = join(electronDir, "dist", exeName);
if (existsSync(electronExe)) {
  process.exit(0);
}

console.log("[owncoder] Electron binary not found, downloading...");
execSync(`node "${join(electronDir, "install.js")}"`, {
  stdio: "inherit",
  cwd: electronDir,
  env: process.env,
});

if (!existsSync(electronExe)) {
  console.error("[owncoder] Failed to download Electron binary. The app can still be started with 'pnpm dev'.");
  process.exit(0);
}
console.log("[owncoder] Electron binary downloaded successfully.");