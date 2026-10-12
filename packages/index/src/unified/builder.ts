/**
 * 索引构建器
 * 
 * 协调文件扫描、符号解析和数据库写入的完整流程。
 * 支持增量更新、错误恢复和性能监控。
 * 
 * @module builder
 * 
 * @example
 * ```typescript
 * import Database from "better-sqlite3";
 * import { buildIndex } from "./builder";
 * 
 * const db = new Database("index.db");
 * const result = buildIndex(db, {
 *   root: "/path/to/project",
 *   incremental: true,
 *   maxFileSize: 5 * 1024 * 1024,
 *   excludeDirs: ["node_modules", "dist"],
 *   onProgress: (current, total, file) => {
 *     console.log(`${current}/${total}: ${file}`);
 *   }
 * });
 * 
 * console.log(`Indexed ${result.filesIndexed} files in ${result.durationMs}ms`);
 * ```
 * 
 * 职责:
 * 1. 协调文件扫描、解析和数据库写入
 * 2. 实现增量更新逻辑
 * 3. 处理错误和回滚
 * 4. 安全验证
 */

import type Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import upath from "upath";
import { join, dirname } from "node:path";
import {
  walkFileMetas,
  walkFileMetasAsync,
  computeDiffFromMetas,
  computeHash,
  MAX_FILE_SIZE,
  type FileInfo,
} from "./scanner.ts";
import {
  extractSymbols,
  extractReferences,
  extractSymbolsAsync,
  extractReferencesAsync,
  initTreeSitter,
  type ExtractedSymbol,
  type ExtractedReference,
} from "./parser.ts";
import { validateFilePath } from "./security.ts";
import type { ManifestDiff } from "./types.ts";

/**
 * 索引构建选项
 * 
 * @interface BuildOptions
 */
export interface BuildOptions {
  /** 工作区根目录的绝对路径 */
  root: string;
  /** 是否启用增量更新(默认false,全量重建) */
  incremental?: boolean;
  /** 最大索引文件大小(字节,默认130KB) */
  maxFileSize?: number;
  /** 排除的目录列表 */
  excludeDirs?: string[];
  /** 进度回调函数 */
  onProgress?: (current: number, total: number, file: string) => void;
  /** 是否使用异步扫描(默认false,推荐大型项目使用) */
  useAsyncScan?: boolean;
  /** 异步扫描的并发数(默认50) */
  scanConcurrency?: number;
  /** 即使mtime和size未变化,也强制重新索引这些相对路径。 */
  forcedPaths?: string[];
}

/**
 * 索引构建结果
 * 
 * @interface BuildResult
 */
export interface BuildResult {
  /** 成功索引的文件数 */
  filesIndexed: number;
  /** 跳过的文件数(大小超限、读取失败等) */
  filesSkipped: number;
  /** 添加的符号数 */
  symbolsAdded: number;
  /** 添加的引用数 */
  referencesAdded: number;
  /** 构建耗时(毫秒) */
  durationMs: number;
  /** 错误列表 */
  errors: string[];
}

/**
 * 构建索引
 * 
 * 扫描工作区文件,提取符号和引用,写入数据库。
 * 支持增量更新和完整性保证(事务)。
 * 
 * @param {Database.Database} db - SQLite数据库实例
 * @param {BuildOptions} options - 构建选项
 * @returns {BuildResult} 构建结果
 * 
 * @example
 * ```typescript
 * const result = buildIndex(db, {
 *   root: "/path/to/project",
 *   incremental: true,
 *   onProgress: (current, total, file) => {
 *     console.log(`Progress: ${current}/${total} - ${file}`);
 *   }
 * });
 * 
 * if (result.errors.length > 0) {
 *   console.error("Errors:", result.errors);
 * }
 * ```
 * 
 * @remarks
 * 增量更新逻辑:
 * 1. 扫描当前文件系统
 * 2. 对比数据库中已索引的文件(基于hash)
 * 3. 计算差异: added, modified, removed
 * 4. 只处理变更的文件
 * 
 * 事务保证:
 * - 所有写操作在单个事务中
 * - 失败时自动回滚
 * - 不会出现部分更新
 * 
 * 性能优化:
 * - 无变化时直接返回(<5ms)
 * - 只重建变更的文件
 * - 批量SQL操作
 * 
 * @see {@link BuildOptions} 构建选项
 * @see {@link BuildResult} 返回结果
 */
