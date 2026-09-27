/**
 * 历史向量检索的 native 实现（Electron main 进程）。
 *
 * - embedding：`onnxruntime-node` + INT8 量化 `bge-small-zh-v1.5`（512 维，中文）。
 *   使用 INT8 量化模型替代原 @xenova/transformers 的 FP32 模型，
 *   内存占用从 ~800MB 降至 ~100-200MB。
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
import * as ort from "onnxruntime-node";
import { Tokenizer } from "@huggingface/tokenizers";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import type {
  AgentLoopOpts,
  EmbeddingService,
  HistoryChunk,
  HistoryChunkInput,
  HistoryRoundInput,
  HistorySearchHit,
  HistoryVectorStore,
} from "@owncoder/core";

const DIM = 512;
/** bge-small-zh-v1.5 / BERT 位置编码上限；超长序列必须截断，否则 ONNX Add 广播失败（如 512 by 577）。 */
const MAX_SEQ_LEN = 512;
/** 防止单个长会话让 sqlite-vec 和 native embedding 内存无界增长。 */
const MAX_CHUNKS_PER_SESSION = 1000;
/** 单会话归档内容总量上限（UTF-8 字节）。超限时淘汰最旧 chunk，不截断当前正文。 */
const MAX_SESSION_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_ARCHIVES = 8;

let cacheDir = "";

/**
 * 配置本地模型目录。
 * 目录中必须包含以下文件：
 *   - tokenizer.json
 *   - onnx/model_quantized.onnx（INT8 量化版 bge-small-zh-v1.5）
 *
 * 模型获取方式（二选一）：
 *   1. 从 HuggingFace 手动下载：
 *      https://huggingface.co/Xenova/bge-small-zh-v1.5/tree/main
 *   2. 使用 optimum-cli 导出 INT8 量化版后放入对应子目录。
 */
export function configureEmbeddingCacheDir(dir: string): void {
  cacheDir = dir;
}

/**
 * 校验本地模型文件是否存在。缺失时抛出明确错误。
 */
function resolveLocalModelFiles(): {
  modelPath: string;
  tokenizerPath: string;
} {
  if (!cacheDir) {
    throw new Error(
      "[history-vector] 未配置模型目录，请先调用 configureEmbeddingCacheDir()",
    );
  }

  const tokenizerPath = path.join(cacheDir, "tokenizer.json");

  // 兼容两种文件名：优先 model_quantized.onnx，回退 model_int8.onnx
  const onnxDir = path.join(cacheDir, "onnx");
  const modelQuantized = path.join(onnxDir, "model_quantized.onnx");
  const modelInt8 = path.join(onnxDir, "model_int8.onnx");
  const modelPath = fsSync.existsSync(modelQuantized)
    ? modelQuantized
    : fsSync.existsSync(modelInt8)
      ? modelInt8
      : modelQuantized; // 都不存在时指向标准名称，下面报错

  const missing: string[] = [];
  if (!fsSync.existsSync(tokenizerPath)) missing.push("tokenizer.json");
  if (!fsSync.existsSync(modelPath)) missing.push("onnx/model_quantized.onnx 或 onnx/model_int8.onnx");

  if (missing.length > 0) {
    throw new Error(
      `[history-vector] 本地模型文件缺失: ${missing.join(", ")}\n` +
        `请将以下文件放入 ${cacheDir}:\n` +
        `  - tokenizer.json\n` +
        `  - onnx/model_quantized.onnx 或 onnx/model_int8.onnx\n` +
        `下载地址: https://huggingface.co/Xenova/bge-small-zh-v1.5/tree/main`,
    );
  }

  return { modelPath, tokenizerPath };
}

/**
 * 基于 onnxruntime-node + INT8 量化的 embedding 服务。
 *
 * 内存优势：
 * - INT8 量化模型仅 ~25MB（FP32 约 ~90MB）
 * - onnxruntime-node 使用原生 C++ 内存管理，不占用 V8 堆
 * - 无 JS 张量对象开销，推理完成后直接返回 Float32Array
 */
class BgeEmbeddingService implements EmbeddingService {
  private session: ort.InferenceSession | null = null;
  private tokenizer: Tokenizer | null = null;
  private initPromise: Promise<void> | null = null;

