import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Electron 自带 Node；普通 Node 宿主也使用当前进程，避免依赖 PATH。 */
export function lspNodeRuntime(): { command: string; env: NodeJS.ProcessEnv } {
  return {
    command: process.execPath,
    env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
  };
}

/** 通过包的 bin 元数据或 Unix 符号链接找到入口，避免执行 .cmd 或依赖 shebang 的 node。 */
export function resolveLspNodeEntry(binPath: string, command: string): string | null {
  try {
    const real = realpathSync(binPath);
    if (/\.(?:[cm]?js)$/i.test(real)) return real;
    const modules = path.dirname(path.dirname(binPath));
    for (const name of readdirSync(modules)) {
      if (name.startsWith(".")) continue;
      const dirs = name.startsWith("@")
        ? readdirSync(path.join(modules, name)).map((child) => path.join(modules, name, child))
        : [path.join(modules, name)];
      for (const dir of dirs) {
        const manifest = path.join(dir, "package.json");
        if (!existsSync(manifest)) continue;
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
          name?: string; bin?: string | Record<string, string>;
        };
        const entry = typeof pkg.bin === "string"
          ? (pkg.name?.split("/").pop() === command ? pkg.bin : undefined)
          : pkg.bin?.[command];
        if (!entry) continue;
        const target = path.resolve(dir, entry);
        if (!existsSync(target)) continue;
        if (/\.(?:[cm]?js)$/i.test(target) || /^#!.*\bnode\b/.test(readFileSync(target, "utf8"))) return target;
      }
    }
  } catch {
    // 非 npm 可执行文件保留原有启动方式。
  }
  return null;
}

/** Windows 的 npm.cmd 不能通过 execFile 直接执行；使用 Node 执行 npm 入口。 */
export async function runLspNpmInstall(args: string[], cwd: string): Promise<void> {
  let command = "npm";
  // 添加国内镜像源支持，默认使用淘宝镜像，可通过环境变量自定义
  const registry = process.env.OWNCODER_NPM_REGISTRY || "https://registry.npmmirror.com";
  const registryArgs = ["--registry", registry];
  let commandArgs = [...args, ...registryArgs];
  const bundledCli = process.env.OWNCODER_LSP_NPM_CLI;
  const runtime = lspNodeRuntime();
  if (bundledCli) {
    if (!existsSync(bundledCli)) throw new Error(`应用内 npm 资源缺失：${bundledCli}；请重新安装 OwnCoder。`);
    command = runtime.command;
    commandArgs = [bundledCli, ...args, ...registryArgs];
  } else if (process.platform === "win32") {
    let npmPaths: string;
    try {
      ({ stdout: npmPaths } = await execFileAsync("where.exe", ["npm.cmd"], { windowsHide: true }));
    } catch {
      throw new Error("PATH 中找不到 npm.cmd；请安装包含 npm 的 Node.js，并重启应用使 PATH 生效。");
    }
    const npmCli = npmPaths.trim().split(/\r?\n/)
      .map((shim) => path.join(path.dirname(shim.trim()), "node_modules", "npm", "bin", "npm-cli.js"))
      .find((candidate) => existsSync(candidate));
    if (!npmCli) {
      throw new Error("找到了 npm.cmd，但找不到对应的 node_modules/npm/bin/npm-cli.js；请修复或重新安装 Node.js/npm。");
    }
    command = runtime.command;
    commandArgs = [npmCli, ...args, ...registryArgs];
  }
  try {
    await execFileAsync(command, commandArgs, {
      cwd,
      env: runtime.env,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`无法启动 ${command}；请确认 Node.js/npm 已安装且位于 PATH 中，然后重启应用。`, { cause: error });
    }
    throw error;
  }
}
