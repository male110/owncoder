import { promises as fs, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { extname, join } from "node:path";
import { redactSecrets, isRedactionEnabled } from "../redact.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { assertInside, escapeRegExp, fail, normalizeRel, ok, toAbs } from "./shared.ts";
import { closeLineReader, createGlobMatcher, GREP_MAX_FILE_BYTES, isSkipDirName, matchesFileType } from "./fs-shared.ts";

const GREP_BINARY_PROBE_BYTES = 8000;

const GREP_SKIP_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".7z",
  ".rar",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".wasm",
  ".mp3",
  ".mp4",
  ".webm",
  ".sqlite",
  ".db",
  ".pyc",
  ".class",
  ".o",
  ".obj",
  ".a",
  ".lockb",
]);

const GREP_SKIP_FILENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "cargo.lock",
  "poetry.lock",
  "composer.lock",
  "bun.lock",
  "bun.lockb",
  "go.sum",
  "gemfile.lock",
]);

export interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

function shouldSkipGrepFilename(name: string): boolean {
  const lower = name.toLowerCase();
  if (GREP_SKIP_FILENAMES.has(lower)) return true;
  if (lower.endsWith(".min.js") || lower.endsWith(".min.css") || lower.endsWith(".map")) return true;
  return GREP_SKIP_EXTS.has(extname(lower));
}

function gitignoreGlobToRegExp(pattern: string, anchored: boolean): RegExp | null {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  try {
    return anchored
      ? new RegExp(`^${out}(?:/.*)?$`)
      : new RegExp(`(?:^|/)${out}(?:/.*)?$`);
  } catch {
    return null;
  }
}

function compileIgnorePatterns(patternLines: readonly string[]): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of patternLines) {
    let line = rawLine.replace(/^\uFEFF/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    let p = line.trim();
    let negated = false;
    if (p.startsWith("!")) {
      negated = true;
      p = p.slice(1);
    }
    if (!p) continue;
    let dirOnly = false;
    if (p.endsWith("/")) {
      dirOnly = true;
      p = p.slice(0, -1);
    }
    const anchored = p.startsWith("/") || p.includes("/");
    if (p.startsWith("/")) p = p.slice(1);
    if (!p) continue;
    const regex = gitignoreGlobToRegExp(p, anchored);
    if (regex) rules.push({ negated, dirOnly, regex });
  }
  return rules;
}

export function pathIgnored(relPath: string, isDir: boolean, rules: readonly IgnoreRule[]): boolean {
  const path = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!path) return false;
  let ignored = false;
  for (const rule of rules) {
    if (!rule.regex.test(path)) continue;
    if (rule.dirOnly && !isDir && !path.includes("/")) continue;
    ignored = !rule.negated;
  }
  return ignored;
}

export async function loadWorkspaceIgnoreRules(
  root: string,
  extraIgnore: readonly string[],
): Promise<IgnoreRule[]> {
  const lines = [...extraIgnore];
  try {
    const text = await fs.readFile(join(root, ".gitignore"), "utf8");
    lines.push(...text.split(/\r?\n/));
  } catch {
    /* no root gitignore */
  }
  return compileIgnorePatterns(lines);
}

