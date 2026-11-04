/**
 * 后置语义通道（代码语义索引的构建侧）。
 *
 * 挂在构建管道之后（adapter.open 的 build 分支 / flushDirty / rebuildAll），
 * 与符号索引同一 SQLite 库、同一进程（index-worker 独占可写连接）。
 * 嵌入器与 vec0 表创建均以端口注入（SemanticEmbedder / ensureVecTable），
 * 本模块不依赖 onnxruntime / sqlite-vec——packages/index 保持零新依赖，
 * CLI 场景无端口即整条通道跳过。
 *
 * 增量策略：files.hash 与 code_chunks_state.file_hash 水位比对，
 * 只重嵌入变更文件；已从 files 表消失的文件的孤儿 chunk 级联清理。
 *
 * chunk 粒度：符号级（qualified_name + signature + doc + 正文摘录，
 * ≤ chunkMaxChars），无符号表行的文件退化为单个文件级 chunk。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/** 批量嵌入端口（桌面端由 BgeEmbeddingService 实现，INT8 bge-small，512 维）。 */
export interface SemanticEmbedder {
  embedBatch(texts: string[]): Promise<Array<Float32Array | number[]>>;
}

export interface SemanticIndexOptions {
  embedder: SemanticEmbedder;
  /** 每文件进度回调（done/total/file），复用索引 progress 协议风格。 */
  onProgress?: (done: number, total: number, file: string) => void;
  /** 单文件 chunk 上限（防病态文件）。默认 200。 */
  maxChunksPerFile?: number;
  /** 嵌入批次大小（跨文件凑批，ONNX 利用率高）。默认 32。 */
  embedBatchSize?: number;
  /** 单 chunk 嵌入文本字符上限。默认 1200。 */
  chunkMaxChars?: number;
  /**
   * 创建 vec0 表（幂等）——调用方须已在本连接注册 sqlite-vec 模块
   * （适配器仅在 vecLoaded 为真时传入）。缺省时仅写 code_chunks meta 与
   * 水位（无向量）：ragSearch 无从命中，消费方回退 FTS。index 包测试
   * 走无 vec 分支（该包不引入 sqlite-vec 依赖）。
   */
  ensureVecTable?: (db: Database.Database) => void;
}

export interface SemanticIndexStats {
  filesEmbedded: number;
  chunksWritten: number;
  chunksSkipped: number;
}

/** bge-small-zh-v1.5 输出维度；vec0 表与此处双重硬编码，端口契约的一部分。 */
export const SEMANTIC_EMBED_DIM = 512;

const DEFAULT_MAX_CHUNKS_PER_FILE = 200;
const DEFAULT_EMBED_BATCH_SIZE = 32;
const DEFAULT_CHUNK_MAX_CHARS = 1200;

interface SymbolRow {
  name: string;
  qualified_name: string | null;
  kind: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  doc: string | null;
}

interface Chunk {
  symbol_name: string | null;
  qualified_name: string;
  kind: string;
  start_line: number;
  end_line: number;
  content: string;
}

