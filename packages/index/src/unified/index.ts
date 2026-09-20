/**
 * 统一索引系统核心类
 * 
 * 职责:
 * 1. 管理SQLite数据库连接
 * 2. 提供统一的搜索接口
 * 3. 增量索引更新
 * 4. 图遍历查询
 * 5. 安全性和访问控制
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { initializeSchema } from "./schema.ts";
import {
  validateWorkspacePath,
  validateDatabasePath,
  setDatabasePermissions,
  sanitizeFtsQuery,
  validateSearchOptions,
  escapeLikePattern,
} from "./security.ts";
import type {
  UnifiedIndexOptions,
  IndexStatus,
  IndexStats,
  SearchResult,
  SearchOptions,
  ImpactResult,
  SymbolRecord,
} from "./types.ts";
import { MAX_FILE_SIZE } from "./scanner.ts";

const DEFAULT_OPTIONS: Required<Omit<UnifiedIndexOptions, "root">> = {
  enableSemantic: false,
  symbolSearchPriority: "hybrid",
  maxFileSize: MAX_FILE_SIZE,
  excludeDirs: [
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
    "__pycache__",
    ".venv",
    "vendor",
  ],
};

/**
 * 统一索引系统核心类
 * 
 * 提供基于SQLite + FTS5的代码索引功能,支持:
 * - 符号搜索(精确/模糊)
 * - 引用关系查询
 * - Impact分析
 * - 增量更新
 * 
 * @class UnifiedIndex
 * 
 * @example
 * ```typescript
 * const index = new UnifiedIndex();
 * 
 * // 打开工作区
 * index.open("/path/to/project");
 * 
 * // 搜索符号
 * const results = await index.search("MyClass");
 * 
 * // Impact分析
 * const impact = await index.impact("processData", 3);
 * 
 * // 关闭
 * index.close();
 * ```
 * 
 * @remarks
 * - 数据库存储在 .owncoder/unified-index.db
 * - 支持TypeScript、JavaScript、Python、Rust、Go等语言
 * - 自动增量更新,基于文件hash检测变更
 * 
 * 职责:
 * 1. 管理SQLite数据库连接
 * 2. 提供统一的搜索接口
 * 3. 增量索引更新
 * 4. 图遍历查询
 * 5. 安全性和访问控制
 */
export class UnifiedIndex {
  private db: Database.Database | null = null;
  private root: string | null = null;
  private options: Required<UnifiedIndexOptions>;
  private lastIndexedAt: number | null = null;
  
  // 性能监控字段
  private performanceMetrics: {
    lastBuildDurationMs?: number;
    lastBuildFilesProcessed?: number;
    lastBuildTimestamp?: number;
    totalQueries: number;
    totalQueryTimeMs: number;
    slowestQueries: Array<{
      query: string;
      durationMs: number;
      resultCount: number;
      timestamp: number;
    }>;
  } = {
    totalQueries: 0,
    totalQueryTimeMs: 0,
    slowestQueries: [],
  };
  
  // 统计信息缓存
  private statsCache: {
    stats: IndexStats | null;
    timestamp: number;
  } = {
    stats: null,
    timestamp: 0,
  };
  
  private readonly STATS_CACHE_TTL_MS = 1000; // 1秒缓存

  /**
   * 创建索引实例
   * 
   * @param {Partial<UnifiedIndexOptions>} [options] - 索引配置选项
   * @param {string} [options.root] - 工作区根目录
   * @param {boolean} [options.enableSemantic=false] - 是否启用语义搜索(实验性)
   * @param {'exact'|'fuzzy'|'hybrid'} [options.symbolSearchPriority='hybrid'] - 搜索策略
   * @param {number} [options.maxFileSize=133120] - 最大索引文件大小(字节,默认130KB)
   * @param {string[]} [options.excludeDirs] - 排除的目录列表
   * 
   * @example
   * ```typescript
   * const index = new UnifiedIndex({
   *   maxFileSize: 5 * 1024 * 1024, // 5MB
   *   excludeDirs: ['node_modules', 'dist', '.git'],
   *   symbolSearchPriority: 'hybrid'
   * });
   * ```
   */
  constructor(options?: Partial<UnifiedIndexOptions>) {
    this.options = {
      ...DEFAULT_OPTIONS,
      root: options?.root ?? "",
      enableSemantic: options?.enableSemantic ?? DEFAULT_OPTIONS.enableSemantic,
      symbolSearchPriority:
        options?.symbolSearchPriority ?? DEFAULT_OPTIONS.symbolSearchPriority,
      maxFileSize: options?.maxFileSize ?? DEFAULT_OPTIONS.maxFileSize,
      excludeDirs: options?.excludeDirs ?? DEFAULT_OPTIONS.excludeDirs,
    };
  }

