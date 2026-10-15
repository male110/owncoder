/**
 * 文件系统扫描器
 * 
 * 职责:
 * 1. 扫描工作区文件
 * 2. 检测文件变更
 * 3. 生成增量更新差异
 * 
 * 提供同步和异步两种扫描模式:
 * - scanWorkspace: 同步扫描(快速,适合中小型项目)
 * - scanWorkspaceAsync: 异步扫描(适合大型项目,不阻塞)
 */

import { readdirSync, statSync, readFileSync, realpathSync } from "node:fs";
import { readdir, stat, readFile } from "node:fs/promises";
import upath from "upath";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import ignore from "ignore";
import type { ManifestDiff } from "./types.ts";

const ALWAYS_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".output",
  ".cache",
  ".owncoder",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  "third_party",
]);

const INDEXABLE_EXTENSIONS = new Set([
  // JavaScript/TypeScript
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  // Python
  ".py",
  ".pyx",
  // Rust
  ".rs",
  // Go
  ".go",
  // Java/Kotlin
  ".java",
  ".kt",
  ".kts",
  // C/C++
  ".c",
  ".cpp",
  ".cc",
  ".cxx",
  ".h",
  ".hpp",
  ".hxx",
  // C#
  ".cs",
  // Ruby
  ".rb",
  // PHP
  ".php",
  // Swift
  ".swift",
  // Scala
  ".scala",
  // 其他编程语言
  ".zig",
  ".lua",
  ".dart",
  ".ex",
  ".exs",
  ".elm",
  ".ml",
  ".mli",
  ".res",
  ".resi",
  ".el",
  ".sh",
  ".bash",
  ".m",
  ".mm",
  ".sol",
  ".ql",
  ".qll",
  // 样式、标记与配置文件
  ".css",
  ".html",
  ".htm",
  ".vue",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
]);

export const MAX_FILE_SIZE = 130 * 1024; // 130KB

export interface FileInfo {
  path: string;
  absolutePath: string;
  size: number;
  mtime: number;
  hash: string;
  language: string | null;
}

/** Cheap filesystem identity. No file content. */
export interface FileMeta {
  path: string;
  absolutePath: string;
  size: number;
  mtime: number;
  language: string | null;
}

export interface ScanOptions {
  root: string;
  excludeDirs?: string[];
  maxFileSize?: number;
  respectGitignore?: boolean;
  /**
   * 可选回调:当文件因超出 maxFileSize 被过滤时触发。
   * 供调用方(如 builder)统计被跳过的文件数量。
   */
  onSkippedFile?: (path: string, reason: string) => void;
}

/**
 * 扫描工作区并返回所有可索引的文件(Generator模式)
 * 
 * 使用Generator逐个yield文件,避免大型项目一次性加载所有文件到内存。
 * 
 * @param options - 扫描选项
 * @yields {FileInfo} 每个可索引的文件信息
 * 
 * @example
 * ```typescript
 * // 迭代器模式
 * for (const file of scanWorkspace({ root: "/path/to/project" })) {
 *   console.log(file.path);
 * }
 * 
 * // 或者转换为数组(如果确定内存足够)
 * const files = Array.from(scanWorkspace({ root: "/path/to/project" }));
 * ```
 * 
 * @remarks
 * Generator模式优势:
 * - 内存友好: 不会一次性加载所有文件
 * - 可中断: 可以提前停止扫描
 * - 流式处理: 可以边扫描边处理
 * 
 * 性能建议:
 * - 中小型项目(<5000文件): 使用Array.from()一次性加载
 * - 大型项目(>5000文件): 迭代处理或使用scanWorkspaceAsync()
 */
