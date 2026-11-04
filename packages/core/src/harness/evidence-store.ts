/**
 * 单个顺序轮次内、面向最新源码读取的有界证据缓存。
 *
 * 按内容指纹（大小 / 修改时间）记账，保存在进程内存中：成功的读取按
 * 路径与范围缓存，只要文件指纹未变即可直接复用；写入会使相关条目失效。
 * 缓存同时受条目数量与输出总字节数上限约束。
 */

import type { ToolResult } from "./tools/types.ts";

/** 单条缓存读取：键 = 路径 + 范围，新鲜度事实 = size:mtimeMs。 */
export interface EvidenceReadEntry {
  key: string;
  path: string;
  rangeLabel: string;
  /** toolRead 计算的 `${stat.size}:${stat.mtimeMs}`——重放前比对，不等即失效。 */
  contentHash: string;
  result: ToolResult;
}

export interface EvidenceStoreOptions {
  /** Cached read entries limit (default 128). */
  maxFiles?: number;
  /** Cached output byte limit (default 8 MiB). */
  maxBytes?: number;
}

const DEFAULT_MAX_FILES = 128;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** 范围键：整文件读为 `path::all`，范围读为 `path::offset:limit`。 */
export function evidenceRangeKey(path: string, offset: number, limit: number): string {
  return offset > 0 && limit > 0 ? `${path}::${offset}:${limit}` : `${path}::all`;
}

export class EvidenceStore {
  private readonly reads = new Map<string, EvidenceReadEntry>();
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor(opts: EvidenceStoreOptions = {}) {
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * 查找缓存读取。命中且新鲜度事实一致时返回带重放标注的 ToolResult；
   * 未命中或文件已被修改（hash 不等）返回 null，调用方走正常磁盘读。
   */
  lookupRead(path: string, offset: number, limit: number, contentHash: string): ToolResult | null {
    const entry = this.reads.get(evidenceRangeKey(path, offset, limit));
    if (!entry || entry.contentHash !== contentHash) return null;
    return {
      ok: true,
      output:
        `[replayed from the current-turn evidence store — this range is unchanged; not re-read from disk]\n` +
        entry.result.output,
      metadata: entry.result.metadata ? { ...entry.result.metadata } : undefined,
    };
  }

  /** 记录一次成功读取（调用方在脱敏之后调用，缓存的是最终给模型的输出）。 */
  recordRead(path: string, offset: number, limit: number, contentHash: string, result: ToolResult): void {
    if (!result.ok) return;
    const key = evidenceRangeKey(path, offset, limit);
    const existing = this.reads.get(key);
    if (existing) {
      this.bytes -= existing.result.output.length;
      this.reads.delete(key);
    }
    const entry: EvidenceReadEntry = {
      key,
      path,
      rangeLabel: offset > 0 && limit > 0 ? `L${offset}-${offset + limit - 1}` : "whole file",
      contentHash,
      result,
    };
    this.reads.set(key, entry);
    this.bytes += result.output.length;
    // FIFO 淘汰：超文件数或超字节时从最旧开始逐出。
    while (this.reads.size > this.maxFiles || this.bytes > this.maxBytes) {
      const oldest = this.reads.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.reads.get(oldest);
      if (!evicted) break;
      this.bytes -= evicted.result.output.length;
      this.reads.delete(oldest);
    }
  }


  /** 写操作后使该路径的所有缓存范围失效（写后重读是合法需求）。 */
  invalidatePath(path: string): void {
    for (const key of [...this.reads.keys()]) {
      if (key.startsWith(`${path}::`)) {
        const entry = this.reads.get(key);
        if (entry) this.bytes -= entry.result.output.length;
        this.reads.delete(key);
      }
    }
  }

  /** 非只读 bash 后整板失效（bash 可写任意路径）。 */
  invalidateAll(): void {
    this.reads.clear();
    this.bytes = 0;
  }

}