interface PendingFile {
  path: string;
  fileHash: string;
  chunks: Chunk[];
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export const toFloat32 = (v: Float32Array | number[]): Float32Array =>
  v instanceof Float32Array ? v : Float32Array.from(v);

/**
 * 符号级切片：符号表行范围 + 前缀（限定名/签名/doc）拼出嵌入文本。
 * 无符号表行的文件退化为单个文件级 chunk（MD/JSON/不支持的语言）。
 */
function sliceFileChunks(
  path: string,
  content: string,
  symbols: SymbolRow[],
  maxChunks: number,
  maxChars: number,
): Chunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: Chunk[] = [];
  for (const sym of symbols) {
    if (chunks.length >= maxChunks) break;
    const start = Math.max(1, Math.floor(sym.start_line) || 1);
    const end = Math.max(start, Math.floor(sym.end_line ?? start));
    const parts = [sym.qualified_name ?? sym.name];
    if (sym.signature) parts.push(sym.signature);
    if (sym.doc) parts.push(sym.doc);
    const prefix = parts.join("\n");
    const bodyBudget = Math.max(0, maxChars - prefix.length - 1);
    const body = lines.slice(start - 1, end).join("\n").slice(0, bodyBudget);
    const text = body.trim() ? `${prefix}\n${body}` : prefix;
    if (text.trim().length < 8) continue; // 太短无嵌入价值（噪声符号）
    chunks.push({
      symbol_name: sym.name,
      qualified_name: sym.qualified_name ?? sym.name,
      kind: sym.kind,
      start_line: start,
      end_line: end,
      content: text.slice(0, maxChars),
    });
  }
  if (chunks.length === 0 && content.trim().length > 0) {
    chunks.push({
      symbol_name: null,
      qualified_name: path,
      kind: "file",
      start_line: 1,
      end_line: Math.min(lines.length, 400),
      content: `${path}\n${content.slice(0, maxChars)}`,
    });
  }
  return chunks;
}

/**
 * reconcile 语义索引：水位比对 → 变更文件切片 → 全局批量嵌入 → 逐文件事务写库。
 *
 * 任一文件/批次失败不拖垮整体（日志 + 跳过；文件级水位仅在事务提交时推进，
 * 读取失败的文件下轮重试）。返回统计，调用方用于日志与 progress。
 */
