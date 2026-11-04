import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { redactSecrets, isRedactionEnabled } from "../redact.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { assertInside, fail, formatWithLines, normalizeInputPath, normalizeRel, toAbs } from "./shared.ts";
import { closeLineReader, WHOLE_FILE_READ_BYTES } from "./fs-shared.ts";

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
        `⚠️ DO NOT retry read_outline("${path}") — this path does not exist.\n\n` +
        `File not found: "${path}"\n\n` +
        `Locate it first with the glob tool (e.g. glob with pattern "**/*<filename fragment>*") or the grep tool (output_mode "files_with_matches"), then read the confirmed path.\n\n` +
        `⚠️ Retrying the same non-existent path will fail again.`,
      );
    }
    if (e.code === "EISDIR") {
      return fail(`"${path}" is a directory, not a file.`);
    }
    return fail(`Cannot read file "${path}": ${e.message}`);
  }
  if (stat.isDirectory()) {
    return fail(`"${path}" is a directory, not a file.`);
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