export function* scanWorkspace(options: ScanOptions): Generator<FileInfo, void, undefined> {
  const {
    root,
    excludeDirs = [],
    maxFileSize = MAX_FILE_SIZE,
    respectGitignore = true,
    onSkippedFile,
  } = options;

  const skipDirs = new Set([...ALWAYS_SKIP_DIRS, ...excludeDirs]);
  const ig = respectGitignore ? loadGitignore(root) : null;
  
  // 跟踪已访问的目录以防止symlink循环
  const visitedDirs = new Set<string>();

  function* walk(dir: string): Generator<FileInfo, void, undefined> {
    // 规范化路径并检查是否已访问(防止symlink循环)
    let normalizedDir: string;
    try {
      const stat = statSync(dir);
      // 使用inode作为唯一标识(在Windows上使用realpathSync解析真实路径)
      if (process.platform === 'win32') {
        try {
          // 在Windows上，realpathSync解析symlink到真实路径
          normalizedDir = upath.normalize(realpathSync(dir)).toLowerCase();
        } catch {
          // 如果realpathSync失败(权限问题等)，降级到路径比较
          normalizedDir = upath.normalize(dir).toLowerCase();
        }
      } else {
        // POSIX系统使用dev:ino唯一标识
        normalizedDir = `${stat.dev}:${stat.ino}`;
      }
      
      if (visitedDirs.has(normalizedDir)) {
        console.warn(`[Scanner] Skipping symlink cycle detected: ${dir}`);
        return;
      }
      visitedDirs.add(normalizedDir);
    } catch {
      return; // 无法访问目录,跳过
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 无法读取目录,跳过
    }

    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      const relativePath = relative(root, absolutePath);

      // 检查gitignore
      if (ig && ig.ignores(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          yield* walk(absolutePath);
        }
      } else if (entry.isFile()) {
        // 检查文件扩展名
        if (!isIndexableFile(entry.name)) {
          continue;
        }

        // 检查文件大小
        let stat;
        try {
          stat = statSync(absolutePath);
        } catch {
          continue;
        }

        if (stat.size > maxFileSize) {
          onSkippedFile?.(upath.normalize(relativePath), "maxFileSize");
          continue;
        }

        // 读取文件并计算hash
        let content;
        try {
          content = readFileSync(absolutePath, "utf-8");
        } catch {
          continue; // 无法读取(可能是二进制文件或编码问题)
        }

        const hash = computeHash(content);
        const language = detectLanguage(entry.name);

        yield {
          path: upath.normalize(relativePath), // 标准化路径分隔符
          absolutePath,
          size: stat.size,
          mtime: stat.mtimeMs,
          hash,
          language,
        };
      }
    }
  }

  yield* walk(root);
}

/**
 * Walk the workspace with readdir/stat only. Never reads file contents.
 * Use this for cheap mtime+size diffs so the main/index process does not
 * materialize every source file as a UTF-8 string.
 */
export function* walkFileMetas(options: ScanOptions): Generator<FileMeta, void, undefined> {
  const {
    root,
    excludeDirs = [],
    maxFileSize = MAX_FILE_SIZE,
    respectGitignore = true,
    onSkippedFile,
  } = options;

  const skipDirs = new Set([...ALWAYS_SKIP_DIRS, ...excludeDirs]);
  const ig = respectGitignore ? loadGitignore(root) : null;
  const visitedDirs = new Set<string>();

  function* walk(dir: string): Generator<FileMeta, void, undefined> {
    let normalizedDir: string;
    try {
      const dirStat = statSync(dir);
      if (process.platform === "win32") {
        try {
          normalizedDir = upath.normalize(realpathSync(dir)).toLowerCase();
        } catch {
          normalizedDir = upath.normalize(dir).toLowerCase();
        }
      } else {
        normalizedDir = `${dirStat.dev}:${dirStat.ino}`;
      }
      if (visitedDirs.has(normalizedDir)) return;
      visitedDirs.add(normalizedDir);
    } catch {
      return;
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      const relativePath = relative(root, absolutePath);
      if (ig && ig.ignores(relativePath)) continue;

      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) yield* walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !isIndexableFile(entry.name)) continue;

      let fileStat;
      try {
        fileStat = statSync(absolutePath);
      } catch {
        continue;
      }
      if (fileStat.size > maxFileSize) {
        onSkippedFile?.(upath.normalize(relativePath), "maxFileSize");
        continue;
      }

      yield {
        path: upath.normalize(relativePath),
        absolutePath,
        size: fileStat.size,
        mtime: fileStat.mtimeMs,
        language: detectLanguage(entry.name),
      };
    }
  }

  yield* walk(root);
}

