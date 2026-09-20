import { readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * electron-builder afterPack hook.
 *
 * 1. Strip unused Chromium locale files (keep only en-US + zh-CN).
 * 2. Strip dxcompiler.dll (WebGPU shader compiler, not needed for a code editor).
 * 3. Strip cross-platform native prebuilds (keep only the win32-x64 binaries).
 */
export default async function afterPack(context) {
  // ── strip locales ────────────────────────────────────────────────
  const localesDir = join(context.appOutDir, "locales");
  const keepLocales = new Set(["en-US.pak", "zh-CN.pak"]);
  try {
    const files = await readdir(localesDir);
    for (const file of files) {
      if (!keepLocales.has(file)) {
        await rm(join(localesDir, file), { force: true });
        console.log(`[afterPack] removed locale: ${file}`);
      }
    }
    console.log(
      `[afterPack] kept locales: ${[...keepLocales].filter((f) => files.includes(f)).join(", ")}`,
    );
  } catch {
    console.warn("[afterPack] no locales dir found, skipping");
  }

  // ── strip dxcompiler.dll (WebGPU, ~25 MB) ──────────────────────
  const dxc = join(context.appOutDir, "dxcompiler.dll");
  try {
    await rm(dxc, { force: true });
    console.log("[afterPack] removed dxcompiler.dll (WebGPU shader compiler)");
  } catch {
    // file may already be absent
  }

  // ── strip non-win32-x64 native prebuilds ─────────────────────────
  const nativeTargets = [
    {
      root: join(context.appOutDir, "resources", "app.asar.unpacked", "node_modules", "better-sqlite3", "prebuilds"),
      keep: new Set(["win32-x64.node"]),
      filesOnly: true,
    },
    {
      root: join(context.appOutDir, "resources", "app.asar.unpacked", "node_modules", "node-pty", "prebuilds"),
      keep: new Set(["win32-x64"]),
      filesOnly: false,
    },
  ];
  for (const { root, keep, filesOnly } of nativeTargets) {
    if (!existsSync(root)) continue;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const shouldKeep = keep.has(entry.name);
      const shouldRemove =
        !shouldKeep && ((filesOnly && entry.isFile()) || (!filesOnly && entry.isDirectory()));
      if (shouldRemove) {
        await rm(join(root, entry.name), { recursive: true, force: true });
        console.log(`[afterPack] removed prebuild: ${entry.name}`);
      }
    }
  }

  // ── strip non-win32-x64 sqlite-vec platform packages ─────────────
  // sqlite-vec ships one optionalDependency per platform
  // (e.g. sqlite-vec-darwin-x64, sqlite-vec-linux-arm64); keep only the
  // main package and the win32-x64 loader binary.
  const vecModulesDir = join(
    context.appOutDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
  );
  if (existsSync(vecModulesDir)) {
    const vecEntries = await readdir(vecModulesDir, { withFileTypes: true });
    for (const entry of vecEntries) {
      if (entry.name === "sqlite-vec" || entry.name === "sqlite-vec-windows-x64") continue;
      if (entry.isDirectory() && entry.name.startsWith("sqlite-vec-")) {
        await rm(join(vecModulesDir, entry.name), { recursive: true, force: true });
        console.log(`[afterPack] removed sqlite-vec prebuild: ${entry.name}`);
      }
    }
  }
}
