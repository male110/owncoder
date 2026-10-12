/**
 * 兼容性适配器 - 将UnifiedIndex适配到现有的CodemapClient接口
 */

import { UnifiedIndex } from "./index.ts";
import { buildIndexAsync } from "./builder.ts";
import type {
  CodemapClient,
  CodemapStatus,
  CodemapSearchHit,
  CodemapImpact,
  CodemapNode,
} from "../codemap.ts";
import type { SearchResult } from "./types.ts";

/**
 * 将UnifiedIndex包装为CodemapClient接口
 */
export class UnifiedCodemapAdapter implements CodemapClient {
  private index: UnifiedIndex;
  private buildPromise: Promise<CodemapStatus> | null = null;

  constructor() {
    this.index = new UnifiedIndex();
  }

  async build(root: string): Promise<CodemapStatus> {
    // 防止并发构建
    if (this.buildPromise) {
      return this.buildPromise;
    }

    this.buildPromise = this.doBuild(root);
    try {
      return await this.buildPromise;
    } finally {
      this.buildPromise = null;
    }
  }

  private async doBuild(root: string): Promise<CodemapStatus> {
    try {
      // 打开数据库
      this.index.open(root);

      // 获取数据库实例(通过公共API)
      const db = this.index.getDatabase();
      if (!db) {
        throw new Error("Failed to initialize database");
      }

      // 构建索引
      const buildResult = await buildIndexAsync(db, {
        root,
        incremental: false,
        onProgress: (current, total, file) => {
          if (current % 10 === 0 || current === total) {
            console.log(`[UnifiedIndex] Progress: ${current}/${total} - ${file}`);
          }
        },
      });

      // 记录性能指标到index实例(通过公共API)
      this.index.updateBuildMetrics({
        durationMs: buildResult.durationMs,
        filesProcessed: buildResult.filesIndexed,
      });
      
      // 使统计缓存失效
      this.index.invalidateStatsCache();

      // 获取状态
      const status = this.index.status();

      return {
        root,
        databasePath: status.databasePath,
        ready: status.ready,
        fileCount: status.fileCount,
        nodeCount: status.symbolCount,
        edgeCount: status.referenceCount,
        lastBuildMs: buildResult.durationMs,
        message:
          buildResult.errors.length > 0
            ? `Build completed with ${buildResult.errors.length} errors`
            : "Build completed successfully",
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[UnifiedCodemapAdapter] Build failed:`, errorMsg);
      return {
        ready: false,
        fileCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        message: `Build failed: ${errorMsg}`,
      };
    }
  }

  async status(): Promise<CodemapStatus> {
    const status = this.index.status();
    return {
      root: status.root,
      databasePath: status.databasePath,
      ready: status.ready,
      fileCount: status.fileCount,
      nodeCount: status.symbolCount,
      edgeCount: status.referenceCount,
      lastBuildMs: status.lastIndexedAt,
      message: status.message,
    };
  }

  async search(query: string, limit = 20): Promise<CodemapSearchHit[]> {
    try {
      const results = await this.index.search(query, { limit });
      return results.map((r) => this.toSearchHit(r));
    } catch (error) {
      console.error("[UnifiedCodemapAdapter] Search failed:", error);
      return [];
    }
  }

  async impact(nodeIdOrName: string, depth = 3): Promise<CodemapImpact> {
    try {
      // 解析nodeId格式: path:name:line（codemap_search返回的格式）
      const parsed = this.parseNodeId(nodeIdOrName);
      
      let result;
      if (parsed) {
        // 通过路径+符号名+行号精确查找符号ID
        const db = this.index.getDatabase();
        if (!db) throw new Error("Database not initialized");
        
        // 先尝试精确匹配（路径+符号名+行号）
        const row = db.prepare(`
          SELECT s.id
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          WHERE f.path = ? AND s.name = ? AND s.start_line = ?
          LIMIT 1
        `).get(parsed.path, parsed.name, parsed.line) as { id: number } | undefined;
        
        if (row) {
          result = await this.index.impact(row.id, depth);
        } else {
          // 行号不精确时，用路径+符号名（可能匹配多个，取第一个）
          const fuzzyRow = db.prepare(`
            SELECT s.id
            FROM symbols s
            JOIN files f ON s.file_id = f.id
            WHERE f.path = ? AND s.name = ?
            LIMIT 1
          `).get(parsed.path, parsed.name) as { id: number } | undefined;
          
          if (fuzzyRow) {
            result = await this.index.impact(fuzzyRow.id, depth);
          } else {
            throw new Error(`Symbol not found: ${nodeIdOrName}`);
          }
        }
      } else {
        // 不是nodeId格式，直接作为符号名查询
        result = await this.index.impact(nodeIdOrName, depth);
      }
      
      return {
        focal: this.toNode(result.focal),
        callers: result.callers.map((r) => this.toNode(r)),
        callees: result.callees.map((r) => this.toNode(r)),
        likelyTests: result.likelyTests.map((r) => this.toNode(r)),
        directCallers: result.directCallers,
        transitiveCallers: result.transitiveCallers,
        riskLevel: result.riskLevel,
        riskScore: result.riskScore,
        explanation: result.explanation,
      };
    } catch (error) {
      // 兜底：用符号名搜索
      const searchResults = await this.index.search(nodeIdOrName, { limit: 1 });
      if (searchResults.length === 0) {
        throw new Error(`Symbol not found: ${nodeIdOrName}`);
      }
      
      const result = await this.index.impact(searchResults[0].name!, depth);
      return {
        focal: this.toNode(result.focal),
        callers: result.callers.map((r) => this.toNode(r)),
        callees: result.callees.map((r) => this.toNode(r)),
        likelyTests: result.likelyTests.map((r) => this.toNode(r)),
        directCallers: result.directCallers,
        transitiveCallers: result.transitiveCallers,
        riskLevel: result.riskLevel,
        riskScore: result.riskScore,
        explanation: result.explanation,
      };
    }
  }

  /**
   * 解析nodeId格式: path:name:line
   * 例如: "packages/index/src/unified/parser.ts:functionRegex:196"
   */
  private parseNodeId(nodeId: string): { path: string; name: string; line: number } | null {
    // nodeId格式: path:name:line
    // path可能包含冒号（Windows盘符），所以从右边解析line和name
    const lastColon = nodeId.lastIndexOf(":");
    if (lastColon <= 0) return null;
    
    const lineStr = nodeId.slice(lastColon + 1);
    const line = parseInt(lineStr, 10);
    if (isNaN(line)) return null;
    
    const rest = nodeId.slice(0, lastColon);
    const secondLastColon = rest.lastIndexOf(":");
    if (secondLastColon <= 0) return null;
    
    const path = rest.slice(0, secondLastColon);
    const name = rest.slice(secondLastColon + 1);
    
    if (!path || !name) return null;
    
    return { path, name, line };
  }

  // ========== 类型转换 ==========

  private toSearchHit(result: SearchResult): CodemapSearchHit {
    return {
      node: this.toNode(result),
      score: result.score,
      summary: result.doc ?? result.signature,
    };
  }

  private toNode(result: SearchResult): CodemapNode {
    return {
      id: `${result.path}:${result.name}:${result.line}`,
      name: result.name ?? "unknown",
      qualifiedName: result.qualifiedName,
      kind: result.kind ?? "unknown",
      path: result.path,
      startLine: result.line,
      endLine: result.endLine ?? result.line,
      language: this.detectLanguageFromPath(result.path),
      exported: undefined,
      depth: undefined,
    };
  }

  private detectLanguageFromPath(path: string): string {
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    const langMap: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescript",
      ".js": "javascript",
      ".jsx": "javascript",
      ".py": "python",
      ".rs": "rust",
      ".go": "go",
      ".java": "java",
    };
    return langMap[ext] ?? "unknown";
  }
}
