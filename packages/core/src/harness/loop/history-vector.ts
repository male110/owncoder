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
  search(queryVector: Float32Array, topK: number, sessionId?: string | null): HistorySearchHit[];
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
  taskDecompose?: unknown;
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
