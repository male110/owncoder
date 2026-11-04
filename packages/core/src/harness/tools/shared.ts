import { spawn } from "node:child_process";

import { platform, release } from "node:os";
import { relative, sep } from "node:path";
import { featureDirRel } from "../../specs.ts";
import { toAbs } from "../writable.ts";
import type { ToolContext, ToolResult } from "./types.ts";

export { toAbs };

// ── Bash search-command exclusion injection ────────────────
//
// bash 工具与 run_script 沙箱直接执行模型给出的命令，不会经过
// list_dir/grep 工具的 isSkipDirName() 过滤，因此 `.owncoder/`（规格文档、
// 会话状态等 harness 内部产物）会泄漏进 grep/rg/find/ls -R 的结果，
// 污染上下文并在模型回读时造成干扰。这里在命令真正 spawn 之前，对
// 命令串最开头的 grep/rg/find/ls -R 注入排除参数。
//
// 设计原则（保守优先）：
// - 只匹配 trim 后命令串的最开头（`/^(?:grep|rg|find|ls)\b/`），管道、
//   子壳、`&&`/`;` 之后的段落一律不处理——`git grep` 等带前缀的命令
//   天然不匹配，原样执行。
// - 用户已显式给出 --exclude-dir/--exclude 时尊重其意图，不注入。
// - 注入位置一律选在"命令名之后的首个 token 边界"（grep/rg/ls）或
//   "最后一个路径参数之后"（find，GNU find 要求路径先于表达式），
//   管道下游命令的参数不受影响。
// - 任何无法识别的形态（引号未闭合、未知选项组合）都原样返回，
//   保证"识别失败 = 原命令执行"的安全降级。

/** 命令开头可注入排除参数的工具。 */
const SEARCH_COMMAND_RE = /^(grep|rg|find|ls)(?:\s|$)/;

/** 目录名安全字符集：字母数字、点、连字符、下划线。含其他字符的条目跳过。 */
const SAFE_DIR_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * 带原始文本与位置的 shell 分词：保留引号原文（不做去引号处理），
 * 记录每个 token 在命令串中的 [start, end) 偏移，供注入时做字符串
 * 切片插入（避免重组 token 破坏引号/转义）。引号未闭合返回 null。
 */
interface RawToken {
  text: string;
  start: number;
  end: number;
}

function tokenizeWithPositions(command: string): RawToken[] | null {
  const tokens: RawToken[] = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    // 跳过空白（token 分隔符）。
    while (i < n && /\s/.test(command[i]!)) i++;
    if (i >= n) break;
    const start = i;
    let quote: "'" | '"' | null = null;
    let text = "";
    while (i < n) {
      const ch = command[i]!;
      if (quote) {
        if (ch === quote) {
          quote = null;
          text += ch;
          i++;
        } else {
          text += ch;
          i++;
        }
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        text += ch;
        i++;
        continue;
      }
      if (/\s/.test(ch)) break;
      text += ch;
      i++;
    }
    if (quote) return null; // 引号未闭合——无法安全分词
    tokens.push({ text, start, end: i });
  }
  return tokens;
}

