import type { ToolContext, ToolResult } from "./types.ts";
import { assertInside, fail, normalizeInputPath, normalizeRel, ok, toAbs } from "./shared.ts";
import { toolRead } from "./read-file.ts";

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
    // Index query failure is not fatal — LLM can still fall back to read_file.
    return ok(
      `Cannot query the symbol index for \"${rel}\": ${error instanceof Error ? error.message : String(error)}. ` +
        "Continue with read_file; do not treat this as a fatal error.",
    );
  }

  const matches = tags.filter((tag) => tag.name === requestedSymbol);
  if (matches.length === 0) {
    // Soft miss: missing index entry must not stop the agent loop.
    return ok(
      `Symbol \"${requestedSymbol}\" was not found in the current index for \"${rel}\". ` +
        "Continue with read_file; do not treat this as a fatal error.",
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
