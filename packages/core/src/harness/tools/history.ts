import type { ToolContext, ToolResult } from "./types.ts";
import { fail, ok, str } from "./shared.ts";
import { searchHistory } from "../loop/history-vector.ts";

const HISTORY_TOP_K = 5;
const HISTORY_MIN_SCORE = 0.6;
const HISTORY_FIELD_MAX_CHARS = 4_000;

export interface HistoryRecallOptions {
  query: string;
  beforeTurnIndex?: number;
}

export interface HistoryRecallSource {
  embedding: NonNullable<ToolContext["historyVector"]>["embedding"];
  store: NonNullable<ToolContext["historyVector"]>["store"];
  sessionId?: string;
}

function compactField(value: unknown): string {
  const text = typeof value === "string"
    ? value
    : JSON.stringify(value ?? "(none)", null, 2);
  if (text.length <= HISTORY_FIELD_MAX_CHARS) return text;
  return `${text.slice(0, HISTORY_FIELD_MAX_CHARS)}\n…[truncated]`;
}

/**
 * Shared boundary implementation. Callers choose the boundary; this function
 * owns validation, vector retrieval, relevance filtering, and formatting.
 */
export async function recallHistoryBefore(
  source: HistoryRecallSource,
  options: HistoryRecallOptions,
): Promise<ToolResult> {
  const text = options.query.trim();
  if (!text) return fail("query must not be empty");
  if (!source.sessionId) return ok("No searchable session history is available.");

  const hits = (await searchHistory(
    source.embedding,
    source.store,
    text,
    source.sessionId,
    1000,
    options.beforeTurnIndex,
  ))
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
    `User input:\n${compactField(round?.userInput ?? hit.content)}`,
    `Task decomposition:\n${compactField(round?.taskDecomposition)}`,
    `LLM report:\n${compactField(round?.llmReport)}`,
    `Evidence:\n${compactField(round?.evidence)}`,
    `Tool calls:\n${compactField(round?.toolCalls)}`,
  ].join("\n");
  }).join("\n\n");

  return ok(output);
}

/** Ordinary recall delegates to the shared boundary implementation. */
export async function recallHistory(ctx: ToolContext, options: HistoryRecallOptions): Promise<ToolResult> {
  if (!ctx.historyVector) return ok("No searchable session history is available.");
  return recallHistoryBefore(ctx.historyVector && {
    ...ctx.historyVector,
    sessionId: ctx.sessionId,
  }, options);
}

export async function toolRecallHistory(ctx: ToolContext, query: string): Promise<ToolResult> {
  return recallHistory(ctx, { query });
}

export async function toolRecallHistoryBefore(
  ctx: ToolContext,
  query: string,
  beforeTurnIndex?: number,
): Promise<ToolResult> {
  if (!ctx.historyVector) return ok("No searchable session history is available.");
  return recallHistoryBefore({ ...ctx.historyVector, sessionId: ctx.sessionId }, { query, beforeTurnIndex });
}

/** Task decomposition entry point; the caller supplies its fixed five-round boundary. */
export async function recallHistoryForTaskDecompose(
  source: HistoryRecallSource,
  query: string,
  beforeTurnIndex: number,
): Promise<ToolResult> {
  return recallHistoryBefore(source, { query, beforeTurnIndex });
}

export async function toolRecallHistoryForTaskDecompose(
  ctx: ToolContext,
  query: string,
  beforeTurnIndex: number,
): Promise<ToolResult> {
  if (!ctx.historyVector) return ok("No searchable session history is available.");
  return recallHistoryForTaskDecompose({ ...ctx.historyVector, sessionId: ctx.sessionId }, query, beforeTurnIndex);
}

export function historyRecallQuery(args: Record<string, unknown>): string {
  return str(args.query ?? args.keyword);
}

export function historyRecallBeforeTurn(args: Record<string, unknown>): number | undefined {
  const value = Number(args.beforeTurnIndex);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}
