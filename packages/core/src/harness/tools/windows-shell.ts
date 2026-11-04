/**
 * Windows 命令执行壳解析：使用 Windows 内置 PowerShell。
 */

export type ResolvedWindowsShell = { kind: "powershell" };

let cached: ResolvedWindowsShell | undefined;
let resolved = false;

/** 解析 Windows 执行壳；一次会话内缓存（bundle 不会中途变化）。 */
export function resolveWindowsShell(): ResolvedWindowsShell {
  if (resolved) return cached!;
  resolved = true;
  cached = { kind: "powershell" };
  return cached!;
}
