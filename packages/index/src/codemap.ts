/**
 * Codemap - 统一索引系统
 * 
 * 纯TypeScript实现,基于SQLite + FTS5
 * 不再依赖Rust native模块
 */

export interface CodemapStatus {
  root?: string;
  databasePath?: string;
  ready: boolean;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  lastBuildMs?: number;
  message: string;
}

export interface CodemapNode {
  id: string;
  name: string;
  qualifiedName?: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  language: string;
  exported?: boolean;
  depth?: number;
}

export interface CodemapSearchHit {
  node: CodemapNode;
  score: number;
  summary?: string;
}

export interface CodemapImpact {
  focal: CodemapNode;
  callers: CodemapNode[];
  callees: CodemapNode[];
  likelyTests: CodemapNode[];
  directCallers: number;
  transitiveCallers: number;
  riskLevel: "low" | "medium" | "high";
  riskScore: number;
  explanation: string;
}

export interface CodemapClient {
  build(root: string): Promise<CodemapStatus>;
  status(): Promise<CodemapStatus>;
  search(query: string, limit?: number): Promise<CodemapSearchHit[]>;
  impact(query: string, depth?: number): Promise<CodemapImpact>;
}

/**
 * 创建Codemap客户端
 * 使用新的统一索引系统 (纯TypeScript + SQLite)
 */
export async function createCodemapClient(): Promise<CodemapClient> {
  const { UnifiedCodemapAdapter } = await import("./unified/adapter.js");
  console.log("[codemap] Using UnifiedIndex (TypeScript + SQLite implementation)");
  return new UnifiedCodemapAdapter();
}
