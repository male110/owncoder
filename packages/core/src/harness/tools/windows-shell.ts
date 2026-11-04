/**
 * Windows 命令执行壳解析：使用 Windows 内置 PowerShell。
 *
 * 保留 MSYS2 类型与环境辅助函数供兼容代码和测试使用，但不再把随包
 * MSYS2 bash 作为默认命令执行壳；OWNCODER_MSYS2_ROOT 不影响默认选择。
 */

import { delimiter, join } from "node:path";

export type ResolvedWindowsShell =
  | { kind: "msys2-bash"; root: string; bashPath: string; binDir: string }
  | { kind: "powershell" };

let cached: ResolvedWindowsShell | undefined;
let resolved = false;

/** 解析 Windows 执行壳；一次会话内缓存（bundle 不会中途变化）。 */
export function resolveWindowsShell(): ResolvedWindowsShell {
  if (resolved) return cached!;
  resolved = true;
  cached = { kind: "powershell" };
  return cached;
}

/**
 * 随包 bash 子进程环境：
 * - PATH 前置 bundle 的 usr/bin——bash 自身命令解析已含 /usr/bin，前置
 *   是为 bash 派生的 Windows 原生孙进程（node/npm 脚本再 spawn 时）
 *   也能找到随包工具；
 * - 删除 MSYSTEM——防 mintty 登录壳设定泄漏（MINGW64 等会改变 msys
 *   运行时的 PATH 组装与路径转换行为）；
 * - HOME 兜底到 USERPROFILE——Windows 原生进程通常不设 HOME，而部分
 *   msys 工具（git 配置读取等）需要可写 home。
 */
export function msys2SpawnEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MSYSTEM;
  const binDir = join(root, "usr", "bin");
  env.PATH = `${binDir}${delimiter}${env.PATH ?? ""}`;
  if (!env.HOME) env.HOME = env.USERPROFILE ?? env.TEMP ?? root;
  return env;
}

/** 测试钩子：清理解析缓存。 */
export function resetWindowsShellCacheForTest(): void {
  cached = undefined;
  resolved = false;
}