/** 判断 token 是否为 GNU 选项（以 - 开头；单独的 "-" 是 stdin 占位符，不算）。 */
function isOptionToken(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

/**
 * 为 bash 搜索命令注入 `.owncoder` 等目录的排除参数。
 *
 * @param command  原始命令字符串（可能含管道/重定向，但只处理最开头段落）
 * @param exclusions  要排除的目录名列表（默认 [".owncoder"]；空数组关闭注入）
 * @returns 注入排除参数后的命令；无法识别或无需注入时原样返回
 */
export function injectOwncoderExclusion(
  command: string,
  exclusions: readonly string[] = [".owncoder"],
): string {
  // 空排除列表 = 显式关闭注入；含不安全字符的条目直接丢弃。
  const dirs = exclusions.filter((d) => SAFE_DIR_NAME_RE.test(d));
  if (dirs.length === 0) return command;

  const trimmed = command.trim();
  if (!trimmed) return command;

  const head = SEARCH_COMMAND_RE.exec(trimmed);
  if (!head) return command; // 非搜索命令（或带 git 等前缀）——原样
  const tool = head[1]!;

  const tokens = tokenizeWithPositions(trimmed);
  if (!tokens || tokens.length === 0) return command; // 引号未闭合——原样

  // 用户已显式指定排除/包含过滤时尊重其意图，不注入。
  if (tool === "grep" || tool === "rg") {
    const hasExplicitFilter = tokens.slice(1).some((t) =>
      t.text.startsWith("--exclude-dir=") || t.text.startsWith("--exclude=") ||
      t.text === "--exclude-dir" || t.text === "--exclude" ||
      t.text.startsWith("--glob=") || t.text === "--glob"
    );
    if (hasExplicitFilter) return command;
  }

  // grep/rg/ls：排除参数插入到命令名之后（首个 token 边界之前），
  // 保证管道下游命令（| wc -l 等）的参数不被污染。
  if (tool === "grep" || tool === "rg" || tool === "ls") {
    if (tool === "ls") {
      // 仅递归列出（-R/--recursive，含 -laR 组合短选项）时需要排除。
      const hasRecursive = tokens.slice(1).some(
        (t) => t.text === "--recursive" || /^-[A-Za-z]*R/.test(t.text),
      );
      if (!hasRecursive) return command;
      // 已显式 --ignore 该目录时幂等跳过。
      const alreadyIgnored = tokens.slice(1).some((t) =>
        dirs.some((d) => t.text === `--ignore=${d}`)
      );
      if (alreadyIgnored) return command;
    }
    const flags = tool === "grep"
      ? dirs.map((d) => `--exclude-dir=${d}`)
      : tool === "rg"
        ? dirs.map((d) => `--glob=!${d}/**`)
        : dirs.map((d) => `--ignore=${d}`);
    // 插入点：命令名 token 的结束偏移（其后可能是空白或直接是下一个 token）。
    const insertAt = tokens[0]!.end;
    return trimmed.slice(0, insertAt) + ` ${flags.join(" ")}` + trimmed.slice(insertAt);
  }

  if (tool === "find") {
    // 幂等：用户已用 -path/-not -path 排除目标目录时不再注入。
    const alreadyExcluded = tokens.some((t, idx) =>
      (t.text === "-path" || t.text === "-ipath") &&
      dirs.some((d) => tokens[idx + 1]?.text.includes(`*/${d}/*`))
    );
    if (alreadyExcluded) return command;
    // GNU find 要求所有路径出现在表达式之前，排除谓词必须注入到
    // 最后一个路径参数之后、第一个表达式谓词之前。
    const injectAt = findInjectionOffset(tokens);
    if (injectAt === -1) return command;
    const predicates = dirs.map((d) => `-not -path '*/${d}/*'`);
    // 注入点在字符串末尾（无路径参数）时直接追加；否则在偏移处插入。
    if (injectAt >= trimmed.length) {
      return trimmed + " " + predicates.join(" ");
    }
    return trimmed.slice(0, injectAt) + predicates.join(" ") + " " + trimmed.slice(injectAt);
  }
  return command;
}

/**
 * 定位 find 命令中排除谓词的注入偏移：最后一个路径参数之后。
 * 路径参数 = 不以 - 开头、且不是"取值型谓词"的值的 token。
 * 返回原始字符串中的插入偏移；无法判定时返回 -1（调用方原样返回）。
 */
function findInjectionOffset(tokens: readonly RawToken[]): number {
  // find 的取值型谓词（后跟一个参数）：-newer/-path/-name 等。
  const valuePredicates = new Set([
    "-newer", "-path", "-name", "-iname", "-regex", "-iregex", "-lname", "-ilname",
    "-gid", "-uid", "-group", "-user", "-perm", "-type", "-size", "-links",
  ]);
  let lastPathEnd = -1;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isOptionToken(t.text)) {
      // 取值型谓词跳过其后的值（值可能是路径样字符串，不算路径参数）。
      if (valuePredicates.has(t.text)) i++;
      continue;
    }
    lastPathEnd = t.end;
  }
  // 无路径参数时注入到命令末尾（find 默认搜索 "."，谓词可前置）。
  return lastPathEnd === -1 ? tokens[tokens.length - 1]!.end : lastPathEnd + 1;
}

// ── Platform (detected once at startup, then cached) ────────

/** Resolved platform string: "win32" | "darwin" | "linux" | ... */
export const PLATFORM = platform();
/** True when running on Windows. */
export const IS_WINDOWS = PLATFORM === "win32";
/** OS release string, e.g. "10.0.22631". */
export const OS_RELEASE = release();
/** Detected OS locale, e.g. "zh-CN", "en-US". */
export const OS_LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;

// ── Spec Mode Guard ───────────────────────────────────────

export function assertSpecMutationAllowed(ctx: ToolContext, relPath: string): ToolResult | null {
  if (ctx.mode !== "spec") return null;
  if (!ctx.workflow.modes.spec.allowSpecFiles) {
    return fail("Spec mode: file writes disabled in settings");
  }
  // `.owncoder/specs/` 下的规格文档一律允许（save_spec / save_design / save_tasks）
  if (isSpecPath(relPath)) return null;
  // 旧版 `.owncoder/plans/` 目录保留只读兼容，不再作为工作流入口
  // 文档交付物（.md）允许写到项目任意位置（根目录、docs/ 等），不进 spec 面板
  if (relPath.toLowerCase().endsWith(".md")) return null;
  // 源代码等其他文件保持只读，守住 Spec 模式不改源码的契约
  return fail(
    `Spec mode is read-only for source files. Writable: \`.owncoder/specs/\` (specs via save_spec/save_design/save_tasks) and \`.md\` document files (deliverables via write_file). Got ${relPath}.`,
  );
}

