/**
 * 统一索引系统的类型定义
 */

export interface UnifiedIndexOptions {
  /** 工作区根目录 */
  root: string;
  /** 是否启用语义搜索增强(可选) */
  enableSemantic?: boolean;
  /** 符号搜索优先级策略 */
  symbolSearchPriority?: "exact" | "fuzzy" | "hybrid";
  /** 最大索引文件大小(字节) */
  maxFileSize?: number;
  /** 排除的目录模式 */
  excludeDirs?: string[];
}
export interface SymbolRecord {
  id: number;
  file_id: number;
  name: string;
  qualified_name: string | null;
  kind: string;
  start_line: number;
  end_line: number;
  start_col: number | null;
  end_col: number | null;
  exported: number;
  signature: string | null;
  doc: string | null;
}
export interface SearchResult {
  type: "file" | "symbol" | "reference";
  path: string;
  name?: string;
  qualifiedName?: string;
  kind?: string;
  line: number;
  column?: number;
  endLine?: number;
  score: number;
  preview?: string;
  context?: string;
  signature?: string;
  doc?: string;
}

export interface SearchOptions {
  /** 最大返回结果数 */
  limit?: number;
  /** 搜索类型过滤 */
  type?: "symbol" | "file" | "all";
  /** 符号类型过滤 */
  symbolKind?: string[];
  /** 是否只搜索导出的符号 */
  exportedOnly?: boolean;
  /** 文件路径前缀过滤 */
  pathPrefix?: string;
}

export interface ImpactResult {
  focal: SearchResult;
  callers: SearchResult[];
  callees: SearchResult[];
  likelyTests: SearchResult[];
  riskLevel: "low" | "medium" | "high";
  riskScore: number;
  explanation: string;
  directCallers: number;
  transitiveCallers: number;
}

export interface IndexStatus {
  ready: boolean;
  root?: string;
  databasePath?: string;
  fileCount: number;
  symbolCount: number;
  referenceCount: number;
  lastIndexedAt?: number;
  message: string;
}

export interface IndexStats {
  files: number;
  symbols: number;
  references: number;
  symbolsByKind: Record<string, number>;
  languageBreakdown: Record<string, number>;
  /** 性能指标 */
  performance?: PerformanceMetrics;
}

export interface PerformanceMetrics {
  /** 最后一次索引构建耗时(毫秒) */
  lastBuildDurationMs?: number;
  /** 最后一次索引构建处理的文件数 */
  lastBuildFilesProcessed?: number;
  /** 最后一次索引构建时间戳 */
  lastBuildTimestamp?: number;
  /** 平均查询响应时间(毫秒) */
  avgQueryTimeMs?: number;
  /** 查询次数统计 */
  totalQueries?: number;
  /** 最慢的10次查询 */
  slowestQueries?: QueryMetric[];
}

export interface QueryMetric {
  query: string;
  durationMs: number;
  resultCount: number;
  timestamp: number;
}

export interface ManifestDiff {
  added: string[];
  modified: string[];
  removed: string[];
}
