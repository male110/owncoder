/**
 * 历史向量检索的 native 实现（Electron main 进程）。
 *
 * - embedding：共享 bge-small INT8 单例，见 embedding-service.ts——与代码
 *   语义索引共用同一个 ONNX 会话，每进程只加载一次。
 * - 存储：`sqlite-vec`（better-sqlite3 loadable extension），余弦相似度 top-K。
 *
 * 该模块暴露一个工厂，返回 `AgentLoopOpts["historyVector"]` 结构，
 * 由 `main/index.ts` 在启动时通过 `session.setHistoryVector(...)` 注入。
 *
 * 失败降级：任一环节（本地模型缺失 / sqlite-vec 加载失败）抛出异常，
 * 调用方捕获后跳过注入，`history_compact` 自动退回「最近 N 轮 → LLM 过滤」。
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type {
  AgentLoopOpts,
  HistoryChunk,
  HistoryChunkInput,
  HistoryRoundInput,
  HistorySearchHit,
  HistoryVectorStore,
} from "@owncoder/core";
import { EMBEDDING_DIM, getSharedEmbeddingService } from "./embedding-service.ts";
/** 防止单个长会话让 sqlite-vec 和 native embedding 内存无界增长。 */
const MAX_CHUNKS_PER_SESSION = 1000;
/** 单会话归档内容总量上限（UTF-8 字节）。超限时淘汰最旧 chunk，不截断当前正文。 */
const MAX_SESSION_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_ARCHIVES = 8;

