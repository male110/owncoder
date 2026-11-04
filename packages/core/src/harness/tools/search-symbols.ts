import type { ToolContext, ToolResult } from "./types.ts";
import type { SymbolSearchResult } from "@owncoder/index";
import { cap, escapeRegExp, fail, ok, str } from "./shared.ts";
import { toolGrep } from "./grep.ts";


export async function toolSearchSymbols(
  ctx: ToolContext,
  query: string,
  limit: number,
): Promise<ToolResult> {
  const q = str(query).trim();
  if (!q) return fail("search_symbols requires a non-empty query");

  const maxResults = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 20, 1), 50);
  let ftsResults: SymbolSearchResult[] = [];
  if (ctx.index.ftsSearch) {
    try {
      ftsResults = await ctx.index.ftsSearch(q, { limit: maxResults });
    } catch {
      ftsResults = [];
    }
  }

  if (ftsResults.length === 0) {
    const header = !ctx.index.ftsSearch
      ? "Symbol index is unavailable; exact-name file search instead"
      : `No symbols matching "${q}" in the index; exact-name file search instead`;
    return fileSearchFallback(ctx, q, header);
  }

  const lines: string[] = [`## Symbol Search: "${q}"`, `Found ${Math.min(ftsResults.length, maxResults)} symbol results`];

  for (const r of ftsResults.slice(0, maxResults)) {
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

/** 索引缺失或未命中时的文件搜索回退：按精确符号名 grep。 */
async function fileSearchFallback(
  ctx: ToolContext,
  query: string,
  header: string,
): Promise<ToolResult> {
  const grepResult = await toolGrep(ctx, `\\b${escapeRegExp(query)}\\b`, ".", 30);
  if (!grepResult.ok || /^(No matches|Error:)/.test(grepResult.output)) {
    return ok(`No symbols matching "${query}" found`);
  }
  const lines: string[] = [`## Symbol Search: "${query}" (index fallback)`, header, "", grepResult.output];
  lines.push("Candidates only — index locations, not definitions.");
  return ok(cap(lines.join("\n"), ctx.maxOutputChars));
}