async function fileLooksBinary(abs: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    fh = await fs.open(abs, "r");
    const buf = Buffer.alloc(GREP_BINARY_PROBE_BYTES);
    const { bytesRead } = await fh.read(buf, 0, GREP_BINARY_PROBE_BYTES, 0);
    if (bytesRead <= 0) return false;
    const slice = buf.subarray(0, bytesRead);
    if (slice.includes(0)) return true;
    let weird = 0;
    for (const b of slice) {
      if (b < 9 || (b > 13 && b < 32) || b === 127) weird++;
    }
    return weird / bytesRead > 0.3;
  } catch {
    return true;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

export type GrepOutputMode = "content" | "files_with_matches" | "count";

/**
 * 检索可选项：glob / type 过滤、三种输出模式、上下文行、-n/-o/-i、
 * head_limit + offset 分页与 multiline 跨行匹配。
 * 所有字段可选；不传时保持原有默认行为（content、忽略大小写、命中即停）。
 */
export interface GrepOptions {
  // Glob include-filter，相对搜索目录解析，例如 `**` 下任意 .ts 或多后缀花括号写法。
  glob?: string;
  /** 文件类型过滤（rg --type），如 "ts"、"py"、"rust"。 */
  type?: string;
  /** 输出模式，默认 "content"。 */
  outputMode?: GrepOutputMode;
  /** 匹配行前的上下文行数（rg -B）。 */
  beforeContext?: number;
  /** 匹配行后的上下文行数（rg -A）。 */
  afterContext?: number;
  /** 双侧上下文行数（rg -C），-A/-B 未指定时回退到此值。 */
  context?: number;
  /** content 模式下显示行号（rg -n），默认 true。 */
  showLineNumbers?: boolean;
  /** 只输出匹配到的片段（rg -o），仅 content 模式生效。 */
  onlyMatching?: boolean;
  /** 忽略大小写，默认 true；传 false 走精确匹配。 */
  ignoreCase?: boolean;
  /** 返回上限（作用在输出条目上）；0 表示不限。默认沿用 maxResults。 */
  headLimit?: number;
  /** 跳过前 N 条结果再取 head_limit（分页）。 */
  offset?: number;
  /** 跨行模式："." 匹配换行、模式可跨行（rg -U，dotAll 语义）。 */
  multiline?: boolean;
}

/** 1-based 行号：统计匹配起点之前的 LF 数量（multiline 跨行匹配同样适用）。 */
function lineNumberForIndex(content: string, index: number): number {
  let lineNumber = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) lineNumber += 1;
  }
  return lineNumber;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? "";
}