class SqliteVecHistoryStore implements HistoryVectorStore {
  private db: Database.Database;
  private insertVecStmt: Database.Statement;
  private insertMetaStmt: Database.Statement;
  private searchStmt: Database.Statement;
  private searchBeforeTurnStmt: Database.Statement;
  private existsStmt: Database.Statement;
  private countStmt: Database.Statement;
  private nextTurnIndexStmt: Database.Statement;
  private oldestStmt: Database.Statement;
  private deleteVecStmt: Database.Statement;
  private deleteMetaStmt: Database.Statement;
  private deleteSessionMetaStmt: Database.Statement;
  private sessionRowidsStmt: Database.Statement;
  private sessionBytesStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);

    // vec0 虚拟表只存向量（512 维，余弦相似度）。metadata 存独立普通表，
    // 通过 rowid 关联。原因：vec0 的辅助列（`+` 前缀）不能用于 KNN 查询的
    // WHERE 约束（实测报 "illegal WHERE constraint on vec0 auxiliary column"），
    // 而 sessionId 过滤 + turnIndex 排序必须在 KNN 结果上做，故用 JOIN 方案。
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS history_chunks_vec USING vec0(
        embedding float[${EMBEDDING_DIM}] distance_metric=cosine
      );
      CREATE TABLE IF NOT EXISTS history_chunks_meta(
        rowid INTEGER PRIMARY KEY,
        id text,
        turn_id text,
        session_id text,
        role text,
        content text,
        content_hash text,
        created_at text,
        turn_index integer
      );
      CREATE INDEX IF NOT EXISTS idx_history_chunks_meta_hash
        ON history_chunks_meta(content_hash);
      CREATE INDEX IF NOT EXISTS idx_history_chunks_meta_session
        ON history_chunks_meta(session_id, turn_index);
    `);

    this.insertVecStmt = this.db.prepare(
      `INSERT INTO history_chunks_vec(embedding) VALUES (?)`,
    );
    this.insertMetaStmt = this.db.prepare(`
      INSERT INTO history_chunks_meta(rowid, id, turn_id, session_id, role, content, content_hash, created_at, turn_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.searchStmt = this.db.prepare(`
      SELECT m.id, m.turn_id, m.session_id, m.role, m.content, m.content_hash, m.created_at, m.turn_index, k.distance
      FROM (
        SELECT rowid, distance
        FROM history_chunks_vec
        WHERE embedding MATCH ? AND k = ?
      ) k
      JOIN history_chunks_meta m ON m.rowid = k.rowid
      WHERE (? IS NULL OR m.session_id = ?)
      ORDER BY k.distance ASC
    `);
    this.searchBeforeTurnStmt = this.db.prepare(`
      SELECT m.id, m.turn_id, m.session_id, m.role, m.content, m.content_hash, m.created_at, m.turn_index, k.distance
      FROM (
        SELECT rowid, distance
        FROM history_chunks_vec
        WHERE embedding MATCH ? AND k = ?
      ) k
      JOIN history_chunks_meta m ON m.rowid = k.rowid
      WHERE (? IS NULL OR m.session_id = ?)
        AND m.turn_index < ?
      ORDER BY k.distance ASC
    `);
    this.existsStmt = this.db.prepare(
      `SELECT 1 FROM history_chunks_meta WHERE content_hash = ? LIMIT 1`,
    );
    this.countStmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM history_chunks_meta WHERE session_id = ?`,
    );
    this.nextTurnIndexStmt = this.db.prepare(
      `SELECT COALESCE(MAX(turn_index), -1) + 1 AS next FROM history_chunks_meta WHERE session_id = ?`,
    );
    this.oldestStmt = this.db.prepare(
      `SELECT rowid FROM history_chunks_meta WHERE session_id = ? ORDER BY turn_index ASC LIMIT 1`,
    );
    this.deleteVecStmt = this.db.prepare(`DELETE FROM history_chunks_vec WHERE rowid = ?`);
    this.deleteMetaStmt = this.db.prepare(`DELETE FROM history_chunks_meta WHERE rowid = ?`);
    this.sessionRowidsStmt = this.db.prepare(
      `SELECT rowid FROM history_chunks_meta WHERE session_id = ?`,
    );
    this.deleteSessionMetaStmt = this.db.prepare(
      `DELETE FROM history_chunks_meta WHERE session_id = ?`,
    );
    this.sessionBytesStmt = this.db.prepare(
      `SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS n FROM history_chunks_meta WHERE session_id = ?`,
    );
  }

  hasContentHash(contentHash: string): boolean {
    return this.existsStmt.get(contentHash) !== undefined;
  }

  /**
   * 会话内序号分配（独立函数）：`MAX(turn_index)+1`。
   * 事务仅保证「read-modify-write 不重复分配序号」（better-sqlite3 同步执行，
   * 事务期间不被打断）；但归档的「先后顺序」由 createHistoryVector 里的串行队列
   * archiveChain 保证，与本函数无关——本函数只负责在写入点原子地取下一个序号。
   */
  private allocateTurnIndex(sessionId: string): number {
    const row = this.nextTurnIndexStmt.get(sessionId) as { next: number };
    return row.next;
  }

  archive(chunk: HistoryChunkInput, vector: Float32Array): void {
    if (this.hasContentHash(chunk.contentHash)) return;
    const insert = this.db.transaction(() => {
      // 序号分配 + 写入同事务：MAX+1 的 read-modify-write 原子完成，保证不重复。
      // 单调递增由调用方（createHistoryVector 的串行队列）保证按调用顺序串行归档；
      // 且序号不再来自调用方传入的数组下标（历史压缩后漂移），而是 store 内部计算。
      const turnIndex = this.allocateTurnIndex(chunk.sessionId);
      const r = this.insertVecStmt.run(vector);
      this.insertMetaStmt.run(
        r.lastInsertRowid,
        chunk.id,
        chunk.turnId,
        chunk.sessionId,
        chunk.role,
        chunk.content,
        chunk.contentHash,
        chunk.createdAt,
        turnIndex,
      );
      while (
        this.countBySession(chunk.sessionId) > MAX_CHUNKS_PER_SESSION ||
        this.sessionBytes(chunk.sessionId) > MAX_SESSION_CONTENT_BYTES
      ) {
        const oldest = this.oldestStmt.get(chunk.sessionId) as { rowid: number } | undefined;
        if (!oldest) break;
        // vec0 与 metadata 必须成对删除，否则 KNN 结果会留下悬空 rowid。
        this.deleteVecStmt.run(oldest.rowid);
        this.deleteMetaStmt.run(oldest.rowid);
      }
    });
    insert();
  }

  search(queryVector: Float32Array, topK: number, sessionId?: string | null, beforeTurnIndex?: number): HistorySearchHit[] {
    const stmt = typeof beforeTurnIndex === "number" && Number.isFinite(beforeTurnIndex)
      ? this.searchBeforeTurnStmt
      : this.searchStmt;
    const rows = (typeof beforeTurnIndex === "number" && Number.isFinite(beforeTurnIndex)
      ? stmt.all(queryVector, topK, sessionId ?? null, sessionId ?? null, Math.max(0, Math.floor(beforeTurnIndex)))
      : stmt.all(queryVector, topK, sessionId ?? null, sessionId ?? null)) as Array<{
      id: string;
      turn_id: string;
      session_id: string;
      role: HistoryChunk["role"];
      content: string;
      content_hash: string;
      created_at: string;
      turn_index: number;
      distance: number;
    }>;
    return rows.map((r) => {
      // sqlite-vec cosine distance: 0 = identical, larger = less similar.
      // Convert to [0,1] relevance so callers can threshold (e.g. drop < 0.6).
      const distance = typeof r.distance === "number" && Number.isFinite(r.distance) ? r.distance : 1;
      const score = Math.max(0, Math.min(1, 1 - distance));
      return {
        id: r.id,
        turnId: r.turn_id,
        sessionId: r.session_id,
        role: r.role,
        content: r.content,
        contentHash: r.content_hash,
        createdAt: r.created_at,
        turnIndex: r.turn_index,
        score,
      };
    });
  }

  countBySession(sessionId: string): number {
    const row = this.countStmt.get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  deleteBySession(sessionId: string): void {
    const drop = this.db.transaction(() => {
      const rows = this.sessionRowidsStmt.all(sessionId) as Array<{ rowid: number }>;
      for (const row of rows) {
        this.deleteVecStmt.run(row.rowid);
      }
      this.deleteSessionMetaStmt.run(sessionId);
    });
    drop();
  }

  private sessionBytes(sessionId: string): number {
    const row = this.sessionBytesStmt.get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 创建历史向量检索基础设施。任何失败都抛出，调用方负责捕获并降级。
 */
export function createHistoryVector(dbPath: string): AgentLoopOpts["historyVector"] {
  const embedding = getSharedEmbeddingService();
  const store = new SqliteVecHistoryStore(dbPath);

  // 使用显式 FIFO worker，避免永久增长的 Promise 链保留每一轮的闭包和 turn 内容。
  type HistoryArchive = NonNullable<NonNullable<AgentLoopOpts["historyVector"]>["archive"]>;
  const pending: Array<{ turn: Parameters<HistoryArchive>[0]; sessionId: string }> = [];
  let draining = false;
  let closed = false;
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const item = pending.shift()!;
        try {
          const { archiveTurn } = await import("@owncoder/core");
          const chunk = archiveTurn(item.turn, {
            sessionId: item.sessionId,
            turnId: item.turn.id ?? `${item.sessionId}:${item.turn.role}:${item.turn.content.slice(0, 32)}`,
          });
          if (!chunk || store.hasContentHash(chunk.contentHash)) continue;
          const vector = await embedding.embed(chunk.content);
          store.archive(chunk, vector);
        } catch (error) {
          console.warn("[history_vector] 归档失败:", error);
        }
      }
    } finally {
      draining = false;
      if (pending.length > 0) void drain();
    }
  };

  return {
    embedding,
    store,
    topK: 5,
    archive: (turn, sessionId) => {
      if (closed || !turn.content || pending.length >= MAX_PENDING_ARCHIVES) {
        if (pending.length >= MAX_PENDING_ARCHIVES) {
          console.warn(`[history_vector] 归档积压，跳过本轮（pending=${pending.length}）`);
        }
        return;
      }
      pending.push({ turn, sessionId });
      void drain();
    },
    archiveRound: (round: HistoryRoundInput) => {
      // 只归档：用户输入、任务分解、最终报告、凭证信息、工具调用参数（不含返回结果）。
      const content = JSON.stringify({
        userInput: round.userInput,
        taskDecomposition: round.taskDecompose ?? null,
        llmReport: round.assistantReport?.trim() || null,
        evidence: round.evidence?.map((item) => ({
          needId: item.needId,
          summary: item.summary,
          kind: item.kind,
          path: item.path,
          symbol: item.symbol,
          startLine: item.startLine,
          endLine: item.endLine,
        })) ?? [],
        toolCalls: round.toolCalls?.map((call) => ({
          toolName: call.toolName,
          arguments: call.arguments,
        })) ?? [],
      });
      if (closed || !content.trim() || pending.length >= MAX_PENDING_ARCHIVES) return;
      pending.push({
        sessionId: round.sessionId,
        turn: {
          id: `round:${round.sessionId}:${round.roundIndex ?? Date.now().toString(36)}`,
          role: "assistant",
          content,
        },
      });
      void drain();
    },
    deleteSession: (sessionId: string) => {
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i]?.sessionId === sessionId) pending.splice(i, 1);
      }
      store.deleteBySession(sessionId);
    },
    close: () => {
      closed = true;
      pending.length = 0;
      store.close();
    },
  };
}