export async function walkFileMetasAsync(options: ScanOptions): Promise<FileMeta[]> {
  const metas: FileMeta[] = [];
  for (const meta of walkFileMetas(options)) {
    metas.push(meta);
    if (metas.length % 200 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return metas;
}

/**
 * 异步扫描工作区(推荐用于大型项目)
 * 
 * 使用异步I/O避免阻塞主线程,适合10,000+文件的大型项目。
 * 支持并发控制,防止打开过多文件句柄。
 * 
 * @param options - 扫描选项
 * @param options.root - 工作区根目录
 * @param options.excludeDirs - 排除的目录列表
 * @param options.maxFileSize - 最大文件大小(字节)
 * @param options.respectGitignore - 是否遵守.gitignore
 * @param options.concurrency - 并发数(默认50)
 * @returns Promise<FileInfo[]> 文件信息数组
 * 
 * @example
 * ```typescript
 * const files = await scanWorkspaceAsync({
 *   root: "/path/to/large/project",
 *   concurrency: 100
 * });
 * ```
 */
export async function scanWorkspaceAsync(
  options: ScanOptions & { concurrency?: number }
): Promise<FileInfo[]> {
  const {
    root,
    excludeDirs = [],
    maxFileSize = MAX_FILE_SIZE,
    respectGitignore = true,
    concurrency = 50,
    onSkippedFile,
  } = options;

  const skipDirs = new Set([...ALWAYS_SKIP_DIRS, ...excludeDirs]);
  const ig = respectGitignore ? loadGitignore(root) : null;
  const files: FileInfo[] = [];

  // 并发控制: 使用信号量限制同时处理的文件数
  let activeCount = 0;
  
  // 跟踪已访问的目录以防止symlink循环
  const visitedDirs = new Set<string>();

  async function processFile(
    absolutePath: string,
    relativePath: string,
    filename: string
  ): Promise<void> {
    // 检查文件扩展名
    if (!isIndexableFile(filename)) {
      return;
    }

    // 检查文件大小
    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      return;
    }

    if (fileStat.size > maxFileSize) {
      onSkippedFile?.(upath.normalize(relativePath), "maxFileSize");
      return;
    }

    // 读取文件并计算hash
    let content;
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch {
      return; // 无法读取
    }

    const hash = computeHash(content);
    const language = detectLanguage(filename);

    files.push({
      path: upath.normalize(relativePath),
      absolutePath,
      size: fileStat.size,
      mtime: fileStat.mtimeMs,
      hash,
      language,
    });
  }

  async function walk(dir: string): Promise<void> {
    // 规范化路径并检查是否已访问(防止symlink循环)
    let normalizedDir: string;
    try {
      const dirStat = await stat(dir);
      // 使用inode作为唯一标识(在Windows上使用realpath解析真实路径)
      if (process.platform === 'win32') {
        try {
          const { realpath } = await import('node:fs/promises');
          normalizedDir = upath.normalize(await realpath(dir)).toLowerCase();
        } catch {
          // 如果realpath失败(权限问题等)，降级到路径比较
          normalizedDir = upath.normalize(dir).toLowerCase();
        }
      } else {
        // POSIX系统使用dev:ino唯一标识
        normalizedDir = `${dirStat.dev}:${dirStat.ino}`;
      }
      
      if (visitedDirs.has(normalizedDir)) {
        console.warn(`[Scanner] Skipping symlink cycle detected: ${dir}`);
        return;
      }
      visitedDirs.add(normalizedDir);
    } catch {
      return; // 无法访问目录,跳过
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无法读取目录,跳过
    }

    const tasks: Array<Promise<void>> = [];

    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      const relativePath = relative(root, absolutePath);

      // 检查gitignore
      if (ig && ig.ignores(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          tasks.push(walk(absolutePath));
        }
      } else if (entry.isFile()) {
        // 并发控制
        const task = async () => {
          while (activeCount >= concurrency) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          activeCount++;
          try {
            await processFile(absolutePath, relativePath, entry.name);
          } finally {
            activeCount--;
          }
        };
        tasks.push(task());
      }
    }

    await Promise.all(tasks);
  }

  await walk(root);
  return files;
}

/**
 * 比较当前文件系统和已索引的文件,生成差异
 */
