/**
 * 历史消息向量检索基础设施（接口 + 纯归档逻辑）。
 *
 * 分层（native 依赖只由 desktop 层注入，core 保持纯 TS、可单测）：
 *   - 本文件定义 `HistoryChunk` / `EmbeddingService` / `HistoryVectorStore` 接口，
 *     以及无副作用的归档逻辑 `archiveTurn`（无 LLM、无 embedding、无 native）。
 *   - sqlite-vec + embedding 模型的具体实现由调用方（Electron main）注入，
 *     使 `history_compact` 阶段能在不引入 native 依赖的情况下声明接入点。
 */

import { createHash } from "node:crypto";
import type { ChatTurn } from "./types.ts";

/** 一条已归档、可被向量检索的历史片段。 */
export interface HistoryChunk {
  id: string;
  turnId: string;
  sessionId: string;
  role: ChatTurn["role"];
  content: string;
  contentHash: string;
  createdAt: string;
  /**
   * 会话内轮次序号（单调递增），用于「离本次轮次近的排前面」排序。
   * 由 store 在归档时分配（`MAX(turn_index)+1`），保证不受历史压缩/截断影响。
   */
  turnIndex: number;
}

/**
 * 向量召回命中：在 HistoryChunk 之上附带 [0,1] 相关度。
 * score 越高越相关；调用方应按 score 降序，并丢弃低于阈值（如 0.6）的命中。
 */
export interface HistorySearchHit extends HistoryChunk {
  /** 与查询向量的相关度，范围约 [0,1]；1 表示最相似。 */
  score: number;
}

/**
 * 待归档的历史片段（尚未分配 turnIndex）。
 * 与 `HistoryChunk` 分离，因为 turnIndex 只能由 store 在写入时单调分配，
 * 调用方传入的数组下标会因历史压缩而漂移。
 */
export type HistoryChunkInput = Omit<HistoryChunk, "turnIndex">;

/** 文本 → 向量。实现侧懒加载 embedding 模型（bge-small-zh-v1.5，512 维）。 */
export interface EmbeddingService {
  embed(text: string): Promise<Float32Array>;
}

/** 向量存储：写入去重归档 + 余弦相似度 top-K 召回。 */
export interface HistoryRecallHit {
  turnIndex: number;
  role: ChatTurn["role"];
  content: string;
  score: number;
}

export async function searchHistory(
  embedding: EmbeddingService,
  store: HistoryVectorStore,
  query: string,
  sessionId: string | null | undefined,
  topK: number,
  beforeTurnIndex?: number,
): Promise<HistoryRecallHit[]> {
  const text = query.trim();
  if (!text || !sessionId) return [];
  const queryVector = await embedding.embed(text);
  const candidateLimit = beforeTurnIndex === undefined ? topK : Math.max(topK, 1000);
  return store.search(queryVector, candidateLimit, sessionId, beforeTurnIndex)
    .filter((hit) => hit.turnId.startsWith(`round:${sessionId}:`))
    .slice(0, topK)
    .map((hit) => ({
      turnIndex: hit.turnIndex,
      role: hit.role,
      content: hit.content,
      score: hit.score,
    }));
}

export interface HistoryVectorStore {
  /**
   * 归档一个 chunk 及其向量；实现侧按 contentHash 去重（相同则跳过）。
   * turnIndex 由实现侧在写入时分配（`MAX(turn_index)+1`），忽略调用方任何下标。
   */
  archive(chunk: HistoryChunkInput, vector: Float32Array): void;
  /** 是否已归档该 contentHash（供调用方在 embed 前跳过重复推理）。 */
  hasContentHash(contentHash: string): boolean;
  /**
   * 余弦相似度 top-K 召回。sessionId 可选（null 表示不限会话）；
   * 返回按 score 降序（等价于 distance ASC）；score = clamp(1 - distance, 0, 1)。
   */
  search(
    queryVector: Float32Array,
    topK: number,
    sessionId?: string | null,
    beforeTurnIndex?: number,
  ): HistorySearchHit[];
  /**
   * 该会话已归档的 chunk 数量。用于「归档覆盖率检测」：升级前的历史轮次
   * 未归档时，向量召回只能覆盖极少量片段，此时应回退到「最近 N 轮 → LLM 过滤」。
   */
  countBySession(sessionId: string): number;
  /** 删除某会话的全部归档向量；会话删除时调用。 */
  deleteBySession(sessionId: string): void;
}