export function buildIndex(db: Database.Database, options: BuildOptions): BuildResult {
  // 如果启用了异步扫描,委托给buildIndexAsync
  if (options.useAsyncScan) {
    console.warn("[UnifiedIndex] useAsyncScan requires async function, falling back to sync scan");
    // 注意: 同步函数无法调用异步版本,需要在调用方处理
  }
  
  const startTime = Date.now();
  const errors: string[] = [];
  let filesIndexed = 0;
  let filesSkipped = 0;
  let symbolsAdded = 0;
  let referencesAdded = 0;

  console.log("[UnifiedIndex] Starting index build...");

  try {
    // Meta-only walk for cheap mtime+size diffs. Content is read per changed file.
    console.log("[UnifiedIndex] Scanning workspace metadata...");
    const currentMetas = Array.from(walkFileMetas({
      root: options.root,
      excludeDirs: options.excludeDirs,
      maxFileSize: options.maxFileSize ?? MAX_FILE_SIZE,
      onSkippedFile: () => {
        filesSkipped++;
      },
    }));
    console.log(`[UnifiedIndex] Found ${currentMetas.length} indexable files`);

    const indexedFiles = getIndexedFiles(db);
    console.log(`[UnifiedIndex] ${indexedFiles.size} files already indexed`);

    const currentMap = new Map(currentMetas.map((f) => [f.path, f]));
    const diff = computeDiffFromMetas(currentMetas, indexedFiles);
    if (!options.incremental) {
      diff.modified = currentMetas.filter((meta) => indexedFiles.has(meta.path)).map((meta) => meta.path);
    }
    console.log(
      `[UnifiedIndex] Diff: +${diff.added.length} ~${diff.modified.length} -${diff.removed.length}`
    );

    // 如果是增量更新且没有变化,仅重跑跨文件引用解析(幂等,补齐历史未解析的边)
    if (
      options.incremental &&
      diff.added.length === 0 &&
      diff.modified.length === 0 &&
      diff.removed.length === 0
    ) {
      console.log("[UnifiedIndex] No changes detected, re-resolving cross-file references");
      let crossFileRefs = 0;
      try {
        crossFileRefs = resolveCrossFileReferences(db, options.root);
        console.log(`[UnifiedIndex] Cross-file references resolved: ${crossFileRefs}`);
      } catch (error) {
        const errorMsg = `Failed to resolve cross-file references: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(errorMsg);
        console.warn(`[UnifiedIndex] ${errorMsg}`);
      }
      return {
        filesIndexed: 0,
        filesSkipped: currentMetas.length,
        symbolsAdded: 0,
        referencesAdded: crossFileRefs,
        durationMs: Date.now() - startTime,
        errors,
      };
    }

    // 开始事务 (使用IMMEDIATE模式防止并发构建冲突)
    // IMMEDIATE事务会立即获取写锁,阻止其他写操作
    const transaction = db.transaction(() => {
      // 删除已移除的文件
      if (diff.removed.length > 0) {
        console.log(`[UnifiedIndex] Removing ${diff.removed.length} deleted files...`);
        removeFiles(db, diff.removed);
      }

      // 处理新增和修改的文件
      const filesToProcess = [
        ...diff.added.map((path) => currentMap.get(path)!).filter(Boolean),
        ...diff.modified.map((path) => currentMap.get(path)!).filter(Boolean),
      ];

      console.log(`[UnifiedIndex] Processing ${filesToProcess.length} files...`);

      for (let i = 0; i < filesToProcess.length; i++) {
        const fileMeta = filesToProcess[i]!;
        
        if (options.onProgress) {
          options.onProgress(i + 1, filesToProcess.length, fileMeta.path);
        }

        try {
          // 安全验证: 验证文件路径
          const absolutePath = fileMeta.absolutePath;
          try {
            validateFilePath(absolutePath, options.root);
          } catch (error) {
            const errorMsg = `Invalid file path ${fileMeta.path}: ${error}`;
            errors.push(errorMsg);
            console.warn(`[UnifiedIndex] ${errorMsg}`);
            filesSkipped++;
            continue;
          }
          
          // 读取文件内容（单文件；循环内局部变量，不累积）
          const content = readFileSync(absolutePath, "utf-8");
          const fileInfo: FileInfo = {
            path: fileMeta.path,
            absolutePath,
            size: fileMeta.size,
            mtime: fileMeta.mtime,
            hash: computeHash(content),
            language: fileMeta.language,
          };

          // 如果文件已存在,先删除旧数据
          if (diff.modified.includes(fileInfo.path)) {
            removeFiles(db, [fileInfo.path]);
          }

          // 插入文件记录
          const fileId = insertFile(db, fileInfo);

          // 解析符号
          const symbols = extractSymbols(content, fileInfo.language || "");
          
          if (symbols.length === 0) {
            insertFileFTS(db, fileId, fileInfo.path, content);
            filesIndexed++;
            filesSkipped++;
            continue;
          }

          // 插入符号
          const symbolIds = new Map<string, number>();
          for (const symbol of symbols) {
            const symbolId = insertSymbol(db, fileId, symbol);
            symbolIds.set(symbol.name, symbolId);
            symbolsAdded++;

          }

          // 解析引用
          const references = extractReferences(content, fileInfo.language || "");

          // 为模块级引用创建一个文件级别的虚拟符号。
          // 普通调用引用会在插入时按行号绑定到所属函数/方法。
          const hasModuleReferences = references.some(
            (r) => r.refType === "import" || !r.fromSymbolName,
          );
          
          if (hasModuleReferences && !symbolIds.has("module")) {
            // 创建虚拟的module符号代表文件本身
            const moduleSymbol: ExtractedSymbol = {
              name: "module",
              kind: "module",
              startLine: 1,
              endLine: 1,
              exported: false,
            };
            
            const moduleId = insertSymbol(db, fileId, moduleSymbol);
            symbolIds.set("module", moduleId);
          }

          // 插入引用
          for (const ref of references) {
            const fromId = resolveReferenceSourceId(ref, symbols, symbolIds);

            if (!fromId) continue;

            if (ref.refType === "import" && ref.importPath) {
              // import引用:记录为未解析,稍后在resolveCrossFileReferences中解析
              insertReference(
                db,
                fromId,
                null, // to_symbol_id为NULL
                ref.refType,
                ref.line,
                ref.toSymbolName, // 保存符号名
                ref.importPath // 保存import路径
              );
              referencesAdded++;
            } else {
              // 内部引用:直接解析
              const toId = symbolIds.get(ref.toSymbolName);
              if (toId) {
                insertReference(db, fromId, toId, ref.refType, ref.line);
                referencesAdded++;
              }
            }
          }

          // 更新文件内容FTS索引
          insertFileFTS(db, fileId, fileInfo.path, content);

          filesIndexed++;
        } catch (error) {
          const errorMsg = `Failed to index ${fileMeta.path}: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(errorMsg);
          console.error(`[UnifiedIndex] ${errorMsg}`);
          filesSkipped++;
        }
      }
    });

    // 执行事务 (使用immediate模式,立即获取写锁防止并发冲突)
    try {
      transaction.immediate();
      console.log("[UnifiedIndex] Build transaction committed successfully");
    } catch (error) {
      // 检查是否是并发冲突错误
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes("database is locked") || errorMsg.includes("SQLITE_BUSY")) {
        const lockError = "Build failed: database is locked (another build may be in progress)";
        errors.push(lockError);
        console.error(`[UnifiedIndex] ${lockError}`);
        console.error("[UnifiedIndex] Please wait for the current build to finish and try again.");
      } else {
        throw error;
      }
    }

    // 第二遍: 解析跨文件 import 引用,建立符号之间的调用/依赖边
    // 第一遍只插入 to_symbol_id=NULL 的未解析 import,此处将其链接到导出符号
    try {
      const crossFileRefs = resolveCrossFileReferences(db, options.root);
      referencesAdded += crossFileRefs;
      console.log(`[UnifiedIndex] Cross-file references resolved: ${crossFileRefs}`);
    } catch (error) {
      const errorMsg = `Failed to resolve cross-file references: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(errorMsg);
      console.warn(`[UnifiedIndex] ${errorMsg}`);
    }

    const durationMs = Date.now() - startTime;
    
    // 详细的性能日志
    console.log(`[UnifiedIndex] ===== Build Performance Report =====`);
    console.log(`[UnifiedIndex] Total duration: ${durationMs}ms`);
    console.log(`[UnifiedIndex] Files processed: ${filesIndexed}`);
    console.log(`[UnifiedIndex] Files skipped: ${filesSkipped}`);
    console.log(`[UnifiedIndex] Symbols added: ${symbolsAdded}`);
    console.log(`[UnifiedIndex] References added: ${referencesAdded}`);
    
    if (filesIndexed > 0) {
      const avgTimePerFile = durationMs / filesIndexed;
      const avgSymbolsPerFile = symbolsAdded / filesIndexed;
      console.log(`[UnifiedIndex] Avg time per file: ${avgTimePerFile.toFixed(2)}ms`);
      console.log(`[UnifiedIndex] Avg symbols per file: ${avgSymbolsPerFile.toFixed(1)}`);
      console.log(`[UnifiedIndex] Throughput: ${(filesIndexed / (durationMs / 1000)).toFixed(1)} files/sec`);
    }
    
    if (errors.length > 0) {
      console.warn(`[UnifiedIndex] ${errors.length} errors occurred during build`);
    }
    console.log(`[UnifiedIndex] =====================================`);
  } catch (error) {
    const errorMsg = `Index build failed: ${error instanceof Error ? error.message : String(error)}`;
    errors.push(errorMsg);
    console.error(`[UnifiedIndex] ${errorMsg}`);
  }

  return {
    filesIndexed,
    filesSkipped,
    symbolsAdded,
    referencesAdded,
    durationMs: Date.now() - startTime,
    errors,
  };
}

/**
 * 异步构建索引
 * 
 * 与buildIndex相同,但使用异步文件扫描。
 * 推荐用于大型项目(10,000+文件)以避免阻塞。
 * 
 * @param {Database.Database} db - SQLite数据库实例
 * @param {BuildOptions} options - 构建选项
 * @returns {Promise<BuildResult>} 构建结果
 * 
 * @example
 * ```typescript
 * const result = await buildIndexAsync(db, {
 *   root: "/path/to/large/project",
 *   incremental: true,
 *   useAsyncScan: true,
 *   scanConcurrency: 100,
 * });
 * ```
 */
export async function buildIndexAsync(
  db: Database.Database,
  options: BuildOptions
): Promise<BuildResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let filesIndexed = 0;
  let filesSkipped = 0;
  let symbolsAdded = 0;
  let referencesAdded = 0;

  console.log("[UnifiedIndex] Starting async index build...");

  try {
    // 初始化 Tree-sitter WASM（仅首次调用时实际加载）
    await initTreeSitter();
    console.log("[UnifiedIndex] Tree-sitter initialized");

    // 只扫描文件元数据，不读取全文；内容仅在处理变更文件时按单文件读取。
    console.log("[UnifiedIndex] Scanning workspace metadata (async)...");
    const currentMetas = await walkFileMetasAsync({
      root: options.root,
      excludeDirs: options.excludeDirs,
      maxFileSize: options.maxFileSize ?? MAX_FILE_SIZE,
      onSkippedFile: () => { filesSkipped++; },
    });
    console.log(`[UnifiedIndex] Found ${currentMetas.length} indexable files`);

    const indexedFiles = getIndexedFiles(db);
    const indexedWithSize = new Map(Array.from(indexedFiles.entries()).map(([path, value]) => [path, value]));
    const diff = computeDiffFromMetas(currentMetas, indexedWithSize);
    if (!options.incremental) {
      diff.modified = currentMetas.filter((meta) => indexedFiles.has(meta.path)).map((meta) => meta.path);
    }
    const currentPaths = new Set(currentMetas.map((meta) => meta.path));
    for (const forcedPath of options.forcedPaths ?? []) {
      const normalizedPath = upath.normalize(forcedPath);
      if (currentPaths.has(normalizedPath) && !diff.modified.includes(normalizedPath)) {
        diff.modified.push(normalizedPath);
      }
    }
    console.log(`[UnifiedIndex] Diff: +${diff.added.length} ~${diff.modified.length} -${diff.removed.length}`);

    const currentMap = new Map(currentMetas.map((meta) => [meta.path, meta]));

    if (
      options.incremental &&
      diff.added.length === 0 &&
      diff.modified.length === 0 &&
      diff.removed.length === 0
    ) {
      console.log("[UnifiedIndex] No changes detected, skipping build");
      return {
        filesIndexed: 0,
        filesSkipped: currentMetas.length,
        symbolsAdded: 0,
        referencesAdded: 0,
        durationMs: Date.now() - startTime,
        errors: [],
      };
    }

    // Single-file pipeline: never accumulate all contents/symbols in memory.
    const filesToProcess = [
      ...diff.added.map((path) => currentMap.get(path)!).filter(Boolean),
      ...diff.modified.map((path) => currentMap.get(path)!).filter(Boolean),
    ];
    const BATCH = 32;
    console.log(`[UnifiedIndex] Streaming ${filesToProcess.length} changed files (batch=${BATCH})`);

    if (diff.removed.length > 0) {
      console.log(`[UnifiedIndex] Removing ${diff.removed.length} deleted files...`);
      try {
        const removeTxn = db.transaction(() => removeFiles(db, diff.removed));
        removeTxn.immediate();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to remove deleted files: ${errorMsg}`);
        console.error(`[UnifiedIndex] ${errorMsg}`);
      }
    }

    for (let i = 0; i < filesToProcess.length; i += BATCH) {
      const batch = filesToProcess.slice(i, i + BATCH);
      const writeOne = db.transaction((
        fileInfo: typeof batch[number],
        content: string,
        symbols: ExtractedSymbol[],
        references: ExtractedReference[],
      ) => {
        if (diff.modified.includes(fileInfo.path)) {
          removeFiles(db, [fileInfo.path]);
        }
        const fileRecord: FileInfo = {
          path: fileInfo.path,
          absolutePath: fileInfo.absolutePath,
          size: fileInfo.size,
          mtime: fileInfo.mtime,
          hash: computeHash(content),
          language: fileInfo.language,
        };
        const fileId = insertFile(db, fileRecord);
        if (symbols.length === 0) {
          insertFileFTS(db, fileId, fileInfo.path, content);
          return { indexed: true, symbols: 0, references: 0, skippedEmpty: true };
        }

        const symbolIds = new Map<string, number>();
        let localSymbols = 0;
        let localRefs = 0;
        for (const symbol of symbols) {
          const symbolId = insertSymbol(db, fileId, symbol);
          symbolIds.set(symbol.name, symbolId);
          localSymbols++;
        }

        const hasModuleReferences = references.some(
          (r) => r.refType === "import" || !r.fromSymbolName,
        );
        if (hasModuleReferences && !symbolIds.has("module")) {
          const moduleId = insertSymbol(db, fileId, {
            name: "module",
            kind: "module",
            startLine: 1,
            endLine: 1,
            exported: false,
          });
          symbolIds.set("module", moduleId);
        }

        for (const ref of references) {
          const fromId = resolveReferenceSourceId(ref, symbols, symbolIds);
          if (!fromId) continue;
          if (ref.refType === "import" && ref.importPath) {
            insertReference(db, fromId, null, ref.refType, ref.line, ref.toSymbolName, ref.importPath);
            localRefs++;
          } else {
            const toId = symbolIds.get(ref.toSymbolName);
            if (toId) {
              insertReference(db, fromId, toId, ref.refType, ref.line);
              localRefs++;
            }
          }
        }

        insertFileFTS(db, fileId, fileInfo.path, content);
        return { indexed: true, symbols: localSymbols, references: localRefs, skippedEmpty: false };
      });

      for (let j = 0; j < batch.length; j++) {
        const fileInfo = batch[j]!;
        const overall = i + j + 1;
        options.onProgress?.(overall, filesToProcess.length, fileInfo.path);
        try {
          validateFilePath(fileInfo.absolutePath, options.root);
          const content = readFileSync(fileInfo.absolutePath, "utf-8");
          const [symbols, references] = await Promise.all([
            extractSymbolsAsync(content, fileInfo.language || ""),
            extractReferencesAsync(content, fileInfo.language || ""),
          ]);
          try {
            const result = writeOne.immediate(fileInfo, content, symbols, references);
            if (result.skippedEmpty) filesSkipped++;
            else {
              filesIndexed++;
              symbolsAdded += result.symbols;
              referencesAdded += result.references;
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (errorMsg.includes("database is locked") || errorMsg.includes("SQLITE_BUSY")) {
              errors.push(`Async build failed: database is locked while indexing ${fileInfo.path}`);
              console.error(`[UnifiedIndex] database locked on ${fileInfo.path}`);
            } else {
              errors.push(`Failed to index ${fileInfo.path}: ${errorMsg}`);
              console.error(`[UnifiedIndex] Failed to index ${fileInfo.path}:`, error);
            }
            filesSkipped++;
          }
        } catch (error) {
          const errorMsg = `Failed to parse ${fileInfo.path}: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(errorMsg);
          console.error(`[UnifiedIndex] ${errorMsg}`);
          filesSkipped++;
        }
      }
    }

    // 第二遍: 解析跨文件 import 引用
    try {
      const crossFileRefs = resolveCrossFileReferences(db, options.root);
      referencesAdded += crossFileRefs;
      console.log(`[UnifiedIndex] Cross-file references resolved: ${crossFileRefs}`);
    } catch (error) {
      const errorMsg = `Failed to resolve cross-file references: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(errorMsg);
      console.warn(`[UnifiedIndex] ${errorMsg}`);
    }

    const durationMs = Date.now() - startTime;

    console.log(`[UnifiedIndex] ===== Async Build Performance Report =====`);
    console.log(`[UnifiedIndex] Total duration: ${durationMs}ms`);
    console.log(`[UnifiedIndex] Files processed: ${filesIndexed}`);
    console.log(`[UnifiedIndex] Files skipped: ${filesSkipped}`);
    console.log(`[UnifiedIndex] Symbols added: ${symbolsAdded}`);
    console.log(`[UnifiedIndex] References added: ${referencesAdded}`);

    if (filesIndexed > 0) {
      const avgTimePerFile = durationMs / filesIndexed;
      const avgSymbolsPerFile = symbolsAdded / filesIndexed;
      console.log(`[UnifiedIndex] Avg time per file: ${avgTimePerFile.toFixed(2)}ms`);
      console.log(`[UnifiedIndex] Avg symbols per file: ${avgSymbolsPerFile.toFixed(1)}`);
      console.log(`[UnifiedIndex] Throughput: ${(filesIndexed / (durationMs / 1000)).toFixed(1)} files/sec`);
    }

    if (errors.length > 0) {
      console.warn(`[UnifiedIndex] ${errors.length} errors occurred during build`);
    }
    console.log(`[UnifiedIndex] =====================================`);
  } catch (error) {
    const errorMsg = `Async index build failed: ${error instanceof Error ? error.message : String(error)}`;
    errors.push(errorMsg);
    console.error(`[UnifiedIndex] ${errorMsg}`);
  }

  return {
    filesIndexed,
    filesSkipped,
    symbolsAdded,
    referencesAdded,
    durationMs: Date.now() - startTime,
    errors,
  };
}

/**
 * 增量更新索引
 */
export function updateIndex(
  db: Database.Database,
  root: string,
  _diff: ManifestDiff
): BuildResult {
  return buildIndex(db, {
    root,
    incremental: true,
    maxFileSize: MAX_FILE_SIZE,
  });
}

// ========== 数据库操作 ==========

function getIndexedFiles(
  db: Database.Database
): Map<string, { hash: string; mtime: number; size: number }> {
  const rows = db
    .prepare("SELECT path, hash, mtime, size FROM files")
    .all() as Array<{ path: string; hash: string; mtime: number; size: number }>;

  return new Map(rows.map((row) => [row.path, { hash: row.hash, mtime: row.mtime, size: row.size }]));
}

function removeFiles(db: Database.Database, paths: string[]): void {
  if (paths.length === 0) return;

  const placeholders = paths.map(() => "?").join(",");
  const fileIds = db
    .prepare(`SELECT id FROM files WHERE path IN (${placeholders})`)
    .pluck()
    .all(...paths) as number[];

  if (fileIds.length > 0) {
    const idPlaceholders = fileIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM files_fts WHERE rowid IN (${idPlaceholders})`).run(...fileIds);
  }

  db.prepare(`DELETE FROM files WHERE path IN (${placeholders})`).run(...paths);
}

function insertFile(db: Database.Database, fileInfo: FileInfo): number {
  const stmt = db.prepare(`
    INSERT INTO files (path, language, size, hash, indexed_at, mtime)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    fileInfo.path,
    fileInfo.language,
    fileInfo.size,
    fileInfo.hash,
    Date.now(),
    fileInfo.mtime
  );

  return result.lastInsertRowid as number;
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  symbol: {
    name: string;
    qualifiedName?: string;
    kind: string;
    startLine: number;
    endLine: number;
    exported: boolean;
    signature?: string;
    doc?: string;
  }
): number {
  const stmt = db.prepare(`
    INSERT INTO symbols (
      file_id, name, qualified_name, kind,
      start_line, end_line, exported, signature, doc
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    fileId,
    symbol.name,
    symbol.qualifiedName ?? null,
    symbol.kind,
    symbol.startLine,
    symbol.endLine,
    symbol.exported ? 1 : 0,
    symbol.signature ?? null,
    symbol.doc ?? null
  );

  return result.lastInsertRowid as number;
}

function insertReference(
  db: Database.Database,
  fromId: number,
  toId: number | null,
  refType: string,
  line: number,
  toSymbolName?: string,
  toFilePath?: string
): void {
  if (toId !== null) {
    // 已解析的引用
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO symbol_references (from_symbol_id, to_symbol_id, ref_type, line)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(fromId, toId, refType, line);
  } else if (toSymbolName && toFilePath) {
    // 未解析的引用(import)
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO symbol_references (
        from_symbol_id, to_symbol_id, to_symbol_name, to_file_path, ref_type, line
      )
      VALUES (?, NULL, ?, ?, ?, ?)
    `);
    stmt.run(fromId, toSymbolName, toFilePath, refType, line);
  }
}