export async function buildSemanticIndex(
  db: Database.Database,
  root: string,
  opts: SemanticIndexOptions,
): Promise<SemanticIndexStats> {
  const maxChunks = opts.maxChunksPerFile ?? DEFAULT_MAX_CHUNKS_PER_FILE;
  const batchSize = opts.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE;
  const maxChars = opts.chunkMaxChars ?? DEFAULT_CHUNK_MAX_CHARS;
  const withVec = Boolean(opts.ensureVecTable);

  if (opts.ensureVecTable) opts.ensureVecTable(db);

  // 孤儿清理：文件已从 files 表消失（删除/重命名），chunk/vec/水位级联删除。
  // 顺序：先删 vec（子查询还依赖 code_chunks），再删 meta 与水位。
  if (withVec) {
    db.exec(
      `DELETE FROM code_chunks_vec WHERE rowid IN
         (SELECT c.id FROM code_chunks c LEFT JOIN files f ON f.path = c.path WHERE f.id IS NULL)`,
    );
  }
  db.exec(`DELETE FROM code_chunks WHERE path NOT IN (SELECT path FROM files)`);
  db.exec(`DELETE FROM code_chunks_state WHERE path NOT IN (SELECT path FROM files)`);

  // 水位比对：未嵌入或文件 hash 变化的文件需要（重新）嵌入。
  const pending = db
    .prepare(
      `SELECT f.path, f.hash
       FROM files f
       LEFT JOIN code_chunks_state s ON s.path = f.path
       WHERE s.path IS NULL OR s.file_hash IS NULL OR s.file_hash != f.hash`,
    )
    .all() as Array<{ path: string; hash: string }>;

  const stats: SemanticIndexStats = { filesEmbedded: 0, chunksWritten: 0, chunksSkipped: 0 };
  if (pending.length === 0) return stats;

  const symbolStmt = db.prepare(
    `SELECT s.name, s.qualified_name, s.kind, s.start_line, s.end_line, s.signature, s.doc
     FROM symbols s JOIN files f ON s.file_id = f.id
     WHERE f.path = ? ORDER BY s.start_line`,
  );

  // Pass 1：读源码 + 按符号表行范围切片（跨文件收集，最后统一批量嵌入）。
  const pendingFiles: PendingFile[] = [];
  const watermarkOnly: Array<{ path: string; hash: string }> = [];
  for (const file of pending) {
    let content: string;
    try {
      content = await fs.readFile(join(root, file.path), "utf8");
    } catch {
      continue; // 源码已删/不可读：水位不动，下轮 reconcile 重试
    }
    const chunks = sliceFileChunks(
      file.path,
      content,
      symbolStmt.all(file.path) as SymbolRow[],
      maxChunks,
      maxChars,
    );
    if (chunks.length > 0) {
      pendingFiles.push({ path: file.path, fileHash: file.hash, chunks });
    } else {
      // 可读但无可嵌入内容（空文件/纯空白）：写水位跳过，避免每轮重试。
      watermarkOnly.push({ path: file.path, hash: file.hash });
    }
  }

  // Pass 2：全局批量嵌入（跨文件凑批，ONNX 利用率高）。
  const allChunks: Array<{ file: PendingFile; chunk: Chunk }> = [];
  for (const file of pendingFiles) {
    for (const chunk of file.chunks) allChunks.push({ file, chunk });
  }
  const vectors = new Array<Float32Array | null>(allChunks.length).fill(null);
  for (let i = 0; i < allChunks.length; i += batchSize) {
    const batch = allChunks.slice(i, i + batchSize);
    try {
      const embedded = await opts.embedder.embedBatch(batch.map((entry) => entry.chunk.content));
      for (let j = 0; j < batch.length; j++) {
        const v = embedded[j];
        if (v && toFloat32(v).length === SEMANTIC_EMBED_DIM) {
          vectors[i + j] = toFloat32(v);
        } else {
          stats.chunksSkipped++;
        }
      }
    } catch (error) {
      console.error(`[semantic-index] embedBatch failed (batch at ${i}), skipping:`, error);
      stats.chunksSkipped += batch.length;
    }
  }

  // Pass 3：逐文件事务写库（vec 先插入取隐式 rowid，meta 显式以它为 id 对齐——
  // vec0 不接受显式 rowid 插入（sqlite-vec 0.1.9），与 history_chunks 同方案）。
  const insertChunk = db.prepare(
    `INSERT INTO code_chunks (id, path, symbol_name, qualified_name, kind, start_line, end_line, content, content_hash, file_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertVec = withVec
    ? db.prepare(`INSERT INTO code_chunks_vec(embedding) VALUES (?)`)
    : undefined;
  const deleteFileVec = withVec
    ? db.prepare(`DELETE FROM code_chunks_vec WHERE rowid IN (SELECT id FROM code_chunks WHERE path = ?)`)
    : undefined;
  const deleteFileChunks = db.prepare(`DELETE FROM code_chunks WHERE path = ?`);
  const upsertState = db.prepare(
    `INSERT INTO code_chunks_state (path, file_hash, embedded_at) VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET file_hash = excluded.file_hash, embedded_at = excluded.embedded_at`,
  );

  let chunkCursor = 0;
  const now = Date.now();
  for (const file of pendingFiles) {
    const write = db.transaction(() => {
      deleteFileVec?.run(file.path);
      deleteFileChunks.run(file.path);
      for (const chunk of file.chunks) {
        const vector = vectors[chunkCursor++];
        if (!vector) continue; // 嵌入失败/维度不符的 chunk 跳过
        const contentHash = sha256(chunk.content);
        const vecRowid = insertVec ? Number(insertVec.run(vector).lastInsertRowid) : null;
        insertChunk.run(
          vecRowid, // null → AUTOINCREMENT 自动分配（无 vec 分支）
          file.path,
          chunk.symbol_name,
          chunk.qualified_name,
          chunk.kind,
          chunk.start_line,
          chunk.end_line,
          chunk.content,
          contentHash,
          file.fileHash,
          now,
        );
        stats.chunksWritten++;
      }
      upsertState.run(file.path, file.fileHash, now);
    });
    write();
    stats.filesEmbedded++;
    opts.onProgress?.(stats.filesEmbedded, pendingFiles.length, file.path);
  }

  if (watermarkOnly.length > 0) {
    const tx = db.transaction(() => {
      for (const w of watermarkOnly) upsertState.run(w.path, w.hash, now);
    });
    tx();
  }

  return stats;
}
