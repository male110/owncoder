import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (process.env.ELECTRON_RUN_AS_NODE) {
  delete process.env.ELECTRON_RUN_AS_NODE;
}

const electronVite = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "electron-vite",
  "bin",
  "electron-vite.js",
);

// Vite/Node 侧：避免 electron-vite 自身在打包 main/preload 时 OOM。
const nodeOptions = new Set(
  (process.env.NODE_OPTIONS ?? "").split(" ").map((s) => s.trim()).filter(Boolean),
);
nodeOptions.add("--max-old-space-size=8192");
process.env.NODE_OPTIONS = [...nodeOptions].join(" ");

// Let electron-vite provide the normal app entry (`.`). Overriding
// ELECTRON_ENTRY with a switch makes Electron treat the switch as the app
// path and only print its CLI usage instead of launching the app.
const child = spawn(
  process.execPath,
  [electronVite, "dev"],
  { stdio: "inherit", env: process.env, cwd: join(dirname(fileURLToPath(import.meta.url)), "..") },
);

child.on("close", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});