  /**
   * 打开并初始化索引数据库
   * 
   * 打开指定工作区的索引数据库,如果数据库不存在则创建。
   * 包含完整的错误恢复和安全验证机制。
   * 
   * @param {string} root - 工作区根目录的绝对路径
   * @throws {Error} 如果路径无效、不存在或权限不足
   * 
   * @example
   * ```typescript
   * index.open("/Users/alice/projects/myapp");
   * ```
   * 
   * @remarks
   * 错误恢复:
   * - 如果打开失败,尝试删除并重建
   * - 如果schema初始化失败,回滚并报告
   * 
   * 安全措施:
   * - 验证工作区路径(防止路径遍历)
   * - 验证数据库路径(必须在.owncoder目录内)
   * - 设置文件权限(0600,用户可读写)
   * 
   * @see {@link close} 关闭数据库
   */
  open(root: string, options?: { readonly?: boolean }): void {
    if (this.db && this.root === root) {
      return; // 已打开同一个工作区
    }

    this.close();
    const readonly = options?.readonly === true;

    // 安全验证: 验证工作区路径
    try {
      root = validateWorkspacePath(root);
    } catch (error) {
      console.error(`[UnifiedIndex] Invalid workspace path:`, error);
      throw error;
    }

    this.root = root;
    const dbPath = this.getDatabasePath(root);
    
    // 安全验证: 验证数据库路径
    try {
      validateDatabasePath(dbPath, root);
    } catch (error) {
      console.error(`[UnifiedIndex] Invalid database path:`, error);
      throw error;
    }
    
    // 确保.owncoder目录存在（只读打开时若尚无库，保持未连接，由 worker 稍后创建）
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      if (readonly) {
        console.log(`[UnifiedIndex] Readonly open: db dir missing, defer until worker builds`);
        return;
      }
      mkdirSync(dbDir, { recursive: true });
    }
    if (readonly && !existsSync(dbPath)) {
      console.log(`[UnifiedIndex] Readonly open: db missing, defer until worker builds`);
      return;
    }
    