function insertFileFTS(
  db: Database.Database,
  fileId: number,
  path: string,
  content: string
): void {
  // 限制内容长度,避免FTS索引过大
  const maxContentLength = 50000; // 约50KB
  const truncatedContent =
    content.length > maxContentLength ? content.slice(0, maxContentLength) : content;

  db.prepare(`DELETE FROM files_fts WHERE rowid = ?`).run(fileId);
  const stmt = db.prepare(`
    INSERT INTO files_fts (rowid, path, content)
    VALUES (?, ?, ?)
  `);

  stmt.run(fileId, path, truncatedContent);
}

/**
 * Resolve a reference's source to the innermost symbol containing its line.
 * Both Tree-sitter and the regex fallback emit an empty source name for calls,
 * so binding by source range is more reliable than parser-side global state.
 */
function resolveReferenceSourceId(
  ref: ExtractedReference,
  symbols: ExtractedSymbol[],
  symbolIds: Map<string, number>,
): number | undefined {
  if (ref.refType === "import" || ref.fromSymbolName === "module") {
    return symbolIds.get("module");
  }

  if (ref.fromSymbolName) {
    const namedId = symbolIds.get(ref.fromSymbolName);
    if (namedId) return namedId;
  }

  const candidates = symbols
    .map((symbol) => ({ symbol, id: symbolIds.get(symbol.name) }))
    .filter(
      (entry): entry is { symbol: ExtractedSymbol; id: number } =>
        entry.id !== undefined &&
        entry.symbol.kind !== "module" &&
        entry.symbol.startLine <= ref.line &&
        entry.symbol.endLine >= ref.line,
    )
    .sort(
      (a, b) =>
        (a.symbol.endLine - a.symbol.startLine) -
        (b.symbol.endLine - b.symbol.startLine),
    );

  if (candidates[0]?.id) return candidates[0].id;

  // The regex fallback reports a one-line definition range. In that mode,
  // associate a call with the nearest preceding function/method instead of
  // dropping the edge entirely.
  const preceding = symbols
    .map((symbol) => ({ symbol, id: symbolIds.get(symbol.name) }))
    .filter(
      (entry): entry is { symbol: ExtractedSymbol; id: number } =>
        entry.id !== undefined &&
        entry.symbol.kind !== "module" &&
        entry.symbol.startLine <= ref.line,
    )
    .sort((a, b) => b.symbol.startLine - a.symbol.startLine);

  return preceding[0]?.id ?? symbolIds.get("module");
}

