import type { IndexStatus, MapOpts, Tag } from "@owncoder/shared";

export interface CallSite {
  path: string;
  name: string;
  line: number;
}

export interface GraphResult {
  symbol: string;
  definition?: Tag;
  callers: CallSite[];
  callees: CallSite[];
}

export interface RagHit {
  chunkId: string;
  filePath: string;
  symbol: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  score: number;
  semanticScore: number;
}

export interface ManifestDiff {
  added: string[];
  modified: string[];
  removed: string[];
}

export interface SearchOptions {
  limit?: number;
  symbolKind?: string[];
  pathPrefix?: string;
}

export interface SymbolSearchResult {
  path: string;
  name: string;
  qualifiedName?: string;
  kind: string;
  line: number;
  endLine?: number;
  signature?: string;
  doc?: string;
  score: number;
}

export type IndexOpenMode = "query" | "build";

export interface IndexOpenOptions {
  /**
   * query: open existing SQLite for reads only (main process).
   * build: open writable DB and run incremental/full index (utility worker).
   */
  mode?: IndexOpenMode;
}

/**
 * 语义检索端口（代码向量索引的可选能力）。
 *
 * 构建侧（index-worker）：embedBatch 用于符号 chunk 批量嵌入；
 * 查询侧（main）：embedQuery 用于 ragSearch 的查询嵌入；
 * loadVec 在 adapter open 时注册 sqlite-vec 模块（构建写 vec0、查询 KNN
 * 都需要模块在本连接注册）。桌面端注入（bge-small + sqlite-vec 均在
 * desktop 依赖里）；CLI/headless 无端口 → ragSearch 维持空数组，
 * 消费方 hybrid 自动降级 FTS。
 */
export interface SemanticSearchPort {
  /** 批量嵌入（构建侧 chunk；查询侧亦可单条调用）。 */
  embedBatch(texts: string[]): Promise<Array<Float32Array | number[]>>;
  /** 嵌入单个查询文本（查询侧 ragSearch）。 */
  embedQuery(text: string): Promise<Float32Array | number[]>;
  /** 在已打开的连接上注册 sqlite-vec 模块（幂等，由适配器按实例缓存）。 */
  loadVec(db: unknown): void;
}

export interface IndexClient {
  open(root: string, diff?: ManifestDiff, options?: IndexOpenOptions): Promise<void>;
  /** 在扫描阶段报告工作区中实际发现的文件类型。 */
  onFileTypes?(listener: (fileTypes: string[]) => void | Promise<void>): void;
  getTags(path: string): Promise<Tag[]>;
  buildRepoMap(opts: MapOpts): Promise<string>;
  graphSearch?(query: string, depth: number): Promise<GraphResult>;
  invalidate(path: string): void;
  invalidateDir?(dir: string): void;
  rebuildAll(): Promise<void>;
  /** Flush dirty paths with an incremental write (no full rescan). */
  flushDirty?(): Promise<void>;
  status(): IndexStatus;
  setExtraIgnore?(patterns: string[]): void;
  ftsSearch?(query: string, options?: SearchOptions): Promise<SymbolSearchResult[]>;
  ragSearch?(query: string, topK: number): Promise<RagHit[]>;
  ragBuild?(root: string, filePaths: string[]): Promise<void>;
  ragUpdate?(root: string, added: string[], modified: string[], removed: string[]): Promise<void>;
  ragSave?(root: string): Promise<void>;
  ragLoad?(root: string): Promise<void>;
  manifestScan?(root: string, maxFiles: number): Promise<ManifestDiff>;
  manifestLoad?(root: string): Promise<void>;
  manifestSave?(): Promise<void>;
}

class StubIndexClient implements IndexClient {
  private root: string | undefined;
  private kind: IndexStatus["kind"] = "idle";

  async open(root: string, _diff?: ManifestDiff, _options?: IndexOpenOptions): Promise<void> {
    this.root = root;
    this.kind = "ready";
  }

  onFileTypes(_listener: (fileTypes: string[]) => void | Promise<void>): void {}

  async getTags(_path: string): Promise<Tag[]> {
    return [];
  }

  async buildRepoMap(_opts: MapOpts): Promise<string> {
    return this.root
      ? `# Repo map (stub)\n# TS-based code index not initialized.\n# root: ${this.root}\n`
      : "# Repo map (stub) — no workspace\n";
  }

  async graphSearch(query: string, _depth: number): Promise<GraphResult> {
    return { symbol: query, callers: [], callees: [] };
  }

  invalidate(_path: string): void {}

  async rebuildAll(): Promise<void> {
    this.kind = "ready";
  }

  status(): IndexStatus {
    return {
      kind: this.kind,
      root: this.root,
      message: "Using TS-based code index (stub).",
      fileCount: 0,
      tagCount: 0,
    };
  }

  async ftsSearch(): Promise<SymbolSearchResult[]> {
    return [];
  }

  async ragSearch(): Promise<RagHit[]> {
    return [];
  }

  async ragBuild(): Promise<void> {}

  async ragUpdate(): Promise<void> {}

  async ragSave(): Promise<void> {}

  async ragLoad(): Promise<void> {}

  async manifestScan(): Promise<ManifestDiff> {
    return { added: [], modified: [], removed: [] };
  }

  async manifestLoad(): Promise<void> {}

  async manifestSave(): Promise<void> {}
}

import { UnifiedIndexAdapter } from "./unified/index-client-adapter.ts";

export interface CreateIndexClientOptions {
  /** 语义检索端口（嵌入 + sqlite-vec 加载）；缺省时 ragSearch 维持空，整体降级 FTS。 */
  semantic?: SemanticSearchPort;
}

export function createIndexClient(options?: CreateIndexClientOptions): IndexClient {
  try {
    return new UnifiedIndexAdapter(options);
  } catch (error) {
    console.warn(`[index] Failed to create UnifiedIndexAdapter, falling back to stub:`, error);
    return new StubIndexClient();
  }
}


export {
  createCodemapClient,
  type CodemapClient,
  type CodemapImpact,
  type CodemapNode,
  type CodemapSearchHit,
  type CodemapStatus,
} from "./codemap.js";

// 统一索引系统导出
export { UnifiedIndex } from "./unified/index.ts";
export { UnifiedCodemapAdapter } from "./unified/adapter.ts";
export { UnifiedIndexAdapter } from "./unified/index-client-adapter.ts";
export { buildIndex, updateIndex, buildIndexAsync, updateIndexAsync } from "./unified/builder.ts";
export {
  extractSymbols,
  extractReferences,
  extractSymbolsAsync,
  extractReferencesAsync,
  initTreeSitter,
} from "./unified/parser.ts";
export {
  extractSymbolsTreeSitter,
  extractReferencesTreeSitter,
  isLanguageSupported,
  getSupportedLanguages,
} from "./unified/parser-treesitter.ts";
export type {
  UnifiedIndexOptions,
  SearchResult,
  ImpactResult,
  IndexStatus,
  IndexStats,
  ManifestDiff as UnifiedManifestDiff,
} from "./unified/types.ts";

