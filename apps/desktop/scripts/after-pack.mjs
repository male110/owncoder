import { readdir, rm } from "node:fs/promises";
import { cpSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * electron-builder afterPack hook.
 *
 * 1. Strip unused Chromium locale files (keep only en-US + zh-CN).
 * 2. Strip dxcompiler.dll (WebGPU shader compiler, not needed for a code editor).
 * 3. Strip cross-platform native prebuilds for the current target platform and architecture.
 */
export default async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = context.arch === 3 ? "arm64" : "x64";
  const resourcesDir =
    platform === "darwin"
      ? join(context.appOutDir, "Contents", "Resources")
      : join(context.appOutDir, "resources");

  // ── strip locales ────────────────────────────────────────────────
  const localesDir =
    platform === "darwin"
      ? join(
          context.appOutDir,
          "Contents",
          "Frameworks",
          "Electron Framework.framework",
          "Versions",
          "A",
          "Resources",
          "locales",
        )
      : join(context.appOutDir, "locales");
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

  // ── strip native prebuilds for other targets ──────────────────────
  const nativeTargets = [
    {
      root: join(resourcesDir, "app.asar.unpacked", "node_modules", "better-sqlite3", "prebuilds"),
      keep: new Set([`${platform}-${arch}.node`]),
      filesOnly: true,
    },
    {
      root: join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds"),
      keep: new Set([`${platform}-${arch}`]),
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

  // ── strip node-pty ConPTY binaries for other Windows architectures ─
  const conptyDir = join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "third_party",
    "conpty",
  );
  if (platform === "win32" && existsSync(conptyDir)) {
    const versions = await readdir(conptyDir, { withFileTypes: true });
    for (const version of versions) {
      if (!version.isDirectory()) continue;
      const versionDir = join(conptyDir, version.name);
      const targets = await readdir(versionDir, { withFileTypes: true });
      for (const target of targets) {
        if (target.isDirectory() && target.name !== `win10-${arch}`) {
          await rm(join(versionDir, target.name), { recursive: true, force: true });
          console.log(`[afterPack] removed ConPTY prebuild: ${target.name}`);
        }
      }
    }
  }

  // ── strip sqlite-vec platform packages for other targets ──────────
  // sqlite-vec ships one optionalDependency per platform
  // (e.g. sqlite-vec-darwin-x64, sqlite-vec-linux-arm64); keep only the
  // main package and the loader binary matching this build target.
  const vecModulesDir = join(resourcesDir, "app.asar.unpacked", "node_modules");
  if (existsSync(vecModulesDir)) {
    const vecEntries = await readdir(vecModulesDir, { withFileTypes: true });
    for (const entry of vecEntries) {
      const sqliteVecPlatform = platform === "win32" ? "windows" : platform;
      if (entry.name === "sqlite-vec" || entry.name === `sqlite-vec-${sqliteVecPlatform}-${arch}`) continue;
      if (entry.isDirectory() && entry.name.startsWith("sqlite-vec-")) {
        await rm(join(vecModulesDir, entry.name), { recursive: true, force: true });
        console.log(`[afterPack] removed sqlite-vec prebuild: ${entry.name}`);
      }
    }
  }

  // ── bundle MSYS2 runtime (Windows only) ──────────────────────────
  // 内置 POSIX bash 执行环境（bash tool 与 run_script 沙箱字符串命令）。
  // prepare 管线产物在 apps/desktop/bundled-tools/msys2；Windows 构建必须
  // 先跑 pnpm prepare:msys2，缺失即失败（platform_info 向模型承诺了
  // POSIX bash，不能静默退化为 PowerShell 方言）。
  if (platform === "win32") {
    const msys2Src = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "bundled-tools",
      "msys2",
    );
    if (!existsSync(msys2Src)) {
      throw new Error(
        "[afterPack] bundled-tools/msys2 不存在——Windows 构建必须先跑 " +
          "pnpm --filter @owncoder/desktop prepare:msys2（内置 MSYS2 运行时）",
      );
    }
    cpSync(msys2Src, join(resourcesDir, "msys2"), { recursive: true });
    console.log("[afterPack] bundled MSYS2 runtime → resources/msys2");
  }}