/** True when relPath sits under `.owncoder/specs/`. */
export function isSpecPath(relPath: string): boolean {
  const prefix = `${featureDirRel("")}/`;
  const norm = relPath.replace(/\\/g, "/");
  return norm === prefix.slice(0, -1) || norm.startsWith(prefix);
}

/** Backwards-compatible alias; plan files stay readable for legacy sessions. */
export function assertPlanMutationAllowed(ctx: ToolContext, relPath: string): ToolResult | null {
  return assertSpecMutationAllowed(ctx, relPath);
}

// ── Utilities ──────────────────────────────────────────────

/**
 * Decode console output bytes to a string. Always use UTF-8.
 * On Windows the console codepage is often not UTF-8 (e.g. GBK/936 on
 * zh-CN), but source files and modern tooling produce UTF-8 bytes.
 * The Windows wrapper below forces powershell.exe's console encoding to
 * UTF-8, so its stdout/stderr (including localized error text) round-trips.
 * Falling back to GBK silently mis-decodes UTF-8 content (produces
 * mojibake that looks plausible but is wrong), which caused the
 * run-script.ts loop where the LLM kept re-reading a file it could
 * not understand. Invalid bytes are replaced with U+FFFD instead.
 */
function decodeConsole(buf: Buffer): string {
  if (buf.length === 0) return "";
  return buf.toString("utf8");
}

export interface RunCommandOptions {
  /**
   * bash 搜索命令（grep/rg/find/ls -R）需要排除的目录名列表。
   * 默认 [".owncoder"]；传空数组可完全关闭注入。PowerShell 回退分支
   * 不注入（GNU 参数与 PowerShell 方言不兼容）。
   */
  searchExclusions?: readonly string[];
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  options?: RunCommandOptions,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveP) => {
    // On Windows, spawn powershell.exe directly so that PowerShell-native
    // commands (Get-ChildItem, Select-String, etc.) execute correctly.
    // Using `shell: true` would go through cmd.exe which doesn't understand them.
    //
    // NOTE: powershell.exe has NO -OutputEncoding switch. Passing it makes
    // the argument parser treat the rest of the line ("-OutputEncoding UTF8
    // -Command …") as the script text itself, so every call dumps a localized
    // CommandNotFoundException into stderr — and on zh-CN systems that error
    // arrives as GBK bytes, which decodeConsole (UTF-8) renders as mojibake.
    // Encoding must be configured inside the process instead:
    //   - [Console]::OutputEncoding makes both stdout and stderr emit UTF-8
    //     bytes, matching decodeConsole.
    //   - $OutputEncoding covers piping strings into native commands.
    //   - $PSDefaultParameterValues makes Get-Content read files as UTF-8 by
    //     default instead of the system ANSI codepage, which is the root cause
    //     of mojibake when reading UTF-8 source files without a BOM.
    // Windows 使用系统内置 powershell.exe，避免默认命令执行进入 MSYS2 bash。
    const spawnedCommand = !IS_WINDOWS
      ? injectOwncoderExclusion(command, options?.searchExclusions ?? [".owncoder"])
      : command;
    const child =
      IS_WINDOWS
        ? spawn("powershell.exe", [
            "-NoProfile", "-NoLogo",
            "-Command",
              `try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}; ` +
                `$OutputEncoding = [Text.Encoding]::UTF8; ` +
                `$PSDefaultParameterValues['Get-Content:Encoding']='UTF8'; ${command}`,
          ], {
            cwd,
            windowsHide: true,
          })
        : spawn(spawnedCommand, {
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

    });
    child.stderr?.on("data", (d: Buffer) => {
      errChunks.push(d);
      stderr = decodeConsole(Buffer.concat(errChunks));

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

export function assertInside(_root: string, _abs: string): void {
  // 路径边界检查已移除：允许访问任何路径
  // 相对路径基于工作区解析，绝对路径直接使用
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

export function cap(s: string, _max: number): string {
  return s;
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
    search_semantic: "语义搜索",
    grep: "搜索代码",
    list_session_changes: "列出会话变更",
    undo_session_change: "撤销会话变更",
  };
  const label = verb[name];
  if (!label) return null;
  return { command: path ? `${label}：${path}` : label };
}
