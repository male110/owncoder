import { SemanticSearchError, type RagHit } from "@owncoder/index";
import type { ToolContext, ToolResult } from "./types.ts";
import { cap, fail, ok, str } from "./shared.ts";

const SEMANTIC_TOP_K = 16;
const PREVIEW_CHARS = 110;

export async function toolSearchSemantic(ctx: ToolContext, query: string, limit: number): Promise<ToolResult> {
  const q = str(query).trim();
  if (!q) return fail("search_semantic requires a non-empty query");
  const maxResults = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 20;
  if (!ctx.index.ragSearch) return fail("Semantic search unavailable: vector search is not supported by this index");

  let hits: RagHit[];
  try {
    hits = await ctx.index.ragSearch(q, Math.max(SEMANTIC_TOP_K, maxResults));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const status = error instanceof SemanticSearchError && error.code !== "search_failed" ? "unavailable" : "failed";
    const code = error instanceof SemanticSearchError ? ` [${error.code}]` : "";
    return fail(cap(`Semantic search ${status}${code}: ${detail}`, ctx.maxOutputChars));
  }
  if (!Array.isArray(hits)) return fail("Semantic search failed: index returned an invalid response");
  const results = hits.filter((hit) => hit?.filePath).slice(0, maxResults);
  if (results.length === 0) return ok(`No semantic results for "${q}"`);

  const lines = [`## Semantic Search: "${q}"`, `Found ${results.length} vector results`];
  for (const hit of results) {
    const range = hit.endLine > hit.startLine ? `${hit.startLine}-${hit.endLine}` : `${hit.startLine}`;
    const score = Number.isFinite(hit.semanticScore) ? ` (score: ${hit.semanticScore.toFixed(3)})` : "";
    const excerpt = hit.content.split("\n").slice(1, 3).filter((line) => line.trim()).join(" ").trim();
    lines.push(`- **semantic match** \`${hit.symbol || hit.filePath}\`${score}: ${excerpt ? excerpt.slice(0, PREVIEW_CHARS) : "(no excerpt)"}`);
    lines.push(`  ${hit.filePath}:${range}`);
  }
  return ok(cap(lines.join("\n"), ctx.maxOutputChars));
}

export const SEMANTIC_SEARCH_TOP_K = SEMANTIC_TOP_K;
