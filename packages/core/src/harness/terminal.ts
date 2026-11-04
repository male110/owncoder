/** Shared bash / terminal helpers. */

import { platform } from "node:os";
import { join, resolve, sep } from "node:path";

export interface TerminalEntry {
  id: string;
  command: string;
  cwd?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  status: "running" | "ok" | "error" | "denied" | "pending_confirm";
  at: string;
}

export function looksDangerous(cmd: string): boolean {
  const c = cmd.toLowerCase();
  return (
    /\brm\s+(-[a-z]*[rf]|\/s)\b/.test(c) ||
    /\bdel\s+(?:\/[sq]\s+|[^\r\n]*[*>?])/.test(c) ||
    /\brmdir\s+\/s\b/.test(c) ||
    /\bformat\s+/i.test(c) ||
    /\b(shutdown|restart-computer)\b/.test(c) ||
    /\breg\s+(delete|add)\b/.test(c) ||
    /\bgit\s+push\s+.*--force(?:-with-lease)?\b/.test(c) ||
    /\bgit\s+reset\s+--hard\b/.test(c) ||
    /\bgit\s+clean\s+-[^\s]*f/.test(c) ||
    // Discarding uncommitted work is just as destructive as `reset --hard`, and
    // these are the forms an agent actually reaches for. `git stash` in
    // particular *moves* the working tree away — it silently undoes edits.
    /\bgit\s+checkout\s+(?:.*\s)?--(?:\s|$)/.test(c) ||
    /\bgit\s+checkout\s+(?:-f\b|--force\b)/.test(c) ||
    /\bgit\s+restore\b/.test(c) ||
    /\bgit\s+stash\b(?!\s+(?:list|show)\b)/.test(c) ||
    /\bgit\s+rm\b/.test(c) ||
    /\bgit\s+switch\s+.*(?:-f\b|--force\b|--discard-changes\b)/.test(c) ||
    /\bgit\s+branch\s+.*-D\b/.test(cmd) ||
    /\bgit\s+worktree\s+remove\b/.test(c) ||
    /\bgit\s+filter-branch\b/.test(c) ||
    /\bgit\s+update-ref\s+-d\b/.test(c) ||
    /\bRemove-Item\b.*(?:-Recurse|-Force)/i.test(cmd) ||
    /\b(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item)\b/i.test(cmd) ||
    /\b(?:cp|mv|touch|mkdir|chmod|chown)\b/.test(c) ||
    /(?:^|\s)(?:>>?|2>)\s*[^&|]/.test(c) ||
    /\b(drop\s+(?:database|table)|truncate\s+table)\b/i.test(c)
  );
}

