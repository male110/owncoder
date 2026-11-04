import { promises as fs, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { redactSecrets, isRedactionEnabled } from "../redact.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { assertInside, fail, formatWithLines, normalizeRel, toAbs } from "./shared.ts";

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
  try {
    stat = await fs.stat(abs);
  } catch (e: any) {
    if (e.code === "ENOENT") {
      return fail(
        `⚠️ DO NOT retry read_file("${path}") — this path does not exist.\n\n` +
        `File not found: "${path}"\n\n` +
        `Locate it first with the glob tool (e.g. glob with pattern "**/*<filename fragment>*") or the grep tool (output_mode "files_with_matches"), then read the confirmed path.\n\n` +
        `⚠️ Retrying the same non-existent path will fail again.`,
      );
    }
    return fail(`Cannot read file "${path}": ${e.message}`);
  }
  const rel = normalizeRel(ctx.workspaceRoot, abs);
  ctx.readSet.add(rel);
  // Current-turn evidence cache: unchanged file fingerprints allow replaying a
  // bounded range without another disk read or redaction pass.
  if (ctx.evidenceStore) {
    const cached = ctx.evidenceStore.lookupRead(rel, offset, limit, `${stat.size}:${stat.mtimeMs}`);
    if (cached) return cached;
  }
  let text: string;
  let rangedTotalLines: number | undefined;
  try {
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
    if (e.code === "EISDIR") {
      return fail(`"${path}" is a directory, not a file.`);
    }
    return fail(`Cannot read file "${path}": ${e.message}`);
  }
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

  const result: ToolResult = {
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
  // Cache the final redacted output for this turn; writes invalidate the path.
  if (ctx.evidenceStore) {
    ctx.evidenceStore.recordRead(rel, offset, limit, `${stat.size}:${stat.mtimeMs}`, result);
  }
  return result;
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
