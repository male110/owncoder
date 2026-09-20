import type { ToolContext, ToolResult } from "./types.ts";
import { fail, ok } from "./shared.ts";

export async function toolCodemapSearch(
  ctx: ToolContext,
  query: string,
  limit: number,
): Promise<ToolResult> {
  if (!ctx.codemap) return fail("Codemap is unavailable; use search_symbols or graph_search instead.");
  if (!query.trim()) return fail("codemap_search requires a non-empty query");
  try {
    const hits = await ctx.codemap.search(query.trim(), limit);
    if (!hits.length) return ok("Codemap found no matching symbols.");
    return ok(JSON.stringify({
      query,
      results: hits.map(({ node, score, summary }) => ({
        nodeId: node.id,
        name: node.name,
        qualifiedName: node.qualifiedName,
        kind: node.kind,
        path: node.path,
        line: node.startLine,
        language: node.language,
        score,
        summary,
      })),
      instruction: "Use nodeId from a result with codemap_impact before changing a shared symbol.",
    }, null, 2));
  } catch (error) {
    return fail(`Codemap search failed; fall back to search_symbols or graph_search. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function toolCodemapImpact(
  ctx: ToolContext,
  nodeId: string,
  depth: number,
): Promise<ToolResult> {
  if (!ctx.codemap) return fail("Codemap is unavailable; use graph_search instead.");
  if (!nodeId.trim()) return fail("codemap_impact requires a nodeId returned by codemap_search");
  try {
    const impact = await ctx.codemap.impact(nodeId.trim(), depth);
    return ok(JSON.stringify({
      focal: impact.focal,
      risk: {
        level: impact.riskLevel,
        score: impact.riskScore,
        explanation: impact.explanation,
        directCallers: impact.directCallers,
        transitiveCallers: impact.transitiveCallers,
      },
      callers: impact.callers,
      callees: impact.callees,
      likelyTests: impact.likelyTests,
    }, null, 2));
  } catch (error) {
    return fail(`Codemap impact analysis failed; fall back to graph_search. ${error instanceof Error ? error.message : String(error)}`);
  }
}
