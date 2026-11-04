import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { extname, isAbsolute } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { ToolContext, ToolResult } from "./types.ts";
import { normalizeInputPath, normalizeRel, toAbs } from "./shared.ts";

/**
 * fs 工具簇的跨工具共享部分：读取预算常量（从 fs.ts 搬来，公开面不变）、
 * 目录扫描跳过判断、行读取器关闭、变更结果构造、编辑路径解析、特性名推断。
 * 各工具实现见同目录 read-file.ts / grep.ts / apply-patch.ts 等独立文件。
 */

/** Whole-file reads (no offset/limit) are rejected at or above this size; call read_outline first. */
export const WHOLE_FILE_READ_BYTES = 10_000;
/** Alias for the whole-file size cap. */
export const LARGE_FILE_READ_BYTES = WHOLE_FILE_READ_BYTES;
/** Retained for compatibility with callers that import the historical budget constant. */
export const READ_FILE_OUTPUT_BUDGET = 256_000;
/** grep never materializes files larger than this (aligned with the index scanner). */
export const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;

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

export function isSkipDirName(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (SKIP_SCAN_DIRS.has(name)) return true;
  return process.platform === "win32" && SKIP_SCAN_DIRS.has(name.toLowerCase());
}

export function closeLineReader(
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

export function okMutation(output: string, ...paths: string[]): ToolResult {
  return {
    ok: true,
    output,
    metadata: { kind: "file_mutation", paths },
  };
}

export function resolveEditPath(ctx: ToolContext, path: string): { abs: string; rel: string; external: boolean } {
  const abs = toAbs(ctx.workspaceRoot, normalizeInputPath(path));
  const rel = normalizeRel(ctx.workspaceRoot, abs);
  const external = isAbsolute(path) && (rel === ".." || rel.startsWith("../") || isAbsolute(rel));
  return { abs, rel: external ? abs : rel, external };
}

/** Infer a feature name from the first markdown heading in content. */
export function inferFeatureFromContent(content: string): string {
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
    title = title.replace(/^(spec|design|prd|产品需求|需求|设计)\s*文档?\s*[:：]?\s*/i, "").trim();
    return title.trim();
  }
  return "";
}

// ── glob 模式 → 正则（glob 与 grep 共用） ─────────────────────────────────

/**
 * Compile a glob pattern into a matcher testing both the path relative to the
 * search root and (when the pattern contains no "/") the bare file name.
 * Throws when the pattern cannot be compiled to a valid RegExp.
 */
export function createGlobMatcher(pattern: string): (relativePath: string, fileName: string) => boolean {
  const normalized = normalizeGlobPattern(pattern);
  const regex = globPatternToRegExp(normalized);
  const basenameRegex = normalized.includes("/") ? undefined : globPatternToRegExp(normalized);

  return (relativePath, fileName) =>
    regex.test(relativePath) || (basenameRegex ? basenameRegex.test(fileName) : false);
}

export function normalizeGlobPattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

export function globPatternToRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];

    if (char === "*") {
      if (next === "*") {
        const afterNext = pattern[index + 2];
        if (afterNext === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    if (char === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end > index) {
        const alternatives = pattern
          .slice(index + 1, end)
          .split(",")
          .map(escapeRegex)
          .join("|");
        regex += `(?:${alternatives})`;
        index = end;
        continue;
      }
    }

    regex += escapeRegex(char);
  }

  regex += "$";
  return new RegExp(regex);
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

// ── 文件类型过滤（类型名 → 扩展名表） ─────────────────────────────────────

/**
 * Known file-type → extension mappings for the grep `type` filter.
 * Unknown types fall back to a literal `.<type>` extension match.
 */
export const FILE_TYPE_EXTENSION_MAP: Record<string, string[]> = {
  c: [".c", ".h"],
  cpp: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
  csharp: [".cs"],
  css: [".css"],
  go: [".go"],
  html: [".html", ".htm"],
  java: [".java"],
  js: [".js", ".jsx", ".mjs", ".cjs"],
  json: [".json", ".jsonc"],
  markdown: [".md", ".markdown"],
  md: [".md", ".markdown"],
  py: [".py"],
  python: [".py"],
  rs: [".rs"],
  rust: [".rs"],
  sh: [".sh", ".bash", ".zsh"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  tsx: [".tsx"],
  txt: [".txt"],
  yaml: [".yaml", ".yml"],
};

/** Case-insensitive type filter with alias support; unknown types match `.<type>` literally. */
export function matchesFileType(path: string, type: string): boolean {
  const normalized = type.toLowerCase().replace(/^\./, "");
  const extension = extname(path).toLowerCase();
  const known = FILE_TYPE_EXTENSION_MAP[normalized];
  if (known) return known.includes(extension);
  return extension === `.${normalized}`;
}
