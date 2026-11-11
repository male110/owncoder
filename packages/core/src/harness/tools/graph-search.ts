import type { ToolContext, ToolResult } from "./types.ts";
import { cap, escapeRegExp, fail, ok } from "./shared.ts";
import { toolGrep } from "./grep.ts";

export async function toolGraphSearch(
  ctx: ToolContext,
  query: string,
  depth: number,
): Promise<ToolResult> {
  if (!query.trim()) return fail("graph_search requires a non-empty query (symbol name)");
  
  const d = Math.min(Math.max(Math.trunc(depth) || 1, 1), 4);

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
      if (impact.callers.length > 0 || impact.callees.length > 0 || impact.focal) {
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
      }
    } catch (error) {
      // codemap impact失败，尝试 codemap.search 作为中间回退
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
    }
  }

  // 最终回退：按精确符号名做文件搜索（grep），给出候选定义位置
  const grepResult = await toolGrep(ctx, `\\b${escapeRegExp(query.trim())}\\b`, ".", 30);
  if (grepResult.ok && !/^(No matches|Error:)/.test(grepResult.output)) {
    const parts: string[] = [
      `## Graph: ${query}`,
      "(not found in symbol index; exact-name file search instead)",
      grepResult.output,
      "Candidates only — index locations, not definitions.",
    ];
    return ok(cap(parts.join("\n"), ctx.maxOutputChars));
  }

  return fail(`graph_search: symbol "${query}" not found in native index, codemap, or workspace files.`);
}