/** Compact round payload used for semantic recall without exposing raw turn output. */
export interface HistoryRoundInput {
  sessionId: string;
  roundIndex?: number;
  userInput: string;
  // taskDecompose 已移除：不再索引任务分解结果，避免历史信息膨胀
  assistantReport?: string;
  /**
   * 凭证信息（精简）：只保留定位元数据，不写入 excerpt / fileEvidence 全文，
   * 避免向量归档体积膨胀。
   */
  evidence?: ReadonlyArray<{
    needId?: string;
    summary: string;
    kind?: "source" | "navigation";
    path?: string;
    symbol?: string;
    startLine?: number;
    endLine?: number;
  }>;
  /** 工具调用信息：只记名称与参数，不记返回结果。 */
  toolCalls?: ReadonlyArray<{
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
}

/** 计算内容哈希（去重依据；非 LLM）。 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * 将一个 turn 归档为一个 chunk（纯函数：无 LLM、无 embedding、无 native 依赖）。
 *
 * 调用方在 turn 结束时调用，并自行决定是否去重（contentHash 相同则跳过）。
 * 返回 null 表示该 turn 无内容可归档。
 */
export function archiveTurn(
  turn: ChatTurn,
  opts: { sessionId: string; turnId: string },
): HistoryChunkInput | null {
  if (!turn.content) return null;
  return {
    id: computeContentHash(`${opts.sessionId}:${opts.turnId}:${turn.role}:${turn.content}`),
    turnId: opts.turnId,
    sessionId: opts.sessionId,
    role: turn.role,
    content: turn.content,
    contentHash: computeContentHash(turn.content),
    createdAt: new Date().toISOString(),
  };
}

/** 向量召回相关度下限：低于此值的历史片段丢弃（60%）。 */
export const HISTORY_MIN_RELEVANCE_SCORE = 0.6;

/**
 * 召回结果两两去重阈值：达到该 Jaccard 相似度视为近重复，只保留更新的一轮。
 * 与 minimum-context 的冗余判定同量级，避免误删「相关但内容不同」的轮次。
 */
export const HISTORY_NEAR_DUPLICATE_THRESHOLD = 0.88;

/** 召回条目上用于判断「是否同一轮 / 哪一轮更新」的字段。 */
export interface HistoryRecencyFields {
  content: string;
  turnIndex: number;
  createdAt?: string;
  turnId?: string;
  id?: string;
}

/**
 * 从归档正文抽出用于近重复比较的文本。
 * 优先用 userInput + 报告 + 分解（忽略 JSON 键名膨胀）；旧版纯文本归档则用原文。
 */
export function comparableHistoryText(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      const round = parsed as Record<string, unknown>;
      const parts = [round.userInput, round.llmReport, round.taskDecomposition]
        .map((value) => {
          if (typeof value === "string") return value;
          if (value == null) return "";
          return JSON.stringify(value);
        })
        .filter((value) => value.trim().length > 0);
      if (parts.length > 0) return parts.join("\n");
    }
  } catch {
    // Older archived chunks are plain text.
  }
  return content;
}

/** 词袋 Jaccard 相似度，范围 [0, 1]。空文本视为不相似，避免误伤。 */
export function historyTextSimilarity(left: string, right: string): number {
  const a = historyTokenSet(left);
  const b = historyTokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

/**
 * 召回结果近重复去重：两条历史文本相似度 ≥ 阈值时只留最近一轮，正文不裁剪。
 * 保留项维持输入顺序（通常是查询相关度降序），不回填被丢弃名次之后的命中。
 */
export function dedupeSimilarHistoryHits<T extends HistoryRecencyFields>(
  hits: readonly T[],
  threshold = HISTORY_NEAR_DUPLICATE_THRESHOLD,
): T[] {
  if (hits.length <= 1) return hits.slice();

  const newestFirst = hits
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) => {
      const recency = compareHistoryRecency(b.hit, a.hit);
      if (recency !== 0) return recency;
      return a.index - b.index;
    });

  const kept = new Set<T>();
  const keptTexts: string[] = [];
  for (const { hit } of newestFirst) {
    const text = comparableHistoryText(hit.content);
    const duplicate = keptTexts.some((existing) => historyTextSimilarity(text, existing) >= threshold);
    if (duplicate) continue;
    kept.add(hit);
    keptTexts.push(text);
  }

  return hits.filter((hit) => kept.has(hit));
}

/**
 * 召回后处理（recall_history 与任务分解共用）：
 * 先丢掉相关性 < 60% 的条目，再对剩余结果做近重复去重（高相似只留最近一轮）。
 * 保留项维持相关度降序，正文不裁剪。
 */
export function finalizeRecalledHistoryHits<T extends HistoryRecencyFields & { score?: number }>(
  hits: readonly T[],
  minScore = HISTORY_MIN_RELEVANCE_SCORE,
): T[] {
  const relevant = hits
    .filter((item) => typeof item.score === "number" && Number.isFinite(item.score) && item.score >= minScore)
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return dedupeSimilarHistoryHits(relevant);
}

function historyTokenSet(text: string, maxTokens = 512): Set<string> {
  const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
  const set = new Set<string>();
  for (const token of tokens) {
    if (token.length < 2) continue;
    set.add(token);
    if (set.size >= maxTokens) break;
  }
  return set;
}

/** 越大越新：优先 turnIndex（归档单调序号），其次 createdAt，再次 turnId/id。 */
function compareHistoryRecency(left: HistoryRecencyFields, right: HistoryRecencyFields): number {
  if (left.turnIndex !== right.turnIndex) return left.turnIndex - right.turnIndex;
  const leftAt = Date.parse(left.createdAt ?? "") || 0;
  const rightAt = Date.parse(right.createdAt ?? "") || 0;
  if (leftAt !== rightAt) return leftAt - rightAt;
  const leftId = left.turnId || left.id || "";
  const rightId = right.turnId || right.id || "";
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
