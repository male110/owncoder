/**
 * IndexClient 适配器 - 将 UnifiedIndex 适配到 IndexClient 接口
 *
 * 职责:
 * 1. 将 UnifiedIndex 的 SQLite 符号索引暴露为 IndexClient
 * 2. 管理 dirty 文件的增量重建
 * 3. 生成 repo map
 * 4. 提供 graph search
 */

import upath from "upath";
import type Database from "better-sqlite3";
import type {
  IndexClient,
  ManifestDiff,
  GraphResult,
  CallSite,
  RagHit,
  SymbolSearchResult,
  SearchOptions,
} from "../index.ts";
import type { IndexStatus, MapOpts, Tag } from "@owncoder/shared";
import { UnifiedIndex } from "./index.ts";
import { buildIndexAsync, updateIndexAsync } from "./builder.ts";
import { MAX_FILE_SIZE } from "./scanner.ts";

/**
 * 将 UnifiedIndex 包装为 IndexClient 接口
 */
export class UnifiedIndexAdapter implements IndexClient {
  private index: UnifiedIndex;
  private root: string | undefined;
  private kind: IndexStatus["kind"] = "idle";
  private dirtyPaths: Set<string> = new Set();
  private extraIgnore: string[] = [];
  private buildPromise: Promise<void> | null = null;
  private readonlyMode = false;

  constructor() {
    this.index = new UnifiedIndex();
  }

