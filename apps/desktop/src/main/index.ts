import { existsSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Resolve Electron's appData root without importing `electron`.
 * Importing electron first would create the default userData path from
 * package.json name (`@owncoder/desktop` → `%APPDATA%/@owncoder/desktop`),
 * which creates `@owncoder` before we can rename `@owncode` → `@owncoder`.
 */
function getAppDataDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error("[migration] APPDATA is not set");
    return appData;
  }
  if (process.platform === "darwin") {
    const home = process.env.HOME;
    if (!home) throw new Error("[migration] HOME is not set");
    return join(home, "Library", "Application Support");
  }
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  const home = process.env.HOME;
  if (!home) throw new Error("[migration] HOME is not set");
  return join(home, ".config");
}

function renameLegacyDir(legacyDir: string, currentDir: string): void {
  if (!existsSync(legacyDir)) return;
  // 先建新目录再迁移时目标已存在：跳过 rename，避免 bootstrap 直接崩溃。
  // 旧数据仍留在 legacy，需用户自行合并；空的新目录可继续启动。
  if (existsSync(currentDir)) {
    console.warn(
      `[migration] skip rename: ${currentDir} already exists (legacy left at ${legacyDir})`,
    );
    return;
  }
  renameSync(legacyDir, currentDir);
  console.info(`[migration] renamed ${legacyDir} to ${currentDir}`);
}

/**
 * Only AppData/userData must migrate before `electron` loads.
 * Workspace `.owncode` → `.owncoder` stays in main-app openWorkspaceRoot:
 * at bootstrap the workspace tree is often locked (CWD, watchers, IDE),
 * which surfaces as EPERM on Windows even when Explorer can rename it.
 */
function migrateBeforeElectron(): string {
  const appDataDir = getAppDataDir();
  const legacyRoot = join(appDataDir, "@owncode");
  const currentRoot = join(appDataDir, "@owncoder");

  // Pure rename only — never merge. Must run before any electron import.
  renameLegacyDir(legacyRoot, currentRoot);

  const userDataDir = join(currentRoot, "desktop");
  renameLegacyDir(join(userDataDir, "owncode"), join(userDataDir, "owncoder"));

  return userDataDir;
}

function bootstrap(): void {
  const userDataDir = migrateBeforeElectron();

  // Load electron only after legacy dirs are renamed, then pin userData.
  // Bundled main is CJS, so __filename is available for createRequire.
  const require = createRequire(__filename);
  const { app } = require("electron") as typeof import("electron");
  app.setPath("userData", userDataDir);
  // npm 作为独立资源发布；安装和启动均复用 Electron 内置 Node。
  process.env.OWNCODER_LSP_NPM_CLI = app.isPackaged
    ? join(process.resourcesPath, "lsp-npm", "bin", "npm-cli.js")
    : join(require.resolve("npm"), "..", "bin", "npm-cli.js");
  // 预打包的常见 LSP 目录
  process.env.OWNCODER_LSP_PREINSTALLED_PATH = app.isPackaged
    ? join(process.resourcesPath, "lsp-preinstalled")
    : "";
  // 内置 MSYS2 运行时：Windows 上 bash tool 与 run_script 沙箱字符串命令
  // 的 POSIX 执行环境（resources/msys2，afterPack 拷贝）。dev 未跑
  // prepare:msys2 时目录不存在 → 不注入 → 运行期回退 PowerShell。
  if (process.platform === "win32") {
    const msys2Root = app.isPackaged
      ? join(process.resourcesPath, "msys2")
      : join(app.getAppPath(), "bundled-tools", "msys2");
    if (existsSync(join(msys2Root, "usr", "bin", "bash.exe"))) {
      process.env.OWNCODER_MSYS2_ROOT = msys2Root;
    }
  }
}

bootstrap();
void import("./main-app");