export function computeDiff(
  current: Map<string, FileInfo>,
  indexed: Map<string, { hash: string; mtime: number }>
): ManifestDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  // 检查当前文件
  for (const [path, info] of current.entries()) {
    const indexedInfo = indexed.get(path);
    if (!indexedInfo) {
      added.push(path);
    } else if (indexedInfo.hash !== info.hash) {
      modified.push(path);
    }
  }

  // 检查已删除的文件
  for (const path of indexed.keys()) {
    if (!current.has(path)) {
      removed.push(path);
    }
  }

  return { added, modified, removed };
}

/**
 * Diff using only path + mtime + size. Unchanged files are never read.
 * Hash is computed later, only for added/modified candidates.
 */
export function computeDiffFromMetas(
  current: Iterable<FileMeta>,
  indexed: Map<string, { hash: string; mtime: number; size?: number }>,
): ManifestDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const seen = new Set<string>();

  for (const meta of current) {
    seen.add(meta.path);
    const prev = indexed.get(meta.path);
    if (!prev) {
      added.push(meta.path);
      continue;
    }
    const sizeChanged = prev.size != null && prev.size !== meta.size;
    if (sizeChanged || prev.mtime !== meta.mtime) {
      modified.push(meta.path);
    }
  }

  const removed: string[] = [];
  for (const path of indexed.keys()) {
    if (!seen.has(path)) removed.push(path);
  }

  return { added, modified, removed };
}

export function hashFile(absolutePath: string): string {
  const content = readFileSync(absolutePath, "utf-8");
  return computeHash(content);
}

/**
 * 计算文件内容的SHA-256哈希
 */
export function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * 检查文件是否可索引
 */
function isIndexableFile(filename: string): boolean {
  // 常见的以点开头的配置文件，应该被索引
  const DOT_FILES_TO_INDEX = new Set([
    '.gitignore',
    '.gitattributes',
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
    '.env.test',
    '.npmrc',
    '.yarnrc',
    '.editorconfig',
    '.prettierrc',
    '.prettierignore',
    '.eslintrc',
    '.eslintignore',
    '.dockerignore',
    '.browserslistrc',
    '.babelrc',
    '.nvmrc',
  ]);

  // 检查是否是需要索引的点文件
  if (filename.startsWith('.')) {
    if (DOT_FILES_TO_INDEX.has(filename.toLowerCase())) return true;
  }

  // 正常的扩展名检查
  const ext = filename.slice(filename.lastIndexOf("."));
  return INDEXABLE_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * 根据文件扩展名检测语言
 */
export function detectLanguage(filename: string): string | null {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  
  const languageMap: Record<string, string> = {
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".py": "python",
    ".pyx": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".hxx": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".scala": "scala",
    ".zig": "zig",
    ".lua": "lua",
    ".dart": "dart",
    ".ex": "elixir",
    ".exs": "elixir",
    ".elm": "elm",
    ".ml": "ocaml",
    ".mli": "ocaml",
    ".res": "rescript",
    ".resi": "rescript",
    ".el": "elisp",
    ".sh": "bash",
    ".bash": "bash",
    ".m": "objc",
    ".mm": "objc",
    ".sol": "solidity",
    ".ql": "ql",
    ".qll": "ql",
    ".css": "css",
    ".html": "html",
    ".htm": "html",
    ".vue": "vue",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
  };

  return languageMap[ext] ?? null;
}

/**
 * 加载并解析.gitignore文件
 */
function loadGitignore(root: string): ReturnType<typeof ignore> | null {
  try {
    const gitignorePath = join(root, ".gitignore");
    const content = readFileSync(gitignorePath, "utf-8");
    return ignore().add(content);
  } catch {
    return null;
  }
}

/**
 * 快速扫描 - 只计算hash,不读取文件内容
 */
export function quickScan(
  root: string,
  paths: string[]
): Map<string, { hash: string; mtime: number }> {
  const result = new Map<string, { hash: string; mtime: number }>();

  for (const path of paths) {
    try {
      const absolutePath = join(root, path);
      const stat = statSync(absolutePath);
      const content = readFileSync(absolutePath, "utf-8");
      const hash = computeHash(content);

      result.set(path, {
        hash,
        mtime: stat.mtimeMs,
      });
    } catch {
      // 文件不存在或无法读取,跳过
    }
  }

  return result;
}