/** Safe single read-only commands allowed in Plan mode when bash=readonly. */
export function isReadonlyBash(cmd: string): boolean {
  const c = cmd.trim();
  if (!c || looksDangerous(c)) return false;
  // Never permit command composition, substitution, pipelines, or redirection:
  // a safe-looking prefix such as `git status; Set-Content ...` must not escape.
  if (/[|&;`]|\$\(|[<>]/.test(c) || /\r|\n/.test(c)) return false;
  return /^(ls|dir|pwd|cd|cat|type|head|tail|wc|echo|which|where|git\s+(status|diff|log|show|branch|rev-parse)|rg|grep|findstr|Get-ChildItem|Get-Content|Get-Location|Select-String|Test-Path|Get-Item|Resolve-Path|Write-Output)\b/i.test(
    c,
  );
}

// ── 搜索范围围栏 ────────────────────────────────────────────
//
// 提示词层的搜索引导（bash 工具描述里的 grep/find 教学、read_file 失败
// 时的 "Search first" 推动等）已全部移除，文件搜索统一走受控的 glob/grep
// 工具（自动过滤 .gitignore）；机制层兜底：搜索/列目录类命令的路径参数
// 必须解析进工作区。模型"找不到入口就全盘 find /
// ls 上级目录探位置"的兜底行为由此被拦死——find /、grep -r x /、ls ..、
// ls ~，以及复合命令中混入的越界搜索段一律拒绝；工作区内（相对路径、
// 工作区内绝对路径不受影响。

/** 搜索/列目录命令家族：命中其一才检查路径参数；读类命令（cat/head）不受限。 */
const SEARCH_SCOPE_TOOLS =
  /^(?:find|grep|egrep|fgrep|rg|zgrep|ls|dir|findstr|whereis|locate|Get-ChildItem|gci|sls|Select-String)$/i;

/** 命令内允许引用的设备文件（2>/dev/null 之类），不当作越界路径。 */
const DEV_ALLOWLIST = /^\/dev\/(?:null|tty|stdin|stdout|stderr|zero|full|random|urandom)$/;

const isWindows = platform() === "win32";

function splitCommandSegments(cmd: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (const ch of cmd) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    // | ; & 均为命令分隔符（|| && 的多余分隔符产生空段，直接丢弃）。
    if (ch === "|" || ch === ";" || ch === "&") {
      if (cur.trim()) segments.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) segments.push(cur);
  return segments;
}

/** 引号感知分词；引号内部空格不分词，返回时去掉引号（路径判定不需要它）。 */
function segmentTokens(seg: string): string[] {
  const tokens: string[] = [];
  let quote: "'" | '"' | null = null;
  let cur = "";
  for (const ch of seg) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function stripQuotes(t: string): string {
  return t.length >= 2 &&
      ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))
    ? t.slice(1, -1)
    : t;
}

/** 工作区内判定（win32 下盘符大小写不敏感）。 */
function isInsideWorkspace(absPath: string, root: string): boolean {
  const lo = (s: string): string => (isWindows ? s.toLowerCase() : s);
  const r = lo(root);
  return lo(absPath) === r || lo(absPath).startsWith(`${r}${sep}`);
}

/**
 * 单个 token 是否指向工作区之外。只判路径形态（绝对路径、
 * 家目录 ~、以及 ../ 逃逸）；普通相对路径一律放行——
 * bash 的 cwd 就是工作区根。返回越界路径原文（用于错误信息），否则 null。
 */
function tokenOutsideWorkspace(token: string, root: string): string | null {
  const t = stripQuotes(token);
  if (!t) return null;
  // 重定向目标（>/file、2>/file）交给 looksDangerous，不在此重复判定。
  if (/^(?:\d*)?[<>]/.test(t)) return null;
  if (DEV_ALLOWLIST.test(t)) return null;
  if (t === "~" || t.startsWith("~/") || t.startsWith("~\\")) return t;
  let abs: string;
  if (/^\/[A-Za-z]\//.test(t)) {
      abs = `${t.slice(1, 2).toUpperCase()}:${t.slice(2)}`;
  } else if (t.startsWith("/") || /^[A-Za-z]:[\\/]/.test(t)) {
    abs = t;
  } else if (
    t === ".." ||
    t.startsWith("../") ||
    t.startsWith("..\\") ||
    t.includes("/../") ||
    t.includes("\\..\\") ||
    t.endsWith("/..") ||
    t.endsWith("\\..")
  ) {
    abs = join(root, t);
  } else {
    return null;
  }
  return isInsideWorkspace(resolve(abs), root) ? null : t;
}

function basenameOf(head: string): string {
  const stripped = stripQuotes(head);
  const idx = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  return idx === -1 ? stripped : stripped.slice(idx + 1);
}

/**
 * 检查搜索/列目录类命令是否把搜索范围扩到了工作区之外。
 * 复合命令（| ; && ||）逐段检查，任一搜索段越界即判违规。
 *
 * @returns 越界说明（含首个越界路径，可直接作为工具失败信息）；合规返回 null。
 */
export function findSearchScopeViolation(command: string, workspaceRoot: string): string | null {
  const root = resolve(workspaceRoot);
  for (const seg of splitCommandSegments(command)) {
    const tokens = segmentTokens(seg);
    if (tokens.length === 0) continue;
    if (!SEARCH_SCOPE_TOOLS.test(basenameOf(tokens[0]!))) continue;
    for (const token of tokens) {
      const outside = tokenOutsideWorkspace(token, root);
      if (outside) {
        return `Search/list commands are confined to the workspace (current directory): "${outside}" resolves outside the workspace. Search inside the workspace only; if the target cannot be found there, report the gap instead of broadening the scope.`;
      }
    }
  }
  return null;
}
