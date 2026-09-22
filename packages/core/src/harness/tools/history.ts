import type { ToolContext, ToolResult } from "./types.ts";
import { fail, ok, str } from "./shared.ts";

const HISTORY_TOP_K = 5;
const HISTORY_MIN_SCORE = 0.6;
const HISTORY_FIELD_MAX_CHARS = 4_000;

function compactField(value: unknown): string {
  const text = typeof value === "string"
    ? value
    : JSON.stringify(value ?? "(none)", null, 2);
  if (text.length <= HISTORY_FIELD_MAX_CHARS) return text;
  return `${text.slice(0, HISTORY_FIELD_MAX_CHARS)}\n…[truncated]`;
}

/** Retrieve the most relevant archived history for the current session. */
export async function toolRecallHistory(ctx: ToolContext, query: string): Promise<ToolResult> {
  const text = query.trim();
  if (!text) return fail("query must not be empty");
  if (!ctx.historyVector || !ctx.sessionId) {
    return ok("No searchable session history is available.");
  }

  const queryVector = await ctx.historyVector.embedding.embed(text);
  const hits = ctx.historyVector.store
    .search(queryVector, 1000, ctx.sessionId)
    .filter((hit) => hit.turnId.startsWith(`round:${ctx.sessionId}:`))
    .slice(0, HISTORY_TOP_K)
    .filter((hit) => hit.score >= HISTORY_MIN_SCORE);

  if (hits.length === 0) {
    return ok("No relevant history found (minimum relevance: 60%).");
  }

  const output = hits.map((hit, index) => {
    type ArchivedRound = {
      userInput?: unknown;
      taskDecomposition?: unknown;
      llmReport?: unknown;
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
    `User input:\n${compactField(round?.userInput ?? hit.content)}`,
    `Task decomposition:\n${compactField(round?.taskDecomposition)}`,
    `LLM report:\n${compactField(round?.llmReport)}`,
    `Tool calls:\n${compactField(round?.toolCalls)}`,
  ].join("\n");
  }).join("\n\n");

  return ok(output);
}

export function historyRecallQuery(args: Record<string, unknown>): string {
  return str(args.query ?? args.keyword);
}
