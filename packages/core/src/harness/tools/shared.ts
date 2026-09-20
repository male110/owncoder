import { spawn } from "node:child_process";

import { platform, release } from "node:os";
import { relative, sep } from "node:path";
import { isPlanPath } from "../../plans.ts";
import { toAbs } from "../writable.ts";
import type { ToolContext, ToolResult } from "./types.ts";

export { toAbs };

// ── Platform (detected once at startup, then cached) ────────

/** Resolved platform string: "win32" | "darwin" | "linux" | ... */
export const PLATFORM = platform();
/** True when running on Windows. */
export const IS_WINDOWS = PLATFORM === "win32";
/** OS release string, e.g. "10.0.22631". */
export const OS_RELEASE = release();
/** Detected OS locale, e.g. "zh-CN", "en-US". */
export const OS_LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;

// ── Plan Mode Guard ────────────────────────────────────────

export function assertPlanMutationAllowed(ctx: ToolContext, relPath: string): ToolResult | null {
  if (ctx.mode !== "plan") return null;
  if (!ctx.workflow.modes.plan.allowPlanFiles) {
    return fail("Plan mode: plan file writes disabled in settings");
  }
  // `.owncoder/plans/` 下的计划/文档一律允许（save_plan / write_file / apply_patch）
  if (isPlanPath(relPath)) return null;
  // 文档交付物（.md）允许写到项目任意位置（根目录、docs/ 等），不进计划面板、不被当成计划
  if (relPath.toLowerCase().endsWith(".md")) return null;
  // 源代码等其他文件保持只读，守住 Plan 模式不改源码的契约
  return fail(
    `Plan mode is read-only for source files. Writable: \`.owncoder/plans/\` (plans via save_plan) and \`.md\` document files (deliverables via write_file). Got ${relPath}.`,
  );
}

// ── Utilities ──────────────────────────────────────────────

/**
 * Decode console output bytes to a string. On Windows the console codepage
 * is usually not UTF-8 (e.g. GBK/936 on zh-CN), so decoding raw bytes as UTF-8
 * produces mojibake. Try strict UTF-8 first and fall back to GBK on Windows.
 */
function decodeConsole(buf: Buffer): string {
  if (buf.length === 0) return "";
  if (!IS_WINDOWS) return buf.toString("utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveP) => {
    // On Windows, spawn powershell.exe directly so that PowerShell-native
    // commands (Get-ChildItem, Select-String, etc.) execute correctly.
    // Using `shell: true` would go through cmd.exe which doesn't understand them.
    const child =
      IS_WINDOWS
        ? spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-Command", command], {
            cwd,
            windowsHide: true,
          })
        : spawn(command, {
            cwd,
            shell: true,
            detached: true,
          });
    let outChunks: Buffer[] = [];
    let errChunks: Buffer[] = [];
    let stdout = "";
    let stderr = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: { stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveP(result);
    };
    const terminate = () => {
      if (settled) return;
      if (IS_WINDOWS && child.pid) {
        // Killing only powershell.exe can leave its child command running.
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else {
        child.kill();
      }
    };
    const onAbort = () => {
      terminate();
      finish({ stdout, stderr: stderr + "\n(cancelled)", code: -1 });
    };
    const t = setTimeout(() => {
      terminate();
      finish({ stdout, stderr: stderr + "\n(timeout)", code: -1 });
    }, timeoutMs);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d: Buffer) => {
      outChunks.push(d);
      stdout = decodeConsole(Buffer.concat(outChunks));
      if (stdout.length > 200_000) {
        stdout = stdout.slice(0, 200_000);
        outChunks = [Buffer.from(stdout, "utf8")];
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      errChunks.push(d);
      stderr = decodeConsole(Buffer.concat(errChunks));
      if (stderr.length > 100_000) {
        stderr = stderr.slice(0, 100_000);
        errChunks = [Buffer.from(stderr, "utf8")];
      }
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, code: code ?? 1 });
    });
    child.on("error", (err) => {
      finish({ stdout, stderr: String(err), code: 1 });
    });
  });
}

/**
 * Normalize a tool input path: treat empty/blank as the current directory.
 * Uses the platform-native path separator so it resolves correctly everywhere
 * (".\\" on Windows, "./" on Linux/macOS).
 */
export function normalizeInputPath(p: string): string {
  return p && p.trim().length > 0 ? p : "." + sep;
}

export function assertInside(root: string, abs: string): void {
  const rel = relative(root, abs);
  const escapes =
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    /^[A-Za-z]:[\\/]/.test(rel) ||
    rel.startsWith("/") ||
    rel.startsWith("\\\\");
  if (escapes) {
    throw new Error(
      `path escapes workspace: "${rel}" resolves outside workspace root "${root}". ` +
      `Use a relative path inside the workspace.`,
    );
  }
}

export function normalizeRel(root: string, abs: string): string {
  return relative(root, abs).split(/[/\\]/).join("/");
}

export function formatWithLines(text: string, startLine = 1): string {
  return text
    .split(/\r?\n/)
    .map((line, i) => `${String(startLine + i).padStart(4, " ")}|${line}`)
    .join("\n");
}

export function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

export function ok(output: string): ToolResult {
  return { ok: true, output };
}
export function fail(output: string): ToolResult {
  return { ok: false, output: `Error: ${output}` };
}
export function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
export function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
/** Tolerant boolean coercion — models frequently send "true"/"false" as strings. */
export function bool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  return false;
}
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Describe a file/editor tool call as a short human-readable status line
 * (e.g. "读取：src/foo.ts"). Returned only for tools that benefit from a live
 * progress entry; bash already emits its own terminal entry. Returns null for
 * tools that should not show a separate status line.
 */
export function statusEntry(
  name: string,
  args: Record<string, unknown>,
): { command: string } | null {
  const pick = (k: string) =>
    typeof args[k] === "string" && String(args[k]).trim().length > 0
      ? String(args[k])
      : undefined;
  const path = pick("path") ?? pick("filePath") ?? pick("query") ?? pick("pattern");

  const verb: Record<string, string> = {
    read_file: "读取",
    write_file: "写入",
    apply_patch: "编辑",
    list_dir: "列出目录",
    search_code: "搜索代码",
    search_symbols: "搜索符号",
    grep: "搜索代码",
    list_session_changes: "列出会话变更",
    undo_session_change: "撤销会话变更",
  };
  const label = verb[name];
  if (!label) return null;
  return { command: path ? `${label}：${path}` : label };
}