export async function toolGrep(
  ctx: ToolContext,
  pattern: string,
  path: string,
  maxResults: number,
  options?: GrepOptions,
): Promise<ToolResult> {
  if (!pattern || !pattern.trim()) {
    return fail("grep requires a non-empty pattern");
  }
  const mode: GrepOutputMode = options?.outputMode ?? "content";
  if (mode !== "content" && mode !== "files_with_matches" && mode !== "count") {
    return fail(
      `grep 参数错误：output_mode 必须是 "content"、"files_with_matches" 或 "count"，当前为 "${String(options?.outputMode)}"。`,
    );
  }
  for (const [value, label] of [
    [options?.headLimit, "head_limit"],
    [options?.offset, "offset"],
  ] as const) {
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
      return fail(`grep 参数错误：${label} 必须是非负整数，不能使用字符串或负数。`);
    }
  }
  const ignoreCase = options?.ignoreCase ?? true;
  const multiline = options?.multiline ?? false;
  const flags = `${ignoreCase ? "i" : ""}${multiline ? "s" : ""}`;
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    re = new RegExp(escapeRegExp(pattern), flags);
  }
  let globMatcher: ((relativePath: string, fileName: string) => boolean) | undefined;
  if (options?.glob && options.glob.trim()) {
    try {
      globMatcher = createGlobMatcher(options.glob);
    } catch {
      return fail(`grep 参数错误：glob 模式 "${options.glob}" 无法编译为有效模式。`);
    }
  }
  const typeFilter = options?.type && options.type.trim() ? options.type.trim() : undefined;

  const root = toAbs(ctx.workspaceRoot, path);
  assertInside(ctx.workspaceRoot, root);
  // 用户显式指定的搜索起点：即使它本身（或其后代）命中 .gitignore/extraIgnore
  // 也不跳过——显式路径优先于忽略规则。node_modules/.git 等硬过滤仍生效。
  const explicitRootRel = normalizeRel(ctx.workspaceRoot, root);
  const isExplicitRoot = (rel: string): boolean =>
    rel === explicitRootRel || (explicitRootRel !== "" && rel.startsWith(`${explicitRootRel}/`));
  // limit bounds the returned entries; scans stop as soon as the cap is hit (0 = unlimited).
  const rawLimit = options?.headLimit ?? maxResults;
  const limit = rawLimit === 0 ? Number.POSITIVE_INFINITY : rawLimit > 0 ? Math.floor(rawLimit) : 40;
  const offset = options?.offset ?? 0;
  const showLineNumbers = options?.showLineNumbers ?? true;
  const onlyMatching = mode === "content" && (options?.onlyMatching ?? false);
  const beforeContext = Math.max(0, Math.floor(options?.beforeContext ?? options?.context ?? 0));
  const afterContext = Math.max(0, Math.floor(options?.afterContext ?? options?.context ?? 0));

  const hits: string[] = []; // content 模式的输出行（已过 offset）
  const matchedFiles: string[] = []; // 至少一处匹配的 rel 路径
  const countLines: string[] = []; // `${rel}:${匹配数}`
  let skipped = 0;
  let done = false;
  const redactEnabled = isRedactionEnabled(ctx.workflow);
  const redactedGrepFiles = new Set<string>();
  const ignoreRules = await loadWorkspaceIgnoreRules(
    ctx.workspaceRoot,
    ctx.workflow.index?.extraIgnore ?? [],
  );

  function reachedCap(): boolean {
    if (done) return true;
    if (mode === "content") {
      if (hits.length >= limit) {
        done = true;
        return true;
      }
    } else if (mode === "files_with_matches") {
      if (matchedFiles.length >= limit + offset) {
        done = true;
        return true;
      }
    }
    return false;
  }

  function passesFileFilters(abs: string, relToRoot: string, name: string): boolean {
    if (globMatcher && !globMatcher(relToRoot, name)) return false;
    if (typeFilter && !matchesFileType(abs, typeFilter)) return false;
    return true;
  }

  async function scanFile(file: string, rel: string): Promise<void> {
    if (reachedCap()) return;
    try {
      const st = await fs.stat(file);
      if (!st.isFile() || st.size > GREP_MAX_FILE_BYTES) return;
      const name = file.split(/[/\\]/).pop() ?? "";
      if (shouldSkipGrepFilename(name)) return;
      if (await fileLooksBinary(file)) return;

      let fileHadRedaction = false;
      let fileMatchCount = 0;

      const redacted = (text: string): string => {
        if (!redactEnabled) return text;
        const result = redactSecrets(text, rel, {
          sensitiveFiles: ctx.workflow.secrets?.sensitiveFiles,
          patterns: ctx.workflow.secrets?.patterns,
        });
        if (result.redacted) fileHadRedaction = true;
        return result.text;
      };
      const formatLine = (no: number, text: string): string =>
        showLineNumbers ? `${rel}:${no}:${text}` : `${rel}:${text}`;
      const pushOutput = (line: string): void => {
        if (mode !== "content") return;
        if (skipped < offset) {
          skipped += 1;
          return;
        }
        hits.push(line);
      };

      if (multiline) {
        const content = await fs.readFile(file, "utf8");
        const multilineRe = new RegExp(re.source, `g${ignoreCase ? "i" : ""}s`);
        for (const match of content.matchAll(multilineRe)) {
          const matchIndex = match.index ?? 0;
          const startLine = lineNumberForIndex(content, matchIndex);
          if (onlyMatching) {
            const parts = (match[0] ?? "").split(/\r?\n/);
            for (let i = 0; i < parts.length; i += 1) {
              const part = parts[i]!;
              if (part.length === 0) continue;
              pushOutput(formatLine(startLine + i, redacted(part)));
            }
          } else {
            pushOutput(formatLine(startLine, redacted(firstLine(match[0] ?? ""))));
          }
          fileMatchCount += 1;
          if (reachedCap()) break;
        }
      } else {
        const stream = createReadStream(file, { encoding: "utf8" });
        const input = createInterface({ input: stream, crlfDelay: Infinity });
        // 已输出过的行号：把相邻匹配的上下文窗口折叠去重
        const emitted = new Set<number>();
        const beforeBuffer: Array<{ no: number; text: string }> = [];
        let pendingAfter = 0;
        const onlyMatchingRe = onlyMatching ? new RegExp(re.source, `g${ignoreCase ? "i" : ""}`) : undefined;

        const emitContextLine = (no: number, text: string): void => {
          if (emitted.has(no)) return;
          emitted.add(no);
          pushOutput(formatLine(no, redacted(text)));
        };

        try {
          let lineNo = 0;
          for await (const line of input) {
            lineNo += 1;
            if (re.test(line)) {
              for (const before of beforeBuffer) emitContextLine(before.no, before.text);
              beforeBuffer.length = 0;
              if (onlyMatchingRe) {
                let hadAny = false;
                onlyMatchingRe.lastIndex = 0;
                for (const match of line.matchAll(onlyMatchingRe)) {
                  const text = match[0] ?? "";
                  if (text.length === 0) continue;
                  hadAny = true;
                  pushOutput(formatLine(lineNo, redacted(text)));
                }
                if (hadAny) fileMatchCount += 1;
                emitted.add(lineNo);
              } else {
                emitted.add(lineNo);
                pushOutput(formatLine(lineNo, redacted(line)));
                fileMatchCount += 1;
              }
              pendingAfter = afterContext;
            } else if (pendingAfter > 0) {
              emitContextLine(lineNo, line);
              pendingAfter -= 1;
            }

            if (mode === "content" && beforeContext > 0) {
              beforeBuffer.push({ no: lineNo, text: line });
              if (beforeBuffer.length > beforeContext) beforeBuffer.shift();
            }

            if (reachedCap()) break;
          }
        } finally {
          closeLineReader(input, stream);
        }
      }

      if (fileMatchCount > 0) {
        matchedFiles.push(rel);
        if (mode === "count") countLines.push(`${rel}:${fileMatchCount}`);
      }
      if (fileHadRedaction && !redactedGrepFiles.has(rel)) {
        redactedGrepFiles.add(rel);
        console.log(`[redact grep] ${rel}: grep 结果已脱敏`);
      }
    } catch {
      /* skip unreadable files */
    }
  }

  async function walk(dir: string): Promise<void> {
    if (reachedCap()) return;
    let st;
    try {
      st = await fs.stat(dir);
    } catch {
      return;
    }
    const rel = normalizeRel(ctx.workspaceRoot, dir);
    const exempt = isExplicitRoot(rel);
    if (st.isFile()) {
      if (!exempt && pathIgnored(rel, false, ignoreRules)) return;
      const name = dir.split(/[/\\]/).pop() ?? "";
      if (!passesFileFilters(dir, name, name)) return;
      await scanFile(dir, rel);
      return;
    }
    if (!st.isDirectory()) return;
    if (!exempt && rel && pathIgnored(rel, true, ignoreRules)) return;

    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (reachedCap()) return;
      if (isSkipDirName(it.name)) continue;
      const full = join(dir, it.name);
      const childRel = normalizeRel(ctx.workspaceRoot, full);
      const childExempt = isExplicitRoot(childRel);
      if (it.isDirectory()) {
        if (!childExempt && pathIgnored(childRel, true, ignoreRules)) continue;
        await walk(full);
      } else if (it.isFile()) {
        if (!childExempt && pathIgnored(childRel, false, ignoreRules)) continue;
        if (!passesFileFilters(full, normalizeRel(root, full), it.name)) continue;
        await scanFile(full, childRel);
      }
    }
  }

  await walk(root);

  if (mode === "files_with_matches") {
    const files = matchedFiles.slice(offset, offset + limit);
    if (files.length === 0) return ok("No files found");
    const truncated = matchedFiles.length - offset > files.length;
    const notice = truncated
      ? `\n[${files.length} files shown, result truncated — narrow file_path or raise maxResults/head_limit to see more]`
      : "";
    return ok(files.join("\n") + notice);
  }

  if (mode === "count") {
    const lines = countLines.slice(offset, offset + limit);
    if (lines.length === 0) return ok("No matches");
    const truncated = countLines.length - offset > lines.length;
    const notice = truncated
      ? `\n[${lines.length} files shown, result truncated — narrow file_path or raise maxResults/head_limit to see more]`
      : "";
    return ok(lines.join("\n") + notice);
  }

  if (hits.length === 0) return ok("No matches");
  const truncated = Number.isFinite(limit) && hits.length >= limit;
  const notice = truncated
    ? `\n[${hits.length} matches shown, result truncated — narrow file_path or raise maxResults to see more]`
    : "";
  return ok(hits.join("\n") + notice);
}