  private async ensureInit(): Promise<void> {
    if (this.session && this.tokenizer) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // 从本地加载模型文件（不做任何网络请求）
        const { modelPath, tokenizerPath } = resolveLocalModelFiles();

        console.log("[history-vector] 加载 INT8 ONNX 模型...");
        this.session = await ort.InferenceSession.create(modelPath, {
          // 限制推理线程数，避免 embedding 占满所有 CPU 核心
          intraOpNumThreads: 2,
          interOpNumThreads: 2,
          // 关闭 CPU 内存池，降低常驻内存占用（~50-100MB → 更低）
          enableCpuMemArena: false,
          // 基础图优化，平衡加载速度与推理性能
          graphOptimizationLevel: "basic",
        });
        console.log("[history-vector] ONNX 模型已加载（INT8 量化，2 线程，内存优化）");

        console.log("[history-vector] 加载 tokenizer...");
        const tokenizerJson = JSON.parse(
          await fs.readFile(tokenizerPath, "utf-8"),
        );
        this.tokenizer = new Tokenizer(tokenizerJson, {});
        console.log("[history-vector] Tokenizer 已加载");
      } catch (error) {
        // 重置，允许重试
        this.initPromise = null;
        throw error;
      }
    })();

    await this.initPromise;
  }

  async embed(text: string): Promise<Float32Array> {
    await this.ensureInit();

    // 1. Tokenize（add_special_tokens=true 添加 [CLS]/[SEP]）
    // @huggingface/tokenizers 的 encode 不支持 truncation；超长时需手动截断到模型上限。
    const encoding = this.tokenizer!.encode(text, { add_special_tokens: true });
    let inputIds: number[] = encoding.ids;
    let attentionMask: number[] = encoding.attention_mask;

    // BERT 位置编码表长度为 MAX_SEQ_LEN；保留 [CLS] + 正文 + [SEP]，截断中间正文。
    if (inputIds.length > MAX_SEQ_LEN) {
      const keep = MAX_SEQ_LEN - 1; // 预留末尾 [SEP]
      inputIds = inputIds.slice(0, keep).concat(inputIds[inputIds.length - 1]!);
      attentionMask = attentionMask.slice(0, keep).concat(attentionMask[attentionMask.length - 1]!);
    }
    const seqLen = inputIds.length;

    // 2. 创建 int64 张量（ONNX 模型期望 int64 输入）
    const inputIdsBigInt = new BigInt64Array(seqLen);
    const attentionMaskBigInt = new BigInt64Array(seqLen);
    const tokenTypeIdsBigInt = new BigInt64Array(seqLen);

    for (let i = 0; i < seqLen; i++) {
      inputIdsBigInt[i] = BigInt(inputIds[i]!);
      attentionMaskBigInt[i] = BigInt(attentionMask[i]!);
      tokenTypeIdsBigInt[i] = 0n; // 单句输入，token_type_ids 全为 0
    }

    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", inputIdsBigInt, [1, seqLen]),
      attention_mask: new ort.Tensor("int64", attentionMaskBigInt, [1, seqLen]),
      token_type_ids: new ort.Tensor("int64", tokenTypeIdsBigInt, [1, seqLen]),
    };

    // 3. ONNX 推理
    const results = await this.session!.run(feeds);

    // 获取输出张量（兼容不同的输出命名）
    const outputTensor =
      results.last_hidden_state ?? results[Object.keys(results)[0]];
    const hiddenState = outputTensor.data as Float32Array;

    // 4. Mean Pooling：按 attention_mask 加权平均所有 token 的嵌入
    const pooled = new Float32Array(DIM);
    let validTokens = 0;

    for (let t = 0; t < seqLen; t++) {
      if (attentionMask[t] === 0) continue;
      validTokens++;
      const offset = t * DIM;
      for (let d = 0; d < DIM; d++) {
        pooled[d] += hiddenState[offset + d];
      }
    }

    if (validTokens > 0) {
      for (let d = 0; d < DIM; d++) {
        pooled[d] /= validTokens;
      }
    }

    // 5. L2 归一化（与原 @xenova/transformers 的 normalize: true 行为一致）
    let norm = 0;
    for (let d = 0; d < DIM; d++) {
      norm += pooled[d] * pooled[d];
    }
    norm = Math.sqrt(norm);

    if (norm > 0) {
      for (let d = 0; d < DIM; d++) {
        pooled[d] /= norm;
      }
    }

    return pooled;
  }
}

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
        embedding float[${DIM}] distance_metric=cosine
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
  const embedding = new BgeEmbeddingService();
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