/**
 * 跨文件引用解析(第二遍)
 * 
 * 在所有文件索引完成后,解析import语句并链接到外部符号。
 * 这需要模块解析逻辑来确定import的实际文件路径。
 * 
 * @param db - 数据库连接
 * @param root - 工作区根目录
 * @returns 解析的跨文件引用数量
 * 
 * @example
 * ```typescript
 * // 第一遍: 索引所有文件和内部引用
 * buildIndex(db, options);
 * 
 * // 第二遍: 解析跨文件引用
 * const crossFileRefs = resolveCrossFileReferences(db, options.root);
 * console.log(`Linked ${crossFileRefs} cross-file references`);
 * ```
 * 
 * @remarks
 * 当前实现的限制:
 * - 只支持相对路径import (./xxx, ../xxx)
 * - 不支持node_modules解析
 * - 不支持路径别名 (@/xxx)
 * - 不支持package.json的exports字段
 * 
 * 未来改进:
 * - 集成完整的Node.js模块解析算法
 * - 支持TypeScript的paths配置
 * - 缓存解析结果提升性能
 */
export function resolveCrossFileReferences(
  db: Database.Database,
  root: string
): number {
  console.log("[UnifiedIndex] Resolving cross-file references...");
  
  let referencesAdded = 0;
  
  // 获取所有import类型的引用(to_symbol_id为NULL表示未解析)
  const importRefs = db.prepare(`
    SELECT 
      sr.id as ref_id,
      sr.from_symbol_id,
      sr.to_symbol_name,
      sr.line,
      sf.path as from_file_path,
      sf.id as from_file_id
    FROM symbol_references sr
    JOIN symbols s ON sr.from_symbol_id = s.id
    JOIN files sf ON s.file_id = sf.id
    WHERE sr.ref_type = 'import'
      AND sr.to_symbol_id IS NULL
  `).all() as Array<{
    ref_id: number;
    from_symbol_id: number;
    to_symbol_name: string;
    line: number;
    from_file_path: string;
    from_file_id: number;
  }>;
  
  console.log(`[UnifiedIndex] Found ${importRefs.length} unresolved import references`);
  
  if (importRefs.length === 0) {
    return 0;
  }
  
  // 为每个import尝试解析
  for (const ref of importRefs) {
    try {
      // 读取源文件内容,提取import路径
      const sourceFilePath = join(root, ref.from_file_path);
      const content = readFileSync(sourceFilePath, 'utf-8');
      
      // 查找这个import语句
      const lines = content.split('\n');
      if (ref.line <= 0 || ref.line > lines.length) {
        continue;
      }
      
      const importLine = lines[ref.line - 1];
      
      // 提取import路径 (简化版,支持相对路径及动态import)
      const importPathMatch =
        importLine.match(/from\s+['"]([^'"]+)['"]/) ??
        importLine.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (!importPathMatch) {
        continue;
      }
      
      const importPath = importPathMatch[1];
      
      // 只处理相对路径import
      if (!importPath.startsWith('./') && !importPath.startsWith('../')) {
        continue;
      }
      
      // 解析目标文件路径
      const sourceDir = dirname(sourceFilePath);
      let targetPath = join(sourceDir, importPath);
      
      // 尝试添加常见扩展名
      const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
      let resolvedPath: string | null = null;
      
      for (const ext of ['', ...extensions]) {
        const candidatePath = targetPath + ext;
        if (existsSync(candidatePath)) {
          resolvedPath = upath.relative(root, candidatePath);
          break;
        }
      }
      
      if (!resolvedPath) {
        // 尝试index文件
        for (const ext of extensions) {
          const indexPath = join(targetPath, `index${ext}`);
          if (existsSync(indexPath)) {
            resolvedPath = upath.relative(root, indexPath);
            break;
          }
        }
      }
      
      // 动态 import 常带 .js 后缀（TS 源码下运行时解析到 .ts），
      // 若上面未命中，尝试把 .js 后缀替换为 .ts/.tsx 源文件
      if (!resolvedPath && /\.(js|jsx|mjs|cjs)$/.test(importPath)) {
        for (const ext of ['.ts', '.tsx']) {
          const candidatePath = targetPath.replace(/\.(js|jsx|mjs|cjs)$/, ext);
          if (existsSync(candidatePath)) {
            resolvedPath = upath.relative(root, candidatePath);
            break;
          }
        }
      }
      
      if (!resolvedPath) {
        continue;
      }
      
      // 查找目标文件中导出的符号
      const targetSymbol = db.prepare(`
        SELECT s.id
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE f.path = ?
          AND s.name = ?
          AND s.exported = 1
        LIMIT 1
      `).get(resolvedPath, ref.to_symbol_name) as { id: number } | undefined;
      
      if (targetSymbol) {
        // 更新引用,链接到目标符号
        db.prepare(`
          UPDATE symbol_references
          SET to_symbol_id = ?
          WHERE id = ?
        `).run(targetSymbol.id, ref.ref_id);
        
        referencesAdded++;
      }
    } catch (error) {
      // 跳过无法解析的引用
      console.warn(`[UnifiedIndex] Failed to resolve reference: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  console.log(`[UnifiedIndex] Resolved ${referencesAdded} cross-file references`);
  
  return referencesAdded;
}
/**
 * 异步增量更新索引
 */
export async function updateIndexAsync(
  db: Database.Database,
  root: string,
  diff: ManifestDiff,
  excludeDirs?: string[],
): Promise<BuildResult> {
  // Recompute with meta walk inside buildIndexAsync; do not rescan full contents.
  return await buildIndexAsync(db, {
    root,
    incremental: true,
    useAsyncScan: true,
    maxFileSize: MAX_FILE_SIZE,
    excludeDirs,
    forcedPaths: [...diff.added, ...diff.modified],
  });
}