    try {
      this.db = new Database(dbPath, readonly ? { readonly: true, fileMustExist: true } : undefined);
      if (!readonly) {
        initializeSchema(this.db);
        // 安全措施: 设置数据库文件权限
        setDatabasePermissions(dbPath);
      }
      
      console.log(`[UnifiedIndex] Opened database: ${dbPath}${readonly ? " (readonly)" : ""}`);
    } catch (error) {
      console.error(`[UnifiedIndex] Failed to open database: ${error}`);
      if (readonly) {
        this.db = null;
        return;
      }
      
      // 尝试恢复
      if (this.isDatabaseCorrupted(error)) {
        console.warn("[UnifiedIndex] Database corrupted, attempting rebuild...");
        this.db?.close();
        this.db = null;
        
        try {
          // 删除损坏的数据库
          const fs = require("node:fs");
          if (existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
            console.log("[UnifiedIndex] Removed corrupted database");
          }
          
          // 重新创建
          this.db = new Database(dbPath);
          initializeSchema(this.db);
          setDatabasePermissions(dbPath);
          console.log("[UnifiedIndex] Database rebuilt successfully");
        } catch (rebuildError) {
          console.error("[UnifiedIndex] Failed to rebuild database:", rebuildError);
          throw new Error(`Database initialization failed: ${rebuildError}`);
        }
      } else {
        throw error;
      }
    }
  }

  /**
   * 检测是否是数据库损坏错误
   */
  private isDatabaseCorrupted(error: unknown): boolean {
    const errorMsg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    
    return (
      errorMsg.includes("database disk image is malformed") ||
      errorMsg.includes("not a database") ||
      errorMsg.includes("file is not a database") ||
      errorMsg.includes("sqlite_corrupt") ||
      errorMsg.includes("database is locked")
    );
  }

  /**
   * 关闭数据库连接
   * 
   * @example
   * ```typescript
   * index.close();
   * ```
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.root = null;
      this.invalidateStatsCache();
    }
  }

  /**
   * 获取索引状态
   */
  status(): IndexStatus {
    if (!this.db || !this.root) {
      return {
        ready: false,
        fileCount: 0,
        symbolCount: 0,
        referenceCount: 0,
        message: "Index not initialized",
      };
    }

    const stats = this.getStats();
    return {
      ready: stats.files > 0,
      root: this.root,
      databasePath: this.getDatabasePath(this.root),
      fileCount: stats.files,
      symbolCount: stats.symbols,
      referenceCount: stats.references,
      lastIndexedAt: this.lastIndexedAt ?? undefined,
      message: stats.files > 0 ? "Index ready" : "Index empty - run build()",
    };
  }

  /**
   * 获取详细统计信息(带缓存)
   * 
   * 使用1秒TTL缓存减少频繁的数据库查询。
   * 在构建或大量修改后应调用invalidateStatsCache()使缓存失效。
   * 
   * @returns {IndexStats} 统计信息
   * 
   * @example
   * ```typescript
   * const stats = index.getStats();
   * console.log(`Files: ${stats.files}`);
   * console.log(`Symbols: ${stats.symbols}`);
   * console.log(`Avg query time: ${stats.performance.avgQueryTimeMs}ms`);
   * ```
   * 
   * @remarks
   * 缓存策略:
   * - TTL: 1秒
   * - 自动失效: 构建、打开新工作区
   * - 手动失效: invalidateStatsCache()
   */
  getStats(): IndexStats {
    // 检查缓存
    const now = Date.now();
    if (
      this.statsCache.stats &&
      now - this.statsCache.timestamp < this.STATS_CACHE_TTL_MS
    ) {
      return this.statsCache.stats;
    }
    
    // 计算统计信息
    const stats = this.computeStats();
    
    // 更新缓存
    this.statsCache = {
      stats,
      timestamp: now,
    };
    
    return stats;
  }

  /**
   * 计算统计信息(内部方法,无缓存)
   */
  private computeStats(): IndexStats {
    if (!this.db) {
      return {
        files: 0,
        symbols: 0,
        references: 0,
        symbolsByKind: {},
        languageBreakdown: {},
        performance: undefined,
      };
    }

    const fileCount = this.db.prepare("SELECT COUNT(*) FROM files").pluck().get() as number;
    const symbolCount = this.db.prepare("SELECT COUNT(*) FROM symbols").pluck().get() as number;
    const refCount = this.db.prepare('SELECT COUNT(*) FROM symbol_references').pluck().get() as number;

    // 按类型统计符号
    const symbolsByKind: Record<string, number> = {};
    const kindRows = this.db
      .prepare("SELECT kind, COUNT(*) as count FROM symbols GROUP BY kind")
      .all() as Array<{ kind: string; count: number }>;
    for (const row of kindRows) {
      symbolsByKind[row.kind] = row.count;
    }

    // 按语言统计文件
    const languageBreakdown: Record<string, number> = {};
    const langRows = this.db
      .prepare("SELECT language, COUNT(*) as count FROM files GROUP BY language")
      .all() as Array<{ language: string | null; count: number }>;
    for (const row of langRows) {
      const lang = row.language ?? "unknown";
      languageBreakdown[lang] = row.count;
    }

    return {
      files: fileCount,
      symbols: symbolCount,
      references: refCount,
      symbolsByKind,
      languageBreakdown,
      performance: {
        lastBuildDurationMs: this.performanceMetrics.lastBuildDurationMs,
        lastBuildFilesProcessed: this.performanceMetrics.lastBuildFilesProcessed,
        lastBuildTimestamp: this.performanceMetrics.lastBuildTimestamp,
        avgQueryTimeMs: this.performanceMetrics.totalQueries > 0
          ? this.performanceMetrics.totalQueryTimeMs / this.performanceMetrics.totalQueries
          : undefined,
        totalQueries: this.performanceMetrics.totalQueries,
        slowestQueries: this.performanceMetrics.slowestQueries.slice(0, 10),
      },
    };
  }

  /**
   * 使统计信息缓存失效
   * 
   * 在索引构建或大量修改后调用,确保getStats()返回最新数据。
   * 
   * @example
   * ```typescript
   * await buildIndex(db, { root, incremental: true });
   * index.invalidateStatsCache();
   * const freshStats = index.getStats();
   * ```
   */
  invalidateStatsCache(): void {
    this.statsCache = {
      stats: null,
      timestamp: 0,
    };
  }

  /**
   * 获取数据库实例
   * 
   * 用于构建器和适配器访问底层数据库。
   * 不建议直接操作数据库,应优先使用UnifiedIndex的公共API。
   * 
   * @returns {Database.Database | null} 数据库实例,未初始化时为null
   * 
   * @example
   * ```typescript
   * const db = index.getDatabase();
   * if (db) {
   *   await buildIndex(db, { root, incremental: true });
   * }
   * ```
   * 
   * @internal 主要用于内部组件,不建议外部直接使用
   */
  getDatabase(): Database.Database | null {
    return this.db;
  }

  /**
   * 更新构建性能指标
   * 
   * 由构建器调用,记录最后一次构建的性能数据。
   * 
   * @param {Object} metrics - 性能指标
   * @param {number} metrics.durationMs - 构建耗时(毫秒)
   * @param {number} metrics.filesProcessed - 处理的文件数
   * 
   * @example
   * ```typescript
   * index.updateBuildMetrics({
   *   durationMs: 1234,
   *   filesProcessed: 56
   * });
   * ```
   * 
   * @internal 主要用于内部组件
   */
  updateBuildMetrics(metrics: {
    durationMs: number;
    filesProcessed: number;
  }): void {
    this.performanceMetrics.lastBuildDurationMs = metrics.durationMs;
    this.performanceMetrics.lastBuildFilesProcessed = metrics.filesProcessed;
    this.performanceMetrics.lastBuildTimestamp = Date.now();
    this.lastIndexedAt = Date.now();
  }

  /**
   * 在只读事务中执行查询
   * 
   * 使用BEGIN DEFERRED...COMMIT包装查询,确保:
   * - 快照隔离: 查询看到一致的数据库状态
   * - 避免脏读: 不会看到未提交的写入
   * - 性能优化: DEFERRED模式允许多个并发读
   * 
   * @param queryFn - 执行查询的函数
   * @returns 查询结果
   * 
   * @internal
   */
  private withReadTransaction<T>(queryFn: (db: Database.Database) => T): T {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    // 使用DEFERRED事务模式:
    // - 开始时不获取锁
    // - 首次读取时获取共享锁
    // - 允许多个并发读事务
    this.db.exec("BEGIN DEFERRED");
    
    try {
      const result = queryFn(this.db);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        // 忽略ROLLBACK错误(可能事务已自动回滚)
      }
      throw error;
    }
  }

  /**
   * 精确符号搜索
   * 
   * 安全措施: 验证搜索选项,使用事务隔离保证一致性
   */
  async searchSymbolsExact(name: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (!this.db) return [];

    // 安全措施: 验证和清理搜索选项
    const validatedOptions = validateSearchOptions(options);
    const limit = validatedOptions.limit ?? 20;
    
    return this.withReadTransaction((db) => {
      const sql = `
        SELECT 
          s.id, s.name, s.qualified_name, s.kind, s.start_line, s.end_line,
          s.signature, s.doc, s.exported,
          f.path, f.language
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE s.name = ?
        ${validatedOptions.symbolKind?.length ? `AND s.kind IN (${validatedOptions.symbolKind.map(() => "?").join(",")})` : ""}
        ${validatedOptions.exportedOnly ? "AND s.exported = 1" : ""}
        ${validatedOptions.pathPrefix ? "AND f.path LIKE ? ESCAPE '\\'" : ""}
        ORDER BY s.exported DESC, f.path
        LIMIT ?
      `;

      const params: unknown[] = [name];
      if (validatedOptions.symbolKind?.length) {
        params.push(...validatedOptions.symbolKind);
      }
      if (validatedOptions.exportedOnly) {
        // no parameter
      }
      if (validatedOptions.pathPrefix) {
        params.push(`${escapeLikePattern(validatedOptions.pathPrefix)}%`);
      }
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as Array<SymbolRecord & { path: string; language: string }>;

      return rows.map((row) => ({
        type: "symbol" as const,
        path: row.path,
        name: row.name,
        qualifiedName: row.qualified_name ?? undefined,
        kind: row.kind,
        line: row.start_line,
        endLine: row.end_line,
        score: 1.0, // 精确匹配最高分
        signature: row.signature ?? undefined,
        doc: row.doc ?? undefined,
      }));
    });
  }

  /**
   * 模糊符号搜索 (使用FTS5)
   * 
   * 安全措施: 使用sanitizeFtsQuery清理查询,事务隔离保证一致性
   */
  async searchSymbolsFuzzy(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (!this.db) return [];

    // 安全措施: 验证和清理搜索选项
    const validatedOptions = validateSearchOptions(options);
    const limit = validatedOptions.limit ?? 20;
    
    // 安全措施: Sanitize FTS5查询
    const ftsQuery = sanitizeFtsQuery(query);
    
    if (!ftsQuery) {
      return []; // 查询被sanitize后为空
    }
    
    try {
      return this.withReadTransaction((db) => {
        // 优化排名: FTS5 rank + 导出符号权重 + 符号类型权重
        const sql = `
          SELECT 
            s.id, s.name, s.qualified_name, s.kind, s.start_line, s.end_line,
            s.signature, s.doc, s.exported,
            f.path, f.language,
            symbols_fts.rank as fts_rank
          FROM symbols_fts
          JOIN symbols s ON s.rowid = symbols_fts.rowid
          JOIN files f ON s.file_id = f.id
          WHERE symbols_fts MATCH ?
            ${validatedOptions.symbolKind?.length ? `AND s.kind IN (${validatedOptions.symbolKind.map(() => "?").join(",")})` : ""}
          ${validatedOptions.exportedOnly ? "AND s.exported = 1" : ""}
          ${validatedOptions.pathPrefix ? "AND f.path LIKE ? ESCAPE '\\'" : ""}
          ORDER BY 
            fts_rank * 0.6 + 
            CASE WHEN s.exported = 1 THEN 0.4 ELSE 0 END +
            CASE 
              WHEN s.kind IN ('class', 'function', 'method') THEN 0.3 
              WHEN s.kind IN ('interface', 'type') THEN 0.2 
              ELSE 0 
            END,
            s.exported DESC
          LIMIT ?
        `;

        const params: unknown[] = [ftsQuery];
        if (validatedOptions.symbolKind?.length) {
          params.push(...validatedOptions.symbolKind);
        }
        if (validatedOptions.exportedOnly) {
          // no parameter
        }
        if (validatedOptions.pathPrefix) {
          params.push(`${escapeLikePattern(validatedOptions.pathPrefix)}%`);
        }
        params.push(limit);

        const rows = db.prepare(sql).all(...params) as Array<
          SymbolRecord & { path: string; language: string; fts_rank: number }
        >;

        return rows.map((row) => ({
          type: "symbol" as const,
          path: row.path,
          name: row.name,
          qualifiedName: row.qualified_name ?? undefined,
          kind: row.kind,
          line: row.start_line,
          endLine: row.end_line,
          score: this.normalizeScore(row.fts_rank),
          signature: row.signature ?? undefined,
          doc: row.doc ?? undefined,
        }));
      });
    } catch (error) {
      console.error(`[UnifiedIndex] FTS search failed:`, error);
      return [];
    }
  }

  /**
   * 统一搜索接口
   * 
   * 根据配置的策略进行精确或模糊搜索,自动记录性能指标。
   * 
   * @param {string} query - 搜索查询字符串
   * @param {SearchOptions} [options] - 搜索选项
   * @param {number} [options.limit=20] - 最大返回结果数
   * @param {'symbol'|'file'|'all'} [options.type] - 搜索类型
   * @param {string[]} [options.symbolKind] - 符号类型过滤
   * @param {boolean} [options.exportedOnly] - 只搜索导出符号
   * @param {string} [options.pathPrefix] - 文件路径前缀过滤
   * @returns {Promise<SearchResult[]>} 搜索结果数组,按相关性排序
   * 
   * @example
   * ```typescript
   * // 基础搜索
   * const results = await index.search("MyClass");
   * 
   * // 带选项的搜索
   * const results = await index.search("process", {
   *   limit: 50,
   *   symbolKind: ["function", "method"],
   *   exportedOnly: true,
   *   pathPrefix: "src/utils"
   * });
   * ```
   * 
   * @remarks
   * - 搜索策略由构造函数的symbolSearchPriority决定:
   *   - 'exact': 只进行精确匹配
   *   - 'fuzzy': 只进行模糊匹配(FTS5)
   *   - 'hybrid': 先精确后模糊(默认)
   * - 所有查询自动sanitize,防止注入攻击
   * - 性能指标自动记录,可通过getStats()查看
   * - 慢查询(>100ms)会输出警告日志
   * 
   * @see {@link SearchResult} 返回结果的结构
   * @see {@link getStats} 获取性能统计
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const startTime = performance.now();
    
    try {
      const results = await this.searchInternal(query, options);
      
      // 记录性能指标
      const durationMs = performance.now() - startTime;
      this.recordQueryMetrics(query, durationMs, results.length);
      
      if (durationMs > 100) {
        console.warn(`[UnifiedIndex] Slow query (${durationMs.toFixed(2)}ms): "${query}"`);
      }
      
      return results;
    } catch (error) {
      const durationMs = performance.now() - startTime;
      console.error(`[UnifiedIndex] Search failed after ${durationMs.toFixed(2)}ms:`, error);
      throw error;
    }
  }

  /**
   * 内部搜索实现
   */
  private async searchInternal(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (!query.trim() || !this.db) {
      return [];
    }

    const priority = this.options.symbolSearchPriority;
    const validatedOptions = validateSearchOptions(options);
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    if (validatedOptions.type === "file") {
      return this.searchFiles(query, validatedOptions.limit, validatedOptions.pathPrefix);
    }

    // 策略1: 精确匹配
    if (priority === "exact" || priority === "hybrid") {
      const exact = await this.searchSymbolsExact(query.trim(), options);
      for (const result of exact) {
        const key = `${result.path}:${result.name}:${result.line}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(result);
        }
      }
    }

    // 如果精确匹配已满足需求,直接返回
    const limit = options?.limit ?? 20;
    if (results.length >= limit) {
      return results.slice(0, limit);
    }

    // 策略2: 模糊匹配
    if (priority === "fuzzy" || priority === "hybrid") {
      const fuzzy = await this.searchSymbolsFuzzy(query.trim(), {
        ...options,
        limit: limit - results.length,
      });
      for (const result of fuzzy) {
        const key = `${result.path}:${result.name}:${result.line}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(result);
        }
      }
    }

    if (validatedOptions.type === "all" && results.length < limit) {
      const files = await this.searchFiles(
        query,
        limit - results.length,
        validatedOptions.pathPrefix,
      );
      for (const result of files) {
        const key = `${result.type}:${result.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(result);
        }
      }
    }

    return results.slice(0, limit);
  }

  private async searchFiles(
    query: string,
    limit = 20,
    pathPrefix?: string,
  ): Promise<SearchResult[]> {
    if (!this.db) return [];
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];

    return this.withReadTransaction((db) => {
      const sql = `
        SELECT f.path, f.language, files_fts.rank AS fts_rank
        FROM files_fts
        JOIN files f ON f.id = files_fts.rowid
        WHERE files_fts MATCH ?
        ${pathPrefix ? "AND f.path LIKE ? ESCAPE '\\'" : ""}
        ORDER BY files_fts.rank
        LIMIT ?
      `;
      const params: unknown[] = [ftsQuery];
      if (pathPrefix) params.push(`${escapeLikePattern(pathPrefix)}%`);
      params.push(Math.max(1, Math.min(1000, Math.floor(limit))));

      const rows = db.prepare(sql).all(...params) as Array<{
        path: string;
        language: string | null;
        fts_rank: number;
      }>;
      return rows.map((row) => ({
        type: "file" as const,
        path: row.path,
        line: 1,
        score: this.normalizeScore(row.fts_rank),
        preview: row.path,
      }));
    });
  }

  /**
   * 记录查询性能指标
   */
  private recordQueryMetrics(query: string, durationMs: number, resultCount: number): void {
    this.performanceMetrics.totalQueries++;
    this.performanceMetrics.totalQueryTimeMs += durationMs;
    
    // 记录最慢的10次查询
    const metric = {
      query: query.slice(0, 100), // 限制长度
      durationMs,
      resultCount,
      timestamp: Date.now(),
    };
    
    this.performanceMetrics.slowestQueries.push(metric);
    this.performanceMetrics.slowestQueries.sort((a, b) => b.durationMs - a.durationMs);
    
    // 只保留最慢的10次
    if (this.performanceMetrics.slowestQueries.length > 10) {
      this.performanceMetrics.slowestQueries = this.performanceMetrics.slowestQueries.slice(0, 10);
    }
  }

  /**
   * 查找符号的调用者
   */
  async findCallers(symbolId: number, depth: number = 3): Promise<SearchResult[]> {
    if (!this.db) return [];

    return this.withReadTransaction((db) => {
      const sql = `
        WITH RECURSIVE callers(symbol_id, depth) AS (
          SELECT from_symbol_id, 1
          FROM symbol_references
          WHERE to_symbol_id = ?
          
          UNION ALL
          
          SELECT r.from_symbol_id, c.depth + 1
          FROM symbol_references r
          JOIN callers c ON r.to_symbol_id = c.symbol_id
          WHERE c.depth < ?
        )
        SELECT DISTINCT
          s.id, s.name, s.qualified_name, s.kind, s.start_line, s.end_line,
          s.signature, s.doc,
          f.path,
          c.depth
        FROM callers c
        JOIN symbols s ON c.symbol_id = s.id
        JOIN files f ON s.file_id = f.id
        ORDER BY c.depth, f.path
        LIMIT 100
      `;

      const rows = db.prepare(sql).all(symbolId, depth) as Array<
        SymbolRecord & { path: string; depth: number }
      >;

      return rows.map((row) => ({
        type: "symbol" as const,
        path: row.path,
        name: row.name,
        qualifiedName: row.qualified_name ?? undefined,
        kind: row.kind,
        line: row.start_line,
        endLine: row.end_line,
        score: 1.0 / row.depth, // 深度越浅权重越高
        signature: row.signature ?? undefined,
        doc: row.doc ?? undefined,
      }));
    });
  }

  /**
   * 查找符号的被调用者
   */
  async findCallees(symbolId: number, depth: number = 3): Promise<SearchResult[]> {
    if (!this.db) return [];

    return this.withReadTransaction((db) => {
      const sql = `
        WITH RECURSIVE callees(symbol_id, depth) AS (
          SELECT to_symbol_id, 1
          FROM symbol_references
          WHERE from_symbol_id = ?
          
          UNION ALL
          
          SELECT r.to_symbol_id, c.depth + 1
          FROM symbol_references r
          JOIN callees c ON r.from_symbol_id = c.symbol_id
          WHERE c.depth < ?
        )
        SELECT DISTINCT
          s.id, s.name, s.qualified_name, s.kind, s.start_line, s.end_line,
          s.signature, s.doc,
          f.path,
          c.depth
        FROM callees c
        JOIN symbols s ON c.symbol_id = s.id
        JOIN files f ON s.file_id = f.id
        ORDER BY c.depth, f.path
        LIMIT 100
      `;

      const rows = db.prepare(sql).all(symbolId, depth) as Array<
        SymbolRecord & { path: string; depth: number }
      >;

      return rows.map((row) => ({
        type: "symbol" as const,
        path: row.path,
        name: row.name,
        qualifiedName: row.qualified_name ?? undefined,
        kind: row.kind,
        line: row.start_line,
        endLine: row.end_line,
        score: 1.0 / row.depth,
        signature: row.signature ?? undefined,
        doc: row.doc ?? undefined,
      }));
    });
  }

  /**
   * 影响分析 - 分析修改某个符号的影响范围
   * 
   * 执行双向分析:
   * - 向上查找所有调用者(callers)
   * - 向下查找所有被调用者(callees)
   * - 识别相关的测试文件
   * - 评估修改风险等级
   * 
   * @param {string|number} queryOrId - 符号名称或符号ID
   * @param {number} [depth=3] - 递归深度(1-10)
   * @returns {Promise<ImpactResult>} 影响分析结果
   * 
   * @example
   * ```typescript
   * const impact = await index.impact("processUserData", 3);
   * 
   * console.log(impact.riskLevel); // "high" | "medium" | "low"
   * console.log(impact.directCallers); // 直接调用者数量
   * console.log(impact.transitiveCallers); // 传递调用者总数
   * console.log(impact.callers); // 调用者列表
   * console.log(impact.callees); // 被调用者列表
   * console.log(impact.likelyTests); // 相关测试
   * ```
   * 
   * @remarks
   * 风险评估依据:
   * - 直接调用者数量
   * - 传递调用者数量
   * - 是否为导出符号
   * - 符号类型(类/接口风险高于函数)
   * 
   * 限制:
   * - depth范围: 1-10,超出会被限制
   * - 当前引用提取基于正则,可能不完全准确
   * - 跨文件引用需要进一步完善
   * 
   * @throws {Error} 如果索引未初始化或符号不存在
   * 
   * @see {@link ImpactResult} 返回结果的结构
   */
  async impact(queryOrId: string | number, depth: number = 3): Promise<ImpactResult> {
    if (!this.db) {
      throw new Error("Index not initialized");
    }

    // 解析符号
    let symbolId: number;
    let focal: SearchResult;

    if (typeof queryOrId === "number") {
      symbolId = queryOrId;
      const symbol = this.getSymbolById(symbolId);
      if (!symbol) {
        throw new Error(`Symbol not found: ${symbolId}`);
      }
      focal = symbol;
    } else {
      const results = await this.searchSymbolsExact(queryOrId);
      if (results.length === 0) {
        throw new Error(`Symbol not found: ${queryOrId}`);
      }
      focal = results[0];
      symbolId = this.getSymbolId(focal.path, focal.name!, focal.line);
    }

    // 查找调用者和被调用者
    const callers = await this.findCallers(symbolId, depth);
    const callees = await this.findCallees(symbolId, depth);

    // 查找可能的测试
    const likelyTests = this.findLikelyTests(focal);

    // 计算风险
    const directCallers = callers.filter((c) => c.score === 1.0).length;
    const transitiveCallers = callers.length;
    const { level, score, explanation } = this.calculateRisk(
      directCallers,
      transitiveCallers,
      callees.length,
      likelyTests.length > 0
    );

    return {
      focal,
      callers,
      callees,
      likelyTests,
      riskLevel: level,
      riskScore: score,
      explanation,
      directCallers,
      transitiveCallers,
    };
  }

  // ========== 私有辅助方法 ==========

  private getDatabasePath(root: string): string {
    return join(root, ".owncoder", "unified-index.db");
  }

  private normalizeScore(ftsRank: number): number {
    // FTS5的rank是负数,越小越相关
    // 转换为0-1之间的分数
    return 1.0 / (1.0 + Math.abs(ftsRank) * 0.1);
  }

  private getSymbolById(symbolId: number): SearchResult | null {
    if (!this.db) return null;

    return this.withReadTransaction((db) => {
      const row = db
        .prepare(
          `
        SELECT s.*, f.path
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE s.id = ?
      `
        )
        .get(symbolId) as (SymbolRecord & { path: string }) | undefined;

      if (!row) return null;

      return {
        type: "symbol",
        path: row.path,
        name: row.name,
        qualifiedName: row.qualified_name ?? undefined,
        kind: row.kind,
        line: row.start_line,
        endLine: row.end_line,
        score: 1.0,
        signature: row.signature ?? undefined,
        doc: row.doc ?? undefined,
      };
    });
  }

  private getSymbolId(path: string, name: string, line: number): number {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    return this.withReadTransaction((db) => {
      const row = db
        .prepare(
          `
        SELECT s.id
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE f.path = ? AND s.name = ? AND s.start_line = ?
        LIMIT 1
      `
        )
        .get(path, name, line) as { id: number } | undefined;

      if (!row) {
        throw new Error(`Symbol not found: ${path}:${name}:${line}`);
      }

      return row.id;
    });
  }

  private findLikelyTests(focal: SearchResult): SearchResult[] {
    if (!this.db) return [];

    return this.withReadTransaction((db) => {
      // 简单的测试文件启发式:
      // 1. 文件名包含test/spec
      // 2. 路径包含__tests__/test/tests目录
      const namePattern = focal.name?.toLowerCase() ?? "";

      const sql = `
        SELECT s.*, f.path
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE (
          f.path LIKE '%test%' 
          OR f.path LIKE '%spec%'
          OR f.path LIKE '%__tests__%'
        )
        AND (
          s.name LIKE ? 
          OR s.name LIKE ?
        )
        LIMIT 20
      `;

      const rows = db
        .prepare(sql)
        .all(`%${namePattern}%`, `%test%${namePattern}%`) as Array<SymbolRecord & { path: string }>;

      return rows.map((row) => ({
        type: "symbol" as const,
        path: row.path,
        name: row.name,
        qualifiedName: row.qualified_name ?? undefined,
        kind: row.kind,
        line: row.start_line,
        endLine: row.end_line,
        score: 0.8,
        signature: row.signature ?? undefined,
        doc: row.doc ?? undefined,
      }));
    });
  }

  private calculateRisk(
    directCallers: number,
    transitiveCallers: number,
    callees: number,
    hasTests: boolean
  ): { level: "low" | "medium" | "high"; score: number; explanation: string } {
    let score = 0;
    const factors: string[] = [];

    // 直接调用者数量
    if (directCallers === 0) {
      factors.push("no direct callers (possibly unused)");
    } else if (directCallers <= 3) {
      score += 1;
      factors.push(`${directCallers} direct caller${directCallers > 1 ? "s" : ""}`);
    } else if (directCallers <= 10) {
      score += 3;
      factors.push(`${directCallers} direct callers`);
    } else {
      score += 5;
      factors.push(`${directCallers} direct callers (widely used)`);
    }

    // 传递调用者数量
    if (transitiveCallers > directCallers + 5) {
      score += 2;
      factors.push(`${transitiveCallers} total callers (high transitive impact)`);
    }

    // 被调用者数量(复杂度)
    if (callees > 10) {
      score += 2;
      factors.push(`calls ${callees} other symbols (complex)`);
    }

    // 测试覆盖
    if (!hasTests) {
      score += 2;
      factors.push("no tests found");
    } else {
      score -= 1;
      factors.push("has tests");
    }

    // 确定风险等级
    let level: "low" | "medium" | "high";
    if (score <= 2) {
      level = "low";
    } else if (score <= 5) {
      level = "medium";
    } else {
      level = "high";
    }

    const explanation = `Risk assessment: ${factors.join(", ")}.`;

    return { level, score, explanation };
  }
}
