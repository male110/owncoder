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

export interface IndexClient {
  open(root: string, diff?: ManifestDiff, options?: IndexOpenOptions): Promise<void>;
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

export function createIndexClient(): IndexClient {
  try {
    return new UnifiedIndexAdapter();
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

