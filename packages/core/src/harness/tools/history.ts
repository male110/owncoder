import { finalizeRecalledHistoryHits } from "../loop/history-vector.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { fail, ok, str } from "./shared.ts";

const HISTORY_TOP_K = 5;

/** 将归档字段格式化为召回正文：保留完整原文，供 LLM 按需取回。 */
function formatField(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "(none)", null, 2);
}

/** Retrieve the most relevant archived history for the current session. */
export async function toolRecallHistory(ctx: ToolContext, query: string): Promise<ToolResult> {
  const text = query.trim();
  if (!text) return fail("query must not be empty");
  if (!ctx.historyVector || !ctx.sessionId) {
    return ok("No searchable session history is available.");
  }

  const queryVector = await ctx.historyVector.embedding.embed(text);
  // 先取历史 → 丢掉相关性 < 60% → 再对剩余结果做相似性判断（高相似只留最近一轮）。
  const hits = finalizeRecalledHistoryHits(
    ctx.historyVector.store
      .search(queryVector, 1000, ctx.sessionId)
      .filter((hit) => hit.turnId.startsWith(`round:${ctx.sessionId}:`))
      .slice(0, HISTORY_TOP_K),
  );

  if (hits.length === 0) {
    return ok("No relevant history found (minimum relevance: 60%).");
  }

  const output = hits.map((hit, index) => {
    type ArchivedRound = {
      userInput?: unknown;
      taskDecomposition?: unknown;
      llmReport?: unknown;
      evidence?: unknown;
      toolCalls?: unknown;
    };
    let round: ArchivedRound | null = null;
    try {
      const parsed: unknown = JSON.parse(hit.content);
      if (parsed && typeof parsed === "object") round = parsed as ArchivedRound;
    } catch {
      // Older archived chunks are plain text; keep them as the user-input field.
    }
    return [
    `## Match ${index + 1}`,
    `User input:\n${formatField(round?.userInput ?? hit.content)}`,
    `Task decomposition:\n${formatField(round?.taskDecomposition)}`,
    `LLM report:\n${formatField(round?.llmReport)}`,
    `Evidence:\n${formatField(round?.evidence)}`,
    `Tool calls:\n${formatField(round?.toolCalls)}`,
  ].join("\n");
  }).join("\n\n");

  return ok(output);
}

export function historyRecallQuery(args: Record<string, unknown>): string {
  return str(args.query ?? args.keyword);
}
