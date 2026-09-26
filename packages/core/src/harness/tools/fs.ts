import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, extname, join } from "node:path";
import { isPlanPath, writePlanFile, extractTitle, classifyPlanKind } from "../../plans.ts";
import { getGitStatus } from "../../git.ts";
import { snapshotFileBeforeWrite } from "../checkpoint.ts";
import { applyUnifiedDiff } from "./unified-diff.ts";
import { resolvePatchTarget } from "./patch-target.ts";
import { applySearchReplace } from "./search-replace.ts";
import { isReadonlyBash, looksDangerous } from "../terminal.ts";
import { checkWritable } from "../writable.ts";
import { fromMarkdown } from "mdast-util-from-markdown";
import { redactSecrets, isRedactionEnabled } from "../redact.ts";
import { redactCommandReadOutput } from "../command-redaction.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import {
  assertInside,
  assertPlanMutationAllowed,
  cap,
  escapeRegExp,
  fail,
  formatWithLines,
  normalizeInputPath,
  normalizeRel,
  ok,
  runCommand,
  toAbs,
} from "./shared.ts";

import { saveExperience, type ExperienceRecord } from "../experience.ts";
import {
  saveSpec,
  saveDesign,
  listFeatures,
  getFeatureStatus,
  formatFeatureStatus,
} from "../../sdd.ts";
import { bugfixWorkflow, formatBugfixPlan } from "../bugfix.ts";

// ── Original Tools ─────────────────────────────────────────

export async function toolSavePlan(
  ctx: ToolContext,
  content: string,
  title: string,
  filename: string,
): Promise<ToolResult> {
  if (ctx.mode === "plan" && !ctx.workflow.modes.plan.allowPlanFiles) {
    return fail("Plan mode: plan file writes disabled in settings");
  }
  if (!content.trim()) return fail("save_plan requires non-empty content");
  // 硬护栏：文档交付物（PRD/TDD 等）不得写入 .owncoder/plans/，
  // 否则会被误标为可执行计划并显示"批准"按钮。应落到工作区根目录或 docs/。
  const planTitle = extractTitle(content, filename || title || "plan");
  if (classifyPlanKind(filename || title || "plan", planTitle) === "document") {
    return fail(
      "This content looks like a document deliverable (PRD/TDD/etc.), not an executable plan. " +
        "Save it with write_file to the workspace root or docs/ (e.g. PRD.md), not under .owncoder/plans/. " +
        "Use save_plan only for the final implementation plan.",
    );
  }
  const rel = await writePlanFile(ctx.workspaceRoot, content, {
    title: planTitle || undefined,
    filename: filename || undefined,
    sessionId: ctx.sessionId,
  });
  if (ctx.fileSnapshots) {
    if (!ctx.fileSnapshots.some((f) => f.path === rel)) {
      ctx.fileSnapshots.push({ path: rel, existed: false });
    }
  }
  ctx.touchedPaths?.push(rel);
  ctx.lastPlanPath = rel;
  ctx.readSet.add(rel);
  return okMutation(`Saved plan: ${rel}`, rel);
}


/** Whole-file reads (no offset/limit) are rejected at or above this size; call read_outline first. */
export const WHOLE_FILE_READ_BYTES = 10_000;
/** Alias for the whole-file size cap. */
export const LARGE_FILE_READ_BYTES = WHOLE_FILE_READ_BYTES;
/** Retained for compatibility with callers that import the historical budget constant. */
export const READ_FILE_OUTPUT_BUDGET = 256_000;
/** grep never materializes files larger than this (aligned with the index scanner). */
export const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const GREP_BINARY_PROBE_BYTES = 8000;
const GREP_MAX_RESULTS = 200;

/**
 * Named generated / vendor directories skipped by grep and recursive list_dir.
 * Any directory whose name starts with "." is also skipped (see isSkipDirName).
 */
export const SKIP_SCAN_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "__pycache__",
  "venv",
  "vendor",
  "third_party",
  "coverage",
]);

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

interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