  async open(
    root: string,
    diff?: ManifestDiff,
    options?: { mode?: "query" | "build" },
  ): Promise<void> {
    this.root = root;
    const mode = options?.mode ?? (diff ? "build" : "query");
    this.readonlyMode = mode === "query";

    try {
      // Main process uses query mode (readonly). Worker uses build mode (writable).
      this.index.open(root, { readonly: this.readonlyMode });
      const db = this.index.getDatabase();
      if (!db) {
        if (this.readonlyMode) {
          this.kind = "idle";
          return;
        }
        throw new Error("Failed to initialize database");
      }

      if (this.readonlyMode) {
        const stats = this.index.getStats();
        this.kind = stats.files > 0 ? "ready" : "idle";
        return;
      }

      this.kind = "building";
      if (diff && (diff.added.length > 0 || diff.modified.length > 0 || diff.removed.length > 0)) {
        await this.doIncrementalBuild(db, root, diff);
      } else {
        const stats = this.index.getStats();
        if (stats.files === 0) {
          // First open: still use streaming builder; incremental flag only skips
          // work when metas match an existing DB.
          await this.doFullBuild(db, root);
        } else {
          // Recompute cheap meta diff inside builder; do not force full rewrite.
          await this.doIncrementalBuild(db, root, { added: [], modified: [], removed: [] });
        }
      }

      this.kind = "ready";
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[UnifiedIndexAdapter] open failed: ${errorMsg}`);
      this.kind = "error";
      throw error;
    }
  }

  async getTags(path: string): Promise<Tag[]> {
    const db = this.index.getDatabase();
    if (!db) return [];

    try {
      const rows = db
        .prepare(
          `SELECT s.name, s.kind, s.start_line, s.end_line
           FROM symbols s
           JOIN files f ON s.file_id = f.id
           WHERE f.path = ?
           ORDER BY s.start_line`
        )
        .all(path) as Array<{
        name: string;
        kind: string;
        start_line: number;
        end_line: number;
      }>;

      return rows.map((row) => ({
        path,
        name: row.name,
        kind: row.kind,
        line: row.start_line,
        endLine: row.end_line,
      }));
    } catch (error) {
      console.error(`[UnifiedIndexAdapter] getTags failed for ${path}:`, error);
      return [];
    }
  }

  async buildRepoMap(opts: MapOpts): Promise<string> {
    const db = this.index.getDatabase();
    if (!db || !this.root) {
      return "# Repo map (unified) — index not initialized\n";
    }

    // 刷新 dirty 文件
    await this.flushDirtyFiles();

    try {
      const tokenBudget = opts.mapTokens ?? 8000;
      const mentionedPaths = new Set(opts.mentionedPaths ?? []);
      const writablePaths = new Set(opts.writablePaths ?? []);

      // 查询所有符号，按文件分组
      const rows = db
        .prepare(
          `SELECT f.path, s.name, s.kind, s.start_line, s.signature, s.exported
           FROM symbols s
           JOIN files f ON s.file_id = f.id
           WHERE s.exported = 1
           ORDER BY f.path, s.start_line`
        )
        .all() as Array<{
        path: string;
        name: string;
        kind: string;
        start_line: number;
        signature: string | null;
        exported: number;
      }>;

      // 按文件分组
      const fileMap = new Map<
        string,
        Array<{ name: string; kind: string; line: number; signature: string | null }>
      >();
      for (const row of rows) {
        const symbols = fileMap.get(row.path) ?? [];
        symbols.push({
          name: row.name,
          kind: row.kind,
          line: row.start_line,
          signature: row.signature,
        });
        fileMap.set(row.path, symbols);
      }

      // 优先提及的路径排前面
      const sortedPaths = Array.from(fileMap.keys()).sort((a, b) => {
        const aMentioned = mentionedPaths.has(a) ? 0 : 1;
        const bMentioned = mentionedPaths.has(b) ? 0 : 1;
        if (aMentioned !== bMentioned) return aMentioned - bMentioned;
        const aWritable = writablePaths.has(a) ? 0 : 1;
        const bWritable = writablePaths.has(b) ? 0 : 1;
        return aWritable - bWritable;
      });

      // 生成 repo map
      const lines: string[] = [`# Repository Map\n`];
      let usedTokens = 0;

      for (const filePath of sortedPaths) {
        const symbols = fileMap.get(filePath)!;
        const relPath = this.root
          ? upath.normalize(filePath).replace(upath.normalize(this.root), "").replace(/^\//, "")
          : filePath;

        const fileHeader = `\n## ${relPath}\n`;
        const fileTokens = this.estimateTokens(fileHeader);

        if (usedTokens + fileTokens > tokenBudget) break;

        lines.push(fileHeader);
        usedTokens += fileTokens;

        for (const sym of symbols) {
          const sig = sym.signature ? `: ${sym.signature}` : "";
          const symLine = `- ${sym.kind} ${sym.name}${sig} (L${sym.line})\n`;
          const symTokens = this.estimateTokens(symLine);

          if (usedTokens + symTokens > tokenBudget) break;

          lines.push(symLine);
          usedTokens += symTokens;
        }
      }

      return lines.join("");
    } catch (error) {
      console.error(`[UnifiedIndexAdapter] buildRepoMap failed:`, error);
      return `# Repo map (unified) — build failed: ${error}\n`;
    }
  }

  async graphSearch(query: string, depth: number): Promise<GraphResult> {
    // 刷新 dirty 文件
    await this.flushDirtyFiles();

    try {
      const impact = await this.index.impact(query, Math.min(depth, 4));

      // 将 SearchResult 转为 CallSite
      const toCallSite = (r: { path: string; name?: string; line: number }): CallSite => ({
        path: r.path,
        name: r.name ?? "unknown",
        line: r.line,
      });

      return {
        symbol: query,
        definition: impact.focal
          ? {
              path: impact.focal.path,
              name: impact.focal.name ?? query,
              kind: impact.focal.kind ?? "unknown",
              line: impact.focal.line,
              endLine: impact.focal.endLine,
            }
          : undefined,
        callers: impact.callers.map(toCallSite),
        callees: impact.callees.map(toCallSite),
      };
    } catch (error) {
      // 符号不存在时返回空结果
      return { symbol: query, callers: [], callees: [] };
    }
  }

  invalidate(path: string): void {
    // Readonly main-process adapters never write; dirty tracking belongs to the worker.
    if (this.readonlyMode) return;
    this.dirtyPaths.add(path);
  }

  invalidateDir(dir: string): void {
    if (this.readonlyMode) return;
    const db = this.index.getDatabase();
    if (!db) return;

    try {
      // 查找该目录下的所有文件并标记为 dirty
      const rows = db
        .prepare("SELECT path FROM files WHERE path LIKE ?")
        .all(`${dir}%`) as Array<{ path: string }>;

      for (const row of rows) {
        this.dirtyPaths.add(row.path);
      }
    } catch {
      // 忽略错误
    }
  }

  async rebuildAll(): Promise<void> {
    if (this.readonlyMode) {
      console.warn("[UnifiedIndexAdapter] Ignoring rebuildAll on readonly query adapter");
      return;
    }
    const db = this.index.getDatabase();
    if (!db || !this.root) return;

    this.kind = "building";
    try {
      await this.doFullBuild(db, this.root);
      this.kind = "ready";
    } catch (error) {
      this.kind = "error";
      throw error;
    }
  }

  async flushDirty(): Promise<void> {
    await this.flushDirtyFiles();
  }

  status(): IndexStatus {
    return {
      kind: this.kind,
      root: this.root,
      message:
        this.kind === "ready"
          ? "UnifiedIndex ready"
          : this.kind === "error"
            ? "UnifiedIndex error"
            : "UnifiedIndex idle",
      fileCount: this.index.getDatabase() ? this.index.getStats().files : 0,
      tagCount: this.index.getDatabase() ? this.index.getStats().symbols : 0,
    };
  }

  setExtraIgnore(patterns: string[]): void {
    this.extraIgnore = patterns;
  }

  async ftsSearch(query: string, options?: SearchOptions): Promise<SymbolSearchResult[]> {
    // Writable adapters flush dirty paths first; readonly query adapters skip writes.
    await this.flushDirtyFiles();

    try {
      const results = await this.index.searchSymbolsFuzzy(query, options);
      return results.map((r) => ({
        path: r.path,
        name: r.name ?? "",
        qualifiedName: r.qualifiedName,
        kind: r.kind ?? "unknown",
        line: r.line,
        endLine: r.endLine,
        signature: r.signature,
        doc: r.doc,
        score: r.score,
      }));
    } catch (error) {
      console.error(`[UnifiedIndexAdapter] ftsSearch failed:`, error);
      return [];
    }
  }

  // ========== 可选方法：RAG（暂不实现，返回空） ==========

  async ragSearch(): Promise<RagHit[]> {
    return [];
  }
  async ragBuild(): Promise<void> {}
  async ragUpdate(): Promise<void> {}
  async ragSave(): Promise<void> {}
  async ragLoad(): Promise<void> {}

  // ========== 可选方法：Manifest ==========

  async manifestScan(root: string, maxFiles: number): Promise<ManifestDiff> {
    // Stat-only walk. Never read file contents for the startup diff.
    try {
      const { walkFileMetas, computeDiffFromMetas } = await import("./scanner.ts");
      const metas = [];
      for (const meta of walkFileMetas({ root, maxFileSize: MAX_FILE_SIZE })) {
        metas.push(meta);
        if (metas.length >= maxFiles) break;
      }

      const db = this.index.getDatabase();
      if (!db) {
        return { added: metas.map((f) => f.path), modified: [], removed: [] };
      }

      const indexedRows = db
        .prepare("SELECT path, hash, mtime, size FROM files")
        .all() as Array<{ path: string; hash: string; mtime: number; size: number }>;
      const indexedMap = new Map(
        indexedRows.map((r) => [r.path, { hash: r.hash, mtime: r.mtime, size: r.size }]),
      );

      return computeDiffFromMetas(metas, indexedMap);
    } catch (error) {
      console.error(`[UnifiedIndexAdapter] manifestScan failed:`, error);
      return { added: [], modified: [], removed: [] };
    }
  }

  async manifestLoad(_root: string): Promise<void> {
    // UnifiedIndex 直接从 SQLite 加载，无需额外操作
  }

  async manifestSave(): Promise<void> {
    // UnifiedIndex 直接保存到 SQLite，无需额外操作
  }

  // ========== 私有方法 ==========

  private async flushDirtyFiles(): Promise<void> {
    if (this.readonlyMode) return;
    if (this.dirtyPaths.size === 0) return;

    const db = this.index.getDatabase();
    if (!db || !this.root) return;

    const paths = Array.from(this.dirtyPaths);
    this.dirtyPaths.clear();

    try {
      const diff: ManifestDiff = {
        added: [],
        modified: paths,
        removed: [],
      };
      await this.doIncrementalBuild(db, this.root, diff);
    } catch (error) {
      console.error(`[UnifiedIndexAdapter] flushDirtyFiles failed:`, error);
    }
  }

  private async doFullBuild(db: Database.Database, root: string): Promise<void> {
    if (this.buildPromise) {
      return this.buildPromise;
    }

    this.buildPromise = this._doFullBuild(db, root);
    try {
      await this.buildPromise;
    } finally {
      this.buildPromise = null;
    }
  }

  private async _doFullBuild(db: Database.Database, root: string): Promise<void> {
    const startTime = Date.now();
    try {
      const result = await buildIndexAsync(db, {
        root,
        incremental: false,
        useAsyncScan: true,
        scanConcurrency: 50,
        maxFileSize: MAX_FILE_SIZE,
        excludeDirs: [
          ...this.index["options"].excludeDirs,
          ...this.extraIgnore,
        ],
        onProgress: (current, total, file) => {
          if (current % 50 === 0 || current === total) {
            console.log(`[UnifiedIndexAdapter] Building: ${current}/${total} ${file}`);
          }
        },
      });

      this.index.updateBuildMetrics({
        durationMs: result.durationMs,
        filesProcessed: result.filesIndexed,
      });
      this.index.invalidateStatsCache();

      console.log(
        `[UnifiedIndexAdapter] Full build: ${result.filesIndexed} files, ${result.symbolsAdded} symbols in ${result.durationMs}ms`
      );
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error(`[UnifiedIndexAdapter] Full build failed after ${elapsed}ms:`, error);
      throw error;
    }
  }

  private async doIncrementalBuild(
    db: Database.Database,
    root: string,
    diff: ManifestDiff
  ): Promise<void> {
    const startTime = Date.now();
    try {
      const result = await updateIndexAsync(
        db,
        root,
        diff,
        [...this.index["options"].excludeDirs, ...this.extraIgnore],
      );

      this.index.updateBuildMetrics({
        durationMs: result.durationMs,
        filesProcessed: result.filesIndexed,
      });
      this.index.invalidateStatsCache();

      console.log(
        `[UnifiedIndexAdapter] Incremental build: ${result.filesIndexed} files, +${diff.added.length} ~${diff.modified.length} -${diff.removed.length} in ${result.durationMs}ms`
      );
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error(`[UnifiedIndexAdapter] Incremental build failed after ${elapsed}ms:`, error);
      // 增量更新失败不应阻塞，降级为全量重建
      await this.doFullBuild(db, root);
    }
  }

  private estimateTokens(text: string): number {
    // 粗略估计：1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }
}
