import type { ToolContext, ToolResult } from "./types.ts";
import type { RagHit, SymbolSearchResult } from "@owncoder/index";
import { cap, escapeRegExp, fail, ok, str } from "./shared.ts";
import { toolGrep } from "./grep.ts";

/** 语义路 top-K：自然语言查询的主力（FTS 的盲区），命中按文件去重补位。 */
const SEMANTIC_TOP_K = 16;
/** preview 单行字符上限（语义命中取 chunk 的签名/doc 行）。 */
const SEMANTIC_PREVIEW_CHARS = 110;

export async function toolSearchSymbols(
  ctx: ToolContext,
  query: string,
  limit: number,
): Promise<ToolResult> {
  const q = str(query).trim();
  if (!q) return fail("search_symbols requires a non-empty query");

  // 双路并行（与 index-navigation.ts 的 hybrid 同构）：FTS 吃精确符号名，
  // 语义路（向量召回）吃自然语言查询。两路各自 best-effort——一路缺失或
  // 抛错不拖垮另一路（CLI 无语义端口时 ragSearch 为 undefined）。
  const maxResults = Math.min(Math.max(limit, 1), 50);
  const [ftsResults, semanticResults] = await Promise.all([
    ctx.index.ftsSearch
      ? ctx.index.ftsSearch(q, { limit: maxResults }).catch(() => [] as SymbolSearchResult[])
      : Promise.resolve([] as SymbolSearchResult[]),
    ctx.index.ragSearch
      ? ctx.index.ragSearch(q, SEMANTIC_TOP_K).catch(() => [] as RagHit[])
      : Promise.resolve([] as RagHit[]),
  ]);

  if (ftsResults.length === 0 && semanticResults.length === 0) {
    // 两路皆空：回退到按精确符号名做文件搜索
    const header = !ctx.index.ftsSearch && !ctx.index.ragSearch
      ? "Symbol index is unavailable; exact-name file search instead"
      : `No symbols matching "${q}" in the index; exact-name file search instead`;
    return fileSearchFallback(ctx, q, header);
  }

  const lines: string[] = [`## Symbol Search: "${q}"`];
  const ftsPaths = new Set<string>();
  let count = 0;
  let exact = 0;

  // 精确符号命中排前（kind/签名/doc 齐全）。
  for (const r of ftsResults.slice(0, maxResults)) {
    if (r.path) ftsPaths.add(r.path);
    const sig = r.signature ? `: ${r.signature}` : "";
    lines.push(`- **${r.kind}** \`${r.name}\`${sig}`);
    lines.push(`  ${r.path}:${r.line}`);
    if (r.doc) {
      const docPreview = r.doc.slice(0, 100).replace(/\n/g, " ");
      lines.push(`  ${docPreview}${r.doc.length > 100 ? "..." : ""}`);
    }
    count++;
    exact++;
  }

  // 语义命中补位：FTS 未覆盖的文件（同一文件已精确命中则不重复），
  // 标注 semantic match 让模型知道这是向量召回而非精确匹配。
  const semanticHits = semanticResults.filter((h) => h?.filePath && !ftsPaths.has(h.filePath));
  if (semanticHits.length > 0 && count < maxResults) {
    lines.push("");
    lines.push("Semantic matches (vector recall; verify locations before editing):");
  }
  for (const hit of semanticHits) {
    if (count >= maxResults) break;
    const range = hit.endLine > hit.startLine ? `${hit.startLine}-${hit.endLine}` : `${hit.startLine}`;
    lines.push(`- **semantic match** \`${hit.symbol || hit.filePath}\`: ${semanticPreview(hit.content)}`);
    lines.push(`  ${hit.filePath}:${range}`);
    count++;
  }

  lines.splice(1, 0, `Found ${count} results (${exact} exact, ${count - exact} semantic)`);
  return ok(cap(lines.join("\n"), ctx.maxOutputChars));
}

/** 取 chunk 文本的第 2-3 行（signature/doc）作单行预览。 */
function semanticPreview(content: string): string {
  const fileLines = content.split("\n").slice(1, 3).filter((l) => l.trim());
  const one = fileLines.join(" ").trim();
  return one ? one.slice(0, SEMANTIC_PREVIEW_CHARS) : "(no excerpt)";
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