function isSkipDirName(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (SKIP_SCAN_DIRS.has(name)) return true;
  return process.platform === "win32" && SKIP_SCAN_DIRS.has(name.toLowerCase());
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

function pathIgnored(relPath: string, isDir: boolean, rules: readonly IgnoreRule[]): boolean {
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

async function loadWorkspaceIgnoreRules(root: string, extraIgnore: readonly string[]): Promise<IgnoreRule[]> {
  const lines = [...extraIgnore];
  try {
    const text = await fs.readFile(join(root, ".gitignore"), "utf8");
    lines.push(...text.split(/\r?\n/));
  } catch {
    /* no root gitignore */
  }
  return compileIgnorePatterns(lines);
}

function closeLineReader(
  input: ReturnType<typeof createInterface>,
  stream: ReturnType<typeof createReadStream>,
): void {
  try {
    input.close();
  } catch {
    /* ignore */
  }
  stream.destroy();
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

async function readHeadLines(abs: string, count: number): Promise<string[]> {
  const stream = createReadStream(abs, { encoding: "utf8" });
  const input = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  try {
    for await (const line of input) {
      lines.push(line);
      if (lines.length >= count) break;
    }
  } finally {
    closeLineReader(input, stream);
  }
  return lines;
}

async function readSelectedLines(
  abs: string,
  wanted: ReadonlySet<number>,
  extraHead = 0,
): Promise<{ selected: Map<number, string>; head: string[] }> {
  const selected = new Map<number, string>();
  const head: string[] = [];
  const maxWanted = wanted.size > 0 ? Math.max(...wanted) : 0;
  const stopAt = Math.max(maxWanted, extraHead);
  if (stopAt <= 0) return { selected, head };
  const stream = createReadStream(abs, { encoding: "utf8" });
  const input = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let n = 0;
    for await (const line of input) {
      n++;
      if (n <= extraHead) head.push(line);
      if (wanted.has(n)) selected.set(n, line);
      if (n >= stopAt && selected.size >= wanted.size) break;
    }
  } finally {
    closeLineReader(input, stream);
  }
  return { selected, head };
}


function okMutation(output: string, ...paths: string[]): ToolResult {
  return {
    ok: true,
    output,
    metadata: { kind: "file_mutation", paths },
  };
}

function readRangeHeader(startLine: number, endLine: number, totalLines: number): string {
  const parts = [`[lines ${startLine}-${endLine} of ${totalLines}]`];
  if (endLine < totalLines) {
    parts.push(`file continues, call read_file with offset=${endLine + 1} to read more`);
  }
  return parts.join(" — ");
}

export async function toolRead(
  ctx: ToolContext,
  path: string,
  offset = 0,
  limit = 0,
): Promise<ToolResult> {
  const abs = toAbs(ctx.workspaceRoot, path);
  assertInside(ctx.workspaceRoot, abs);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  let text: string;
  let rangedTotalLines: number | undefined;
  try {
    stat = await fs.stat(abs);
    if (offset <= 0 || limit <= 0) {
      if (stat.size >= WHOLE_FILE_READ_BYTES) {
        const relForSize = normalizeRel(ctx.workspaceRoot, abs);
        return fail(
          `File "${relForSize}" is ${stat.size} bytes. Whole-file reads are limited to ${WHOLE_FILE_READ_BYTES} bytes. Call read_outline first, then decide which lines to read with read_symbol or read_file(offset, limit). Do not retry a whole-file read.`,
        );
      }
    }
    if (offset > 0 && limit > 0) {
      const startLine = Math.floor(offset);
      const endLine = startLine + Math.floor(limit) - 1;
      const lines: string[] = [];
      let lineNumber = 0;
      const input = createInterface({ input: createReadStream(abs, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of input) {
        lineNumber++;
        if (lineNumber >= startLine && lineNumber <= endLine) lines.push(line);
        if (lineNumber >= endLine) break;
      }
      input.close();
      text = lines.join("\n");
      rangedTotalLines = lineNumber + (lineNumber >= endLine ? 1 : 0);
    } else {
      text = await fs.readFile(abs, "utf8");
    }
  } catch (e: any) {
    if (e.code === "ENOENT") {
      const basename = path.split(/[/\\]/).pop() ?? path;
      return fail(
        `File not found: "${path}". ` +
        `Do NOT retry the same path — the file may be in a different location or named differently. ` +
        `Search for it first: use grep("${basename}") or search_symbols("${basename}") to locate the actual path, ` +
        `then read the confirmed path.`,
      );
    }
    if (e.code === "EISDIR") {
      return fail(`"${path}" is a directory, not a file. Use list_dir("${path}") to list its contents.`);
    }
    return fail(`Cannot read file "${path}": ${e.message}`);
  }
  const rel = normalizeRel(ctx.workspaceRoot, abs);
  ctx.readSet.add(rel);
  const allLines = text.split(/\r?\n/);
  const totalLines = rangedTotalLines ?? allLines.length;
  const normalizedOffset = Number.isFinite(offset) ? Math.floor(offset) : 0;
  const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 0;

  const startLine = normalizedOffset > 0 ? Math.min(normalizedOffset, totalLines) : 1;
  const requestedLimit = normalizedLimit > 0 ? normalizedLimit : totalLines;
  const requestedEndIdx = Math.min(startLine - 1 + requestedLimit, totalLines);
  const requestedLines = offset > 0 && limit > 0
    ? allLines.slice(0, Math.max(0, requestedEndIdx - startLine + 1))
    : allLines.slice(startLine - 1, requestedEndIdx);

  // Redact the requested lines so masks never leak. Redaction normally
  // preserves line count; retain a line-safe fallback for custom patterns
  // that happen to span newlines.
  let outputLines = requestedLines;
  if (isRedactionEnabled(ctx.workflow)) {
    const result = redactSecrets(requestedLines.join("\n"), rel, {
      sensitiveFiles: ctx.workflow.secrets?.sensitiveFiles,
      patterns: ctx.workflow.secrets?.patterns,
    });
    outputLines = result.text.split("\n");
    if (outputLines.length !== requestedLines.length) {
      outputLines = requestedLines.map((line) =>
        redactSecrets(line, rel, {
          sensitiveFiles: ctx.workflow.secrets?.sensitiveFiles,
          patterns: ctx.workflow.secrets?.patterns,
        }).text,
      );
    }
    if (result.redacted) {
      console.log(`[redact] ${rel}: ${result.reasons.join(", ")}`);
      // 输出脱敏后的完整内容，方便调试
      for (const line of outputLines) {
        console.log(`[redact]   ${line}`);
      }
    }
  }

  // The whole requested range is rendered directly — reads are bounded by
  // lines, never split by a character budget. The egress cap (execute.ts)
  // truncates only truly oversized outputs, with a visible marker.
  const endLine = requestedEndIdx;
  const hasMore = endLine < totalLines;

  return {
    ok: true,
    output: `${readRangeHeader(startLine, endLine, totalLines)}\n${outputLines
      .map((line, i) => formatWithLines(line, startLine + i))
      .join("\n")}`,
    metadata: {
      kind: "read_file",
      contentHash: `${stat.size}:${stat.mtimeMs}`,
      path: rel,
      startLine,
      endLine,
      totalLines,
      hasMore,
      nextOffset: hasMore ? endLine + 1 : undefined,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      evidenceKind: "source",
    },
  };
}

/**
 * Read a bounded current-source window around a unique index symbol. Index
 * metadata only locates the window; the actual file read is delegated to
 * `toolRead` so path containment, redaction, line-range semantics, output
 * caps, hashes, and read evidence remain exactly the same as an explicit
 * read_file call.
 */
export async function toolReadSymbol(
  ctx: ToolContext,
  path: string,
  symbol: string,
  padding = 12,
): Promise<ToolResult> {
  const requestedSymbol = symbol.trim();
  if (!requestedSymbol) return fail("read_symbol requires a non-empty symbol name");

  const normalizedPath = normalizeInputPath(path);
  const abs = toAbs(ctx.workspaceRoot, normalizedPath);
  assertInside(ctx.workspaceRoot, abs);
  const rel = normalizeRel(ctx.workspaceRoot, abs);

  let tags: Awaited<ReturnType<typeof ctx.index.getTags>>;
  try {
    tags = await ctx.index.getTags(rel);
  } catch (error) {
    // Index query failure is not fatal — LLM can still fall back to read_file/grep.
    return ok(
      `Cannot query the symbol index for \"${rel}\": ${error instanceof Error ? error.message : String(error)}. ` +
        "Continue with read_file or grep; do not treat this as a fatal error.",
    );
  }

  const matches = tags.filter((tag) => tag.name === requestedSymbol);
  if (matches.length === 0) {
    // Soft miss: missing index entry must not stop the agent loop.
    return ok(
      `Symbol \"${requestedSymbol}\" was not found in the current index for \"${rel}\". ` +
        "Continue with read_file, grep, or search_symbols to locate the current source; do not treat this as a fatal error.",
    );
  }
  if (matches.length > 1) {
    const locations = matches
      .slice(0, 8)
      .map((tag) => `${tag.kind} at line ${tag.line}`)
      .join(", ");
    return ok(
      `Symbol \"${requestedSymbol}\" is ambiguous in \"${rel}\" (${locations}). ` +
        "Continue with read_file or choose a unique symbol name; do not treat this as a fatal error.",
    );
  }

  const target = matches[0]!;
  const paddingLines = Number.isFinite(padding)
    ? Math.max(0, Math.min(80, Math.floor(padding)))
    : 12;
  const nextTagLine = tags
    .filter((tag) => tag.line > target.line)
    .reduce<number | undefined>((nearest, tag) =>
      nearest === undefined || tag.line < nearest ? tag.line : nearest,
    undefined);
  // Some language extractors do not yet report endLine. Limit their inferred
  // window instead of treating an index hit as permission to read a whole file.
  const inferredEndLine = nextTagLine
    ? Math.max(target.line, nextTagLine - 1)
    : target.line + 319;
  const symbolEndLine = Math.max(target.line, target.endLine ?? inferredEndLine);
  const startLine = Math.max(1, target.line - paddingLines);
  const endLine = symbolEndLine + paddingLines;

  const result = await toolRead(ctx, rel, startLine, endLine - startLine + 1);
  if (result.ok && result.metadata?.kind === "read_file") {
    result.metadata.symbol = requestedSymbol;
  }
  return result;
}

/**
 * Code-ish extensions whose files benefit from a symbol outline.
 * Data/docs (json/yaml/md) have no extractable structure, so outline falls back
 * to head lines for them - see toolReadOutline.
 */
const OUTLINE_SOURCE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rs", "go", "java", "kt", "rb",
  "c", "h", "cpp", "hpp", "cc", "cs", "swift", "php",
]);

/**
 * Extract the leading signature line of a symbol: from its declaration line,
 * strip the body (`{`/`:` onwards) and normalize indentation so the outline
 * stays one line per symbol.
 */
function signatureOf(line: string): string {
  const stripped = line.replace(/\t/g, "  ");
  const indent = stripped.match(/^\s*/)?.[0]?.length ?? 0;
  const flat = stripped.trim();
  if (!flat) return "";
  const indentMark = indent === 0 ? "" : `  ${".".repeat(Math.min(4, Math.ceil(indent / 2)))}`;
  const cut =
    flat.indexOf("{") >= 0
      ? flat.slice(0, Math.max(flat.indexOf("{"), flat.lastIndexOf(")") + 1))
      : flat.indexOf(":") >= 0 && !flat.startsWith("case ") && !flat.startsWith("label ")
        ? flat.slice(0, flat.indexOf(":"))
        : flat;
  const sig = cut.replace(/\s+$/, "");
  return `${indentMark}${sig || flat}`;
}

/**
 * Outline (skeleton) read - the LeanCTX "map/signatures" mode for a single file.
 *
 * Uses the native symbol index (same source read_symbol/graph_search use) to
 * return kind + name + line range + signature line for every symbol, instead of
 * the full text. The model can then drill into a specific symbol with
 * read_symbol, or fall back to read_file when it truly needs full text.
 *
 * Output shape:
 *   file: src/foo.ts (214 lines, 18 symbols) - outline
 *   L  12-  48 fn   createUser
 *   L  55-  55 fn   validateToken
 *   ...
 *   imports: node:crypto, ./shared.ts
 *   [use read_symbol(path, symbol) for a body; read_file for full text]
 */
export async function toolReadOutline(
  ctx: ToolContext,
  path: string,
): Promise<ToolResult> {
  const normalizedPath = normalizeInputPath(path);
  const abs = toAbs(ctx.workspaceRoot, normalizedPath);
  assertInside(ctx.workspaceRoot, abs);
  const rel = normalizeRel(ctx.workspaceRoot, abs);

  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(abs);
  } catch (e: any) {
    if (e.code === "ENOENT") {
      return fail(
        `File not found: "${path}". Use search_symbols or grep to locate the actual path, then read the outline of the confirmed path.`,
      );
    }
    if (e.code === "EISDIR") {
      return fail(`"${path}" is a directory, not a file. Use list_dir("${path}") to list its contents.`);
    }
    return fail(`Cannot read file "${path}": ${e.message}`);
  }
  if (stat.isDirectory()) {
    return fail(`"${path}" is a directory, not a file. Use list_dir("${path}") to list its contents.`);
  }

  ctx.readSet.add(rel);
  const large = stat.size >= WHOLE_FILE_READ_BYTES;
  const sizeHint = `${stat.size} bytes`;

  if (!OUTLINE_SOURCE_EXTS.has(ext)) {
    const head = await readHeadLines(abs, 60);
    const header = `file: ${rel} (${sizeHint}, no symbol outline for .${ext}) - head lines\n`;
    const body = formatWithLines(head.join("\n"), 1);
    const next = large
      ? `[large file: use read_file("${rel}", offset, limit) for a bounded range]`
      : `[full text: read_file("${rel}")]`;
    return {
      ok: true,
      output: `${header}${body}\n${next}`,
      metadata: {
        kind: "read_outline",
        path: rel,
        startLine: 1,
        endLine: Math.max(1, head.length),
        totalLines: Math.max(1, head.length),
        hasMore: false,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        contentHash: `${stat.size}:${stat.mtimeMs}`,
        outline: true,
        evidenceKind: "navigation",
      },
    };
  }

  let tags: Awaited<ReturnType<typeof ctx.index.getTags>>;
  try {
    tags = await ctx.index.getTags(rel);
  } catch (error) {
    return fail(
      `Cannot query the symbol index for "${rel}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (tags.length === 0) {
    const head = await readHeadLines(abs, 60);
    const header = `file: ${rel} (${sizeHint}, 0 symbols indexed) - head lines\n`;
    const body = formatWithLines(head.join("\n"), 1);
    const next = large
      ? `[no symbols in index; large file — use read_file("${rel}", offset, limit)]`
      : `[no symbols in index; use read_file for full text]`;
    return {
      ok: true,
      output: `${header}${body}\n${next}`,
      metadata: {
        kind: "read_outline",
        path: rel,
        startLine: 1,
        endLine: Math.max(1, head.length),
        totalLines: Math.max(1, head.length),
        hasMore: false,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        contentHash: `${stat.size}:${stat.mtimeMs}`,
        outline: true,
        evidenceKind: "navigation",
      },
    };
  }

  const sorted = [...tags].sort((a, b) => a.line - b.line);
  const wanted = new Set(sorted.map((tag) => tag.line).filter((line) => line > 0));
  const { selected } = await readSelectedLines(abs, wanted, 0);

  const kindTag: Record<string, string> = {
    function: "fn",
    class: "cls",
    type: "type",
    struct: "struct",
    enum: "enum",
    trait: "trait",
    interface: "iface",
    method: "fn",
    module: "mod",
  };
  const short = (k: string) => kindTag[k] ?? k;

  const bodyLines: string[] = [];
  const redactEnabled = isRedactionEnabled(ctx.workflow);
  for (const tag of sorted) {
    let declLine = (selected.get(tag.line) ?? "").trimEnd();
    if (redactEnabled) {
      declLine = redactSecrets(declLine, rel, {
        sensitiveFiles: ctx.workflow.secrets?.sensitiveFiles,
        patterns: ctx.workflow.secrets?.patterns,
      }).text;
    }
    const sig = signatureOf(declLine);
    const end = tag.endLine ?? tag.line;
    const range = tag.endLine ? `${String(tag.line).padStart(5)}-${String(end).padStart(5)}` : String(tag.line).padStart(5);
    bodyLines.push(`L ${range} ${short(tag.kind).padEnd(6)} ${sig || tag.name}`);
  }

  const parts: string[] = [
    `file: ${rel} (${sizeHint}, ${sorted.length} symbols) - outline`,
    ...bodyLines,
  ];
  parts.push(`[drill into a symbol: read_symbol("${rel}", name); ranged text: read_file("${rel}", offset, limit)]`);

  return {
    ok: true,
    output: parts.join("\n"),
    metadata: {
      kind: "read_outline",
      path: rel,
      startLine: sorted.length > 0 ? sorted[0]!.line : 1,
      endLine: Math.max(1, sorted[sorted.length - 1]?.endLine ?? sorted[sorted.length - 1]?.line ?? 1),
      totalLines: Math.max(1, sorted[sorted.length - 1]?.endLine ?? sorted[sorted.length - 1]?.line ?? 1),
      hasMore: false,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      contentHash: `${stat.size}:${stat.mtimeMs}`,
      outline: true,
      evidenceKind: "navigation",
    },
  };
}

export async function toolList(ctx: ToolContext, path: string, recursive: boolean): Promise<ToolResult> {
  path = normalizeInputPath(path);
  const abs = toAbs(ctx.workspaceRoot, path);
  assertInside(ctx.workspaceRoot, abs);
  const entries: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const it of items) {
      if (isSkipDirName(it.name)) continue;
      const full = join(dir, it.name);
      const rel = normalizeRel(ctx.workspaceRoot, full);
      entries.push(it.isDirectory() ? `${rel}/` : rel);
      if (recursive && it.isDirectory() && depth < 3) await walk(full, depth + 1);
      if (entries.length >= 200) return;
    }
  }
  try {
    await walk(abs, 0);
  } catch (e: any) {
    if (e.code === "ENOENT") {
      return fail(
        `Directory not found: "${path}". Use list_dir(".") to see the workspace root, or check the spelling.`,
      );
    }
    if (e.code === "ENOTDIR") {
      return fail(`"${path}" is not a directory. Use read_file("${path}") to read it as a file.`);
    }
    return fail(`Cannot list directory "${path}": ${e.message}`);
  }
  return ok(cap(entries.join("\n") || "(empty)", ctx.maxOutputChars));
}

export async function toolGrep(
  ctx: ToolContext,
  pattern: string,
  path: string,
  maxResults: number,
): Promise<ToolResult> {
  if (!pattern || !pattern.trim()) {
    return fail("grep requires a non-empty pattern");
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(escapeRegExp(pattern), "i");
  }
  const root = toAbs(ctx.workspaceRoot, path);
  assertInside(ctx.workspaceRoot, root);
  const limit = Math.min(
    Math.max(Number.isFinite(maxResults) ? Math.floor(maxResults) : 40, 1),
    GREP_MAX_RESULTS,
  );
  const hits: string[] = [];
  const redactEnabled = isRedactionEnabled(ctx.workflow);
  const redactedGrepFiles = new Set<string>();
  const ignoreRules = await loadWorkspaceIgnoreRules(
    ctx.workspaceRoot,
    ctx.workflow.index?.extraIgnore ?? [],
  );

  async function scanFile(file: string): Promise<void> {
    if (hits.length >= limit) return;
    try {
      const st = await fs.stat(file);
      if (!st.isFile() || st.size > GREP_MAX_FILE_BYTES) return;
      const name = file.split(/[/\\]/).pop() ?? "";
      if (shouldSkipGrepFilename(name)) return;
      if (await fileLooksBinary(file)) return;

      const rel = normalizeRel(ctx.workspaceRoot, file);
      const stream = createReadStream(file, { encoding: "utf8" });
      const input = createInterface({ input: stream, crlfDelay: Infinity });
      let fileHadRedaction = false;
      let lineNo = 0;
      try {
        for await (const line of input) {
          lineNo++;
          if (!re.test(line)) continue;
          let lineContent = line.slice(0, 200);
          if (redactEnabled) {
            const result = redactSecrets(lineContent, rel, {
              sensitiveFiles: ctx.workflow.secrets?.sensitiveFiles,
              patterns: ctx.workflow.secrets?.patterns,
            });
            if (result.redacted) fileHadRedaction = true;
            lineContent = result.text;
          }
          hits.push(`${rel}:${lineNo}:${lineContent}`);
          if (hits.length >= limit) break;
        }
      } finally {
        closeLineReader(input, stream);
      }
      if (fileHadRedaction && !redactedGrepFiles.has(rel)) {
        redactedGrepFiles.add(rel);
        console.log(`[redact grep] ${rel}: grep 结果已脱敏`);
      }
    } catch {
      /* skip unreadable files */
    }
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (hits.length >= limit) return;
    let st;
    try {
      st = await fs.stat(dir);
    } catch {
      return;
    }
    const rel = normalizeRel(ctx.workspaceRoot, dir);
    if (st.isFile()) {
      if (!pathIgnored(rel, false, ignoreRules)) await scanFile(dir);
      return;
    }
    if (!st.isDirectory()) return;
    if (rel && pathIgnored(rel, true, ignoreRules)) return;

    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (hits.length >= limit) return;
      if (isSkipDirName(it.name)) continue;
      const full = join(dir, it.name);
      const childRel = normalizeRel(ctx.workspaceRoot, full);
      if (it.isDirectory()) {
        if (pathIgnored(childRel, true, ignoreRules)) continue;
        if (depth < 6) await walk(full, depth + 1);
      } else if (it.isFile()) {
        if (pathIgnored(childRel, false, ignoreRules)) continue;
        await scanFile(full);
      }
    }
  }

  await walk(root, 0);
  return ok(cap(hits.join("\n") || "No matches", ctx.maxOutputChars));
}

export async function toolRepoMap(ctx: ToolContext, hint: string): Promise<ToolResult> {
  const map = await ctx.index.buildRepoMap({
    mapTokens: ctx.workflow.context.mapTokens,
    mentionedPaths: hint ? [hint] : [],
  });
  return ok(cap(map || "(empty map)", ctx.maxOutputChars));
}

export async function toolSearchSymbols(
  ctx: ToolContext,
  query: string,
  limit: number,
): Promise<ToolResult> {
  if (!query.trim()) return fail("search_symbols requires a non-empty query");
  if (!ctx.index.ftsSearch) return fail("FTS5 symbol search not available");
  
  const results = await ctx.index.ftsSearch(query, { limit: Math.min(Math.max(limit, 1), 50) });
  if (!results.length) return ok(`No symbols matching "${query}" found`);
  
  const lines: string[] = [`## Symbol Search: "${query}"`, `Found ${results.length} symbols`, ""];
  for (const r of results) {
    const sig = r.signature ? `: ${r.signature}` : "";
    lines.push(`- **${r.kind}** \`${r.name}\`${sig}`);
    lines.push(`  ${r.path}:${r.line}`);
    if (r.doc) {
      const docPreview = r.doc.slice(0, 100).replace(/\n/g, " ");
      lines.push(`  ${docPreview}${r.doc.length > 100 ? "..." : ""}`);
    }
  }
  return ok(cap(lines.join("\n"), ctx.maxOutputChars));
}

interface ResolvedPath {
  path: string;
}

interface PathResolutionError {
  error: string;
}

/**
 * When path is missing/empty, provide a clear error message.
 * 
 * Previously this function would auto-infer the path from readSet when only
 * one file was read, but this was dangerous — it could accidentally overwrite
 * the wrong file (e.g., writing Design.md but overwriting PRD.md because PRD
 * was the only file in readSet).
 * 
 * Now we always require an explicit path parameter for safety.
 */
function resolvePathFromReadSet(
  readSet: Set<string>,
  toolName: string,
): ResolvedPath | PathResolutionError {
  const candidates = [...readSet];
  
  const hint =
    candidates.length > 1
      ? ` Multiple files were read: ${JSON.stringify(candidates.slice(0, 5))}${candidates.length > 5 ? '...' : ''}`
      : candidates.length === 1
      ? ` One file was read (${candidates[0]}), but auto-using it is unsafe — you must specify the target path explicitly.`
      : ` No file was read first.`;
  
  return {
    error: 
      `${toolName} requires an explicit "path" parameter. The path field is missing or empty.${hint}\n\n` +
      `This typically happens when:\n` +
      `1. Content is too large and JSON payload was truncated (less likely now with 16K max_tokens)\n` +
      `2. The path parameter was accidentally omitted\n\n` +
      `Solutions:\n` +
      `- Always include the "path" parameter explicitly in the tool call\n` +
      `- For very large files: use write_file for first part (<60KB), then append_file for rest\n` +
      `- If you intended to write to a recently-read file, specify its path explicitly`,
  };
}

export async function toolPatch(ctx: ToolContext, path: string, patch: string): Promise<ToolResult> {
  const target = resolvePatchTarget(path, patch);
  if ("error" in target) return fail(target.error);
  path = target.path;
  const check = checkWritable(ctx.workspaceRoot, path, ctx.workflow.context.writePolicy);
  if (!check.ok) return fail(check.reason ?? "not writable");
  const planBlock = assertPlanMutationAllowed(ctx, check.relPath);
  if (planBlock) return planBlock;
  const abs = toAbs(ctx.workspaceRoot, check.relPath);
  const rel = check.relPath;
  let original = "";
  let fileExists = false;
  try {
    original = await fs.readFile(abs, "utf8");
    fileExists = true;
    // Transparent recovery: if the model forgot to read first, the successful
    // read satisfies the read-before-write guard without burning a turn.
    if (!ctx.readSet.has(rel)) {
      ctx.readSet.add(rel);
      ctx.onEvent?.({ type: "tool_auto_read", path: rel, tool: "apply_patch" });
      console.log(`[auto-read] satisfied read-before-write for apply_patch on ${rel}`);
    }
  } catch (e: any) {
    // File doesn't exist - unified diff can't work on non-existent files
    if (!ctx.readSet.has(rel)) {
      return fail(
        `File "${rel}" does not exist. Use write_file to create new files, not apply_patch.`
      );
    }
    fileExists = false;
  }

  // For non-existent files, suggest write_file
  if (!fileExists) {
    return fail(
      `File "${rel}" does not exist. Use write_file to create new files, not apply_patch.`
    );
  }

  // Smart format detection with fallback chain (Aider-style).
  // Strategy: try the most specific format first, fall back gracefully,
  // and always attempt both major formats before giving up.
  
  // Line-level marker detection (stricter than substring includes to avoid
  // false positives when markers appear inside code/comments).
  const looksLikeSearchReplace = /^<{3,}\s*SEARCH/mi.test(patch);
  const looksLikeUnifiedDiff = /(?:^|\n)diff\s|^---\s[ab]/m.test(patch) ||
    (patch.includes('---') && patch.includes('+++') && patch.includes('@@'));
  
  // Both applySearchReplace and applyUnifiedDiff return objects with the same
  // core fields (success, content, error). Use a structural type to allow both.
  let editResult: { success: boolean; content?: string; error?: string; replacements?: number } | undefined;
  
  // 1. Try SEARCH/REPLACE format (most reliable for AI)
  if (looksLikeSearchReplace) {
    editResult = applySearchReplace(original, patch);
    // If parsing found 0 blocks despite detecting markers, the markers may
    // have been inside code content — fall through to try unified diff.
    if (!editResult.success && editResult.replacements === 0 &&
        editResult.error?.includes("No SEARCH/REPLACE blocks")) {
      editResult = undefined; // reset to try next format
    }
  }
  
  // 2. Try Unified Diff format (also try if SEARCH/REPLACE failed above)
  if (!editResult && looksLikeUnifiedDiff) {
    editResult = applyUnifiedDiff(original, patch);
  }
  
  // 3. Blind attempt: if neither format was detected by heuristics, try both
  //    anyway — models sometimes produce valid patches that don't match our
  //    quick-detection regexes (e.g. non-standard marker counts).
  if (!editResult) {
    const srResult = applySearchReplace(original, patch);
    if (srResult.success) {
      editResult = srResult;
    } else {
      const udResult = applyUnifiedDiff(original, patch);
      if (udResult.success) {
        editResult = udResult;
      } else {
        // Both formats failed — give the most informative combined error
        return fail(
          "Could not apply patch in any supported format.\n\n" +
          "Attempted SEARCH/REPLACE: " + (srResult.error ?? "no blocks found") + "\n\n" +
          "Attempted Unified Diff: " + (udResult.error ?? "parse failed") + "\n\n" +
          "Expected format:\n" +
          "<<<<<<< SEARCH\n" +
          "exact text from file\n" +
          "=======\n" +
          "replacement text\n" +
          ">>>>>>> REPLACE\n\n" +
          "For new files or complete rewrites, use write_file instead."
        );
      }
    }
  }

  if (!editResult || !editResult.success || editResult.content === undefined) {
    return fail(editResult?.error ?? "patch failed");
  }

  // Snapshot and write
  if (ctx.fileSnapshots) {
    await snapshotFileBeforeWrite(ctx.workspaceRoot, rel, ctx.fileSnapshots);
  }
  await fs.writeFile(abs, editResult.content, "utf8");
  ctx.touchedPaths?.push(rel);
  if (isPlanPath(rel)) ctx.lastPlanPath = rel;
  ctx.index.invalidate(rel);
  void ctx.index.ragUpdate?.(ctx.workspaceRoot, [], [rel], []);
  
  // Track edit in memory
  if (ctx.memory) {
    ctx.memory.addEdit(rel, "apply_patch", original.slice(0, 100), editResult.content.slice(0, 100));
    ctx.memory.updateHotspot(rel, true, false);
  }
  
  // Simple success message
  const changes = 'replacements' in editResult ? editResult.replacements : 'applied';
  const successMsg = `Patched ${rel} (${changes} changes)`;
  
  return okMutation(successMsg, rel);
}

/**
 * Below this size a "shrink" is not worth guarding — tiny config/stub files get
 * legitimately rewritten to a fraction of their size all the time.
 */
const SHRINK_GUARD_MIN_BYTES = 400;
/** Overwriting an existing file with less than this share of its content needs opt-in. */
const SHRINK_GUARD_RATIO = 0.5;

export async function toolWrite(
  ctx: ToolContext,
  path: string,
  content: string,
  allowShrink = false,
): Promise<ToolResult> {
  // Reject empty/falsy paths — they produce a nonsensical relative path and
  // an unhelpful "read-before-write: call read_file on """ error downstream.
  if (!path || !path.trim()) {
    const resolved = resolvePathFromReadSet(ctx.readSet, "write_file");
    if ("error" in resolved) return fail(resolved.error);
    path = resolved.path;
  }
  if (!content) {
    return fail("write_file requires non-empty content; got an empty string. Pass the full file text in `content`. If you intended to clear the file, use apply_patch with an empty REPLACE block instead.");
  }
  path = normalizeInputPath(path);
  const check = checkWritable(ctx.workspaceRoot, path, ctx.workflow.context.writePolicy);
  if (!check.ok) return fail(check.reason ?? "not writable");
  const planBlock = assertPlanMutationAllowed(ctx, check.relPath);
  if (planBlock) return planBlock;
  // 硬护栏：plan 模式下，文档交付物（PRD/TDD 等）不得写入 .owncoder/plans/，
  // 否则会被误标为可执行计划并显示"批准"按钮。应落到工作区根目录或 docs/。
  if (ctx.mode === "plan" && isPlanPath(check.relPath) && check.relPath.toLowerCase().endsWith(".md")) {
    const fname = check.relPath.split(/[/\\]/).pop() ?? "doc";
    const docTitle = extractTitle(content, fname);
    if (classifyPlanKind(fname, docTitle) === "document") {
      return fail(
        "This content looks like a document deliverable (PRD/TDD/etc.), not an executable plan. " +
          "Write it to the workspace root or docs/ (e.g. PRD.md), not under .owncoder/plans/. " +
          "Use save_plan only for the final implementation plan.",
      );
    }
  }
  const abs = toAbs(ctx.workspaceRoot, check.relPath);
  const rel = check.relPath;

  // Read the current file (when present) so we can both report accurately and
  // refuse a suspicious shrink below.
  let existing: string | null = null;
  try {
    existing = await fs.readFile(abs, "utf8");
  } catch {
    existing = null;
  }
  const exists = existing !== null;

  // Defense in depth against silent data loss: write_file replaces the ENTIRE
  // file, so a model that emits only the first half of a long file (without the
  // JSON payload itself being truncated, which parser.ts catches separately)
  // would wipe the rest and still get a success result. Make that case opt-in.
  const isLargeShrink =
    exists &&
    existing!.length >= SHRINK_GUARD_MIN_BYTES &&
    content.length < existing!.length * SHRINK_GUARD_RATIO;

  if (isLargeShrink) {
    const pct = Math.round((content.length / existing!.length) * 100);
    const scale = `${existing!.length} → ${content.length} chars (${pct}% of the original)`;
    if (!allowShrink) {
      return fail(
        `write_file would shrink ${rel}: ${scale} — refusing, because write_file replaces the whole file and this looks like truncated or incomplete content.\n\n` +
          `If you only meant to change part of the file, use apply_patch instead.\n` +
          `If the file really should become this much smaller, repeat the call with "allow_shrink": true.`,
      );
    }
    // `allow_shrink` is supplied by the model, so on its own it is only an
    // assertion — and write_file has no read-before-write guard of its own,
    // meaning the model could be confirming the deletion of content it has
    // never seen. Require evidence for this one destructive case: the file must
    // have been read (or written) in this session.
    if (!ctx.readSet.has(rel)) {
      return fail(
        `write_file with "allow_shrink": true would drop most of ${rel} (${scale}), but that file has not been read in this session — so this call cannot know what it is deleting.\n\n` +
          `Call read_file on ${rel} first, then either use apply_patch for a partial edit, or repeat write_file with the complete intended content.`,
      );
    }
    // Bypass accepted. The shrink is already noted in the tool result message,
    // so we don't emit a separate warning event here.
    console.log(`[write_file] large shrink accepted for ${rel}: ${scale}`);
  }

  // Create snapshot before writing
  if (ctx.fileSnapshots) {
    await snapshotFileBeforeWrite(ctx.workspaceRoot, rel, ctx.fileSnapshots);
  }
  
  // Write file directly - no length limits, no patchFirst conversion
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  
  // Update tracking
  ctx.readSet.add(rel);
  ctx.touchedPaths?.push(rel);
  if (isPlanPath(rel)) ctx.lastPlanPath = rel;
  ctx.index.invalidate(rel);
  void ctx.index.ragUpdate?.(ctx.workspaceRoot, [], [rel], []);
  
  if (ctx.memory) {
    ctx.memory.addEdit(rel, "write_file", exists ? "(existing)" : "(new)", content.slice(0, 100));
    ctx.memory.updateHotspot(rel, true, false);
  }
  
  // Keep the shrink in the tool output too, so it stays on the record the model
  // and the user both read back.
  const shrinkNote = isLargeShrink
    ? ` - shrank from ${existing!.length} chars via allow_shrink`
    : "";
  return okMutation(
    `Wrote ${rel} (${content.length} chars)${exists ? " - overwritten" : " - created"}${shrinkNote}`,
    rel,
  );
}

export async function toolGitStatus(ctx: ToolContext): Promise<ToolResult> {
  const st = await getGitStatus(ctx.workspaceRoot);
  if (!st.isRepo) return ok("Not a git repository.");
  return ok(
    [
      `branch: ${st.branch}`,
      `dirty: ${st.dirty}`,
      `staged: ${st.staged}`,
      `unstaged: ${st.unstaged}`,
      `untracked: ${st.untracked}`,
      `ahead: ${st.ahead}`,
      `behind: ${st.behind}`,
      `summary: ${st.summary}`,
    ].join("\n"),
  );
}

/**
 * Return the project's declared dependencies across ecosystems (npm, cargo,
 * python, go, maven, gradle, nuget, etc.). Parses root-level manifests
 * best-effort. Returns an empty string when no recognizable manifest is found.
 */
export async function toolProjectDeps(ctx: ToolContext): Promise<ToolResult> {
  const { buildProjectDeps } = await import("../loop/context.js");
  const deps = await buildProjectDeps(ctx.workspaceRoot);
  if (!deps.trim()) {
    return ok(
      "No dependency manifests found in the workspace root. " +
        "If you need dependency information, read the relevant manifest files directly " +
        "(e.g. package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml, build.gradle, etc.).",
    );
  }
  return ok(deps);
}

export async function toolSaveExperience(
  ctx: ToolContext,
  symptom: string,
  rootCause: string,
  fix: string,
  files: string[],
  tags: string[],
): Promise<ToolResult> {
  if (!symptom.trim() || !rootCause.trim() || !fix.trim()) {
    return fail("save_experience requires non-empty symptom, rootCause, and fix");
  }
  const exp: ExperienceRecord = {
    id: `exp_${Date.now().toString(36)}_manual`,
    symptom: symptom.slice(0, 500),
    rootCause: rootCause.slice(0, 1000),
    fix: fix.slice(0, 1000),
    files: files.slice(0, 20),
    tags: tags.length ? tags.slice(0, 10) : ["general"],
    traceId: "manual",
    timestamp: Date.now(),
    success: true,
  };
  const rel = await saveExperience(ctx.workspaceRoot, exp);
  return okMutation(cap(`Experience saved to ${rel}.`, ctx.maxOutputChars), rel);
}

/** Infer a feature name from the first markdown heading in content. */
function inferFeatureFromContent(content: string): string {
  try {
    const tree = fromMarkdown(content);
    for (const node of tree.children) {
      if (node.type === "heading" && node.depth === 1 && "children" in node && node.children?.length) {
        let text = "";
        for (const child of node.children) {
          if ("value" in child && typeof child.value === "string") {
            text += child.value;
          }
        }
        text = text.trim();
        if (text) {
          return text.replace(/^(spec|design|prd|产品需求|需求|设计)\s*文档?\s*[:：]?\s*/i, "").trim();
        }
      }
    }
  } catch {
    // fallback to regex if AST parsing fails
    const m = content.match(/^#\s+(.+)$/m);
    if (!m) return "";
    let title = m[1]!.trim();
    title = title.replace(/^(spec|design|prd|产品需求|需求|设计)\s*文档?\s*[:：]?\s*/i, "");
    return title.trim();
  }
  return "";
}

export async function toolSaveSpec(
  ctx: ToolContext,
  feature: string,
  content: string,
): Promise<ToolResult> {
  if (!content.trim()) return fail("save_spec requires non-empty content");
  const feat = feature.trim() || inferFeatureFromContent(content);
  if (!feat) return fail("save_spec requires a feature name (pass `feature` explicitly)");
  const rel = await saveSpec(ctx.workspaceRoot, feat, content);
  return okMutation(cap(`Spec saved to ${rel}. Next: save_design for the same feature.`, ctx.maxOutputChars), rel);
}

export async function toolSaveDesign(
  ctx: ToolContext,
  feature: string,
  content: string,
): Promise<ToolResult> {
  if (!content.trim()) return fail("save_design requires non-empty content");
  const feat = feature.trim() || inferFeatureFromContent(content);
  if (!feat) return fail("save_design requires a feature name (pass `feature` explicitly)");
  const rel = await saveDesign(ctx.workspaceRoot, feat, content);
  return okMutation(cap(`Design saved to ${rel}. Next: write tasks.md (or save_plan) then execute.`, ctx.maxOutputChars), rel);
}

export async function toolListSdd(
  ctx: ToolContext,
  feature: string | undefined,
): Promise<ToolResult> {
  if (feature && feature.trim()) {
    const status = await getFeatureStatus(ctx.workspaceRoot, feature);
    return ok(cap(formatFeatureStatus(status), ctx.maxOutputChars));
  }
  const features = await listFeatures(ctx.workspaceRoot);
  if (!features.length) return ok("No SDD features yet. Use save_spec to start one.");
  const lines = features.map(
    (f) => `- ${f.name} [${f.phases.join(",") || "empty"}]${f.complete ? " ✅" : ""} — ${f.title}`,
  );
  return ok(cap(`## SDD features\n${lines.join("\n")}`, ctx.maxOutputChars));
}

export async function toolAnalyzeIssue(
  ctx: ToolContext,
  description: string,
): Promise<ToolResult> {
  if (!description.trim()) return fail("analyze_issue requires a non-empty issue description");
  const plan = await bugfixWorkflow(ctx.workspaceRoot, description, { search: undefined });
  return ok(cap(formatBugfixPlan(plan), ctx.maxOutputChars));
}

export async function toolGraphSearch(
  ctx: ToolContext,
  query: string,
  depth: number,
): Promise<ToolResult> {
  if (!query.trim()) return fail("graph_search requires a non-empty query (symbol name)");
  
  const d = Math.min(Math.max(Math.trunc(depth) || 2, 1), 4);

  // 优先使用原生索引；仅在返回实际结果时使用，否则降级到 codemap
  if (ctx.index.graphSearch) {
    const r = await ctx.index.graphSearch(query, d);
    if (r.definition || r.callers.length > 0 || r.callees.length > 0) {
      const parts: string[] = [`## Graph: ${r.symbol}`];
      if (r.definition) {
        parts.push(`**definition**: ${r.definition.path}:${r.definition.line} (${r.definition.kind})`);
      }
      if (r.callers.length > 0) {
        parts.push(`**callers** (${r.callers.length}):`);
        for (const c of r.callers.slice(0, 20)) parts.push(`  - ${c.path}:${c.line}`);
      }
      if (r.callees.length > 0) {
        parts.push(`**callees** (${r.callees.length}):`);
        for (const c of r.callees.slice(0, 20)) parts.push(`  - ${c.path}:${c.line} → ${c.name}`);
      }
      return ok(cap(parts.join("\n"), ctx.maxOutputChars));
    }
    // 原生索引返回空结果（如 StubIndexClient），继续走 codemap 降级
  }

  // 回退：使用codemap的impact分析
  if (ctx.codemap) {
    try {
      const impact = await ctx.codemap.impact(query.trim(), d);
      const parts: string[] = [`## Graph: ${query}`];
      
      if (impact.focal) {
        parts.push(`**definition**: ${impact.focal.path}:${impact.focal.startLine} (${impact.focal.kind})`);
      }
      if (impact.callers.length > 0) {
        parts.push(`**callers** (${impact.callers.length}):`);
        for (const c of impact.callers.slice(0, 20)) parts.push(`  - ${c.path}:${c.startLine} ← ${c.name}`);
      }
      if (impact.callees.length > 0) {
        parts.push(`**callees** (${impact.callees.length}):`);
        for (const c of impact.callees.slice(0, 20)) parts.push(`  - ${c.path}:${c.startLine} → ${c.name}`);
      }
      if (impact.likelyTests.length > 0) {
        parts.push(`**likely tests** (${impact.likelyTests.length}):`);
        for (const t of impact.likelyTests.slice(0, 10)) parts.push(`  - ${t.path}:${t.startLine} (${t.name})`);
      }
      if (!impact.callers.length && !impact.callees.length) {
        parts.push("(no edges found — symbol may not exist or index not built)");
      }
      
      parts.push(`\n**Risk**: ${impact.riskLevel} (score: ${impact.riskScore}) — ${impact.explanation}`);
      
      return ok(cap(parts.join("\n"), ctx.maxOutputChars));
    } catch (error) {
      // codemap impact失败，返回搜索结果作为替代
      try {
        const hits = await ctx.codemap.search(query.trim(), 5);
        if (hits.length > 0) {
          const parts: string[] = [`## Graph: ${query}`, "(impact analysis unavailable, showing search results)"];
          for (const hit of hits) {
            parts.push(`  - ${hit.node.path}:${hit.node.startLine} (${hit.node.kind}) ${hit.node.name}`);
          }
          return ok(cap(parts.join("\n"), ctx.maxOutputChars));
        }
      } catch {}
      return fail(`graph_search: symbol "${query}" not found in native index or codemap.`);
    }
  }

  return fail("graph_search requires either the native index (run pnpm native:build) or codemap to be available.");
}

export async function toolBash(ctx: ToolContext, command: string): Promise<ToolResult> {
  if (!command || !command.trim()) {
    return fail("bash requires a non-empty command");
  }
  if (ctx.mode !== "agent") {
    if (ctx.workflow.modes.plan.bash !== "readonly") {
      return fail("bash denied in Plan mode (hard read-only)");
    }
    if (!isReadonlyBash(command)) {
      return fail(
        "Plan mode bash is readonly-only (ls/dir/git status/diff/log、type/Get-Content 等)。拒绝执行写操作命令。",
      );
    }
  }
  const id = `bash_${Date.now().toString(36)}`;
  const at = new Date().toISOString();

  if (looksDangerous(command)) {
    const needConfirm = ctx.workflow.modes.agent.dangerousBashConfirm;
    if (needConfirm && ctx.confirmDangerousBash) {
      ctx.onTerminal?.({
        id,
        command,
        cwd: ctx.workspaceRoot,
        status: "pending_confirm",
        at,
      });
      const allowed = await ctx.confirmDangerousBash(command);
      if (!allowed) {
        ctx.onTerminal?.({
          id,
          command,
          cwd: ctx.workspaceRoot,
          status: "denied",
          at: new Date().toISOString(),
        });
        return fail(`Dangerous command denied by user: ${command.slice(0, 120)}`);
      }
    } else {
      ctx.onTerminal?.({
        id,
        command,
        cwd: ctx.workspaceRoot,
        status: "denied",
        at,
      });
      return fail(
        `Blocked potentially dangerous command. Enable confirm in settings or soften the command: ${command.slice(0, 120)}`,
      );
    }
  }

  ctx.onTerminal?.({
    id,
    command,
    cwd: ctx.workspaceRoot,
    status: "running",
    at: new Date().toISOString(),
  });
  const { stdout, stderr, code } = await runCommand(command, ctx.workspaceRoot, 300_000, ctx.signal);
  const safeOutput = isRedactionEnabled(ctx.workflow)
    ? await redactCommandReadOutput(command, ctx.workspaceRoot, stdout, stderr, {
        sensitiveFiles: ctx.workflow.secrets?.sensitiveFiles,
        patterns: ctx.workflow.secrets?.patterns,
      })
    : { stdout, stderr };
  ctx.onTerminal?.({
    id,
    command,
    cwd: ctx.workspaceRoot,
    exitCode: code,
    stdout: safeOutput.stdout.slice(0, ctx.bashMaxChars),
    stderr: safeOutput.stderr.slice(0, Math.floor(ctx.bashMaxChars / 2)),
    status: code === 0 ? "ok" : "error",
    at: new Date().toISOString(),
  });
  const body = [
    `exit ${code}`,
    safeOutput.stdout && `stdout:\n${safeOutput.stdout}`,
    safeOutput.stderr && `stderr:\n${safeOutput.stderr}`,
  ]
    .filter(Boolean)
    .join("\n");
  const safeBody = body || "(no output)";
  return ok(cap(safeBody, ctx.bashMaxChars));
}

// ── Knowledge Graph Updater ────────────────────────────────

/* Knowledge graph updates are intentionally limited to mutation tools. */
/*
function updateKGFromRead(ctx: ToolContext, relPath: string, text: string): void {
  if (!ctx.memory) return;

  const symbols = extractDocumentSymbols(text);

  // Build FileNode
  const category: "source" | "test" | "config" | "doc" | "other" =
    relPath.includes(".test.") || relPath.includes(".spec.") || relPath.includes("__tests__")
      ? "test"
      : [".json", ".yaml", ".yml", ".toml", ".config"].some((e) => relPath.endsWith(e))
        ? "config"
        : [".md", ".txt", ".rst"].some((e) => relPath.endsWith(e))
          ? "doc"
          : "source";

  // Detect imports
  const importRe = /(?:import|require)\s*(?:\([\s\S]*?\)|['"]([^'"]+)['"])/g;
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(text))) {
    if (m[1] && !m[1].startsWith(".")) {
      imports.push(m[1].split("/")[0] ?? m[1]); // package name
    } else if (m[1]) {
      imports.push(m[1]); // relative path
    }
  }

  ctx.memory.addFileNode({
    path: relPath,
    imports: [...new Set(imports)],
    importedBy: [],
    symbols: symbols.map((s) => ({
      name: s.name,
      kind: s.kind as "function" | "class" | "interface" | "type" | "enum" | "variable" | "module",
      exported: text.includes(`export`) && text.includes(s.name),
      references: [],
      filePath: relPath,
      line: s.line,
    })),
    category,
    complexity: estimateComplexity(text),
    lastModified: Date.now(),
  });

  // Detect patterns
  detectAndStorePatterns(ctx, relPath, text);
}
*/

/*
function estimateComplexity(text: string): number {
  const lines = text.split("\n");
  let complexity = 1;

  // Count branching statements
  const branching = (text.match(/\b(if|else|switch|case|for|while|catch)\b/g) ?? []).length;
  // Count functions
  const functions = (text.match(/\b(function|=>)\b/g) ?? []).length;
  // Count nesting
  const maxIndent = Math.max(...lines.map((l) => (l.match(/^(\s*)/)?.[1]?.length ?? 0) / 2));

  complexity += branching * 0.5 + functions * 0.3 + maxIndent * 0.2;
  return Math.round(Math.min(100, complexity));
}

function detectAndStorePatterns(ctx: ToolContext, relPath: string, text: string): void {
  if (!ctx.memory) return;

  // React component pattern
  if (/(?:function|const)\s+\w+\s*(?:[:=]\s*(?:React\.)?FC|\([^)]*\)\s*[:=]\s*React\.ReactNode)/.test(text) ||
      /\bexport\s+default\s+(?:function|class)\s+\w+/.test(text) ||
      /\breturn\s*\(\s*</.test(text)) {
    ctx.memory.addPattern({
      name: "React组件",
      description: "React component with JSX",
      files: [relPath],
      frequency: 1,
      example: text.slice(0, 200),
    });
  }

  // Error handling pattern (try/catch)
  if (/\btry\s*\{/.test(text) && /\bcatch\s*\(/.test(text)) {
    ctx.memory.addConvention({
      category: "error-handling",
      description: "使用 try/catch 处理异常",
      confidence: 0.6,
      examples: [relPath],
    });
  }

  // Naming conventions
  if (/\bconst\s+[A-Z][A-Z_0-9]+\s*=/.test(text)) {
    ctx.memory.addConvention({
      category: "naming",
      description: "常量使用 UPPER_SNAKE_CASE",
      confidence: 0.7,
      examples: [relPath],
    });
  }

  // Async/await pattern
  if (/\basync\s+function\b/.test(text) || /\bawait\s+\w+/.test(text)) {
    ctx.memory.addPattern({
      name: "Async/Await",
      description: "异步操作使用 async/await",
      files: [relPath],
      frequency: 1,
      example: text.slice(0, 200),
    });
  }
}


}
*/

export async function toolAppend(ctx: ToolContext, path: string, content: string): Promise<ToolResult> {
  if (!path || !path.trim()) {
    return fail("append_file requires a non-empty file path");
  }
  if (!content) {
    return fail("append_file requires non-empty content to append");
  }
  
  path = normalizeInputPath(path);
  const check = checkWritable(ctx.workspaceRoot, path, ctx.workflow.context.writePolicy);
  if (!check.ok) return fail(check.reason ?? "not writable");
  const planBlock = assertPlanMutationAllowed(ctx, check.relPath);
  if (planBlock) return planBlock;
  
  const abs = toAbs(ctx.workspaceRoot, check.relPath);
  const rel = check.relPath;
  
  // Check if file exists
  let originalSize = 0;
  try {
    const stats = await fs.stat(abs);
    originalSize = stats.size;
  } catch {
    return fail(`File "${rel}" does not exist. Use write_file to create it first, then append_file to add content.`);
  }
  
  // Create snapshot before appending
  if (ctx.fileSnapshots) {
    await snapshotFileBeforeWrite(ctx.workspaceRoot, rel, ctx.fileSnapshots);
  }
  
  // Append content to file
  await fs.appendFile(abs, content, "utf8");
  
  // Update tracking
  ctx.readSet.add(rel);
  ctx.touchedPaths?.push(rel);
  if (isPlanPath(rel)) ctx.lastPlanPath = rel;
  ctx.index.invalidate(rel);
  void ctx.index.ragUpdate?.(ctx.workspaceRoot, [], [rel], []);
  
  if (ctx.memory) {
    ctx.memory.addEdit(rel, "append_file", `(+${content.length} chars)`, content.slice(0, 100));
    ctx.memory.updateHotspot(rel, true, false);
  }
  
  const newSize = originalSize + Buffer.byteLength(content, "utf8");
  return okMutation(`Appended to ${rel} (added ${content.length} chars, total now ${newSize} bytes)`, rel);
}
