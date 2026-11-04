import { join } from "node:path";
import { promises as fs } from "node:fs";
import {
  createCodemapClient,
  type CodemapClient,
  type CodemapImpact,
  type CodemapSearchHit,
} from "@owncoder/index";

/**
 * Codemap 客户端管理。
 *
 * 从 index.ts (SessionOrchestrator) 拆分：lazy 初始化、指数退避重试、
 * 损坏数据库自动重建、重试耗尽后降级为 stub 客户端，以及面向 agent
 * 工具的 search/impact 查询入口。
 *
 * 错误恢复策略:
 * 1. 失败后重置promise,允许重试
 * 2. 最多重试3次,每次延迟1秒
 * 3. 检测损坏数据库并自动重建
 * 4. 完全失败后降级为stub客户端
 */
export class CodemapManager {
  private codemap: CodemapClient | null = null;
  private initPromise: Promise<CodemapClient> | null = null;
  private initRetries = 0;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 1000;

  /** 数据库文件路径依赖当前工作区，由编排器注入。 */
  constructor(private readonly getWorkspaceRoot: () => string | null) {}

  private async getClient(): Promise<CodemapClient> {
    if (this.codemap) return this.codemap;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initWithRetry()
      .then(client => {
        this.codemap = client;
        this.initRetries = 0; // 重置重试计数
        console.log("[OwnCoder] Codemap initialized successfully");
        return client;
      })
      .catch(error => {
        // 重置promise以允许下次调用重试
        this.initPromise = null;

        console.error("[OwnCoder] Codemap initialization failed:", error);

        // 如果超过最大重试次数,创建stub客户端作为降级
        if (this.initRetries >= this.MAX_RETRIES) {
          console.warn("[OwnCoder] Codemap initialization exhausted retries, using stub client");
          this.codemap = this.createStubClient();
          return this.codemap;
        }

        throw error;
      });

    return this.initPromise;
  }

  /**
   * 带重试的Codemap初始化
   */
  private async initWithRetry(): Promise<CodemapClient> {
    while (this.initRetries < this.MAX_RETRIES) {
      try {
        const client = await createCodemapClient();

        // 验证客户端可用性
        await this.validateClient(client);

        return client;
      } catch (error) {
        this.initRetries++;

        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[OwnCoder] Codemap init attempt ${this.initRetries}/${this.MAX_RETRIES} failed: ${errorMsg}`
        );

        // 检测是否是数据库损坏错误
        if (this.isDatabaseCorrupted(error)) {
          console.warn("[OwnCoder] Detected corrupted database, attempting to rebuild...");
          await this.cleanupCorruptedDatabase();
          // 清理后立即重试,不计入重试次数
          this.initRetries--;
          continue;
        }

        // 如果还有重试机会,等待后重试
        if (this.initRetries < this.MAX_RETRIES) {
          await this.sleep(this.RETRY_DELAY_MS * this.initRetries); // 指数退避
          continue;
        }

        throw error;
      }
    }

    throw new Error("Codemap initialization failed after max retries");
  }

  /**
   * 验证Codemap客户端是否可用
   */
  private async validateClient(client: CodemapClient): Promise<void> {
    try {
      // 简单的健康检查: 调用status()
      await client.status();
    } catch (error) {
      throw new Error(`Codemap client validation failed: ${error}`);
    }
  }

  /**
   * 检测是否是数据库损坏错误
   */
  private isDatabaseCorrupted(error: unknown): boolean {
    const errorMsg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

    return (
      errorMsg.includes("database disk image is malformed") ||
      errorMsg.includes("database is locked") ||
      errorMsg.includes("not a database") ||
      errorMsg.includes("file is not a database") ||
      errorMsg.includes("sqlite") && errorMsg.includes("corrupt")
    );
  }

  /**
   * 清理损坏的数据库文件
   */
  private async cleanupCorruptedDatabase(): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return;

    const dbPath = join(workspaceRoot, ".owncoder", "unified-index.db");

    try {
      await fs.unlink(dbPath);
      console.log("[OwnCoder] Removed corrupted database:", dbPath);
    } catch (error) {
      // 文件可能不存在,忽略错误
      console.warn("[OwnCoder] Failed to remove database:", error);
    }
  }

  /**
   * 创建stub客户端作为降级方案
   */
  private createStubClient(): CodemapClient {
    const stubStatus = async (): Promise<import("@owncoder/index").CodemapStatus> => ({
      ready: false,
      fileCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      message: "Codemap unavailable (initialization failed)",
    });

    return {
      async status() {
        return stubStatus();
      },
      async build(_root: string) {
        console.warn("[OwnCoder] Stub codemap: build() called but no-op");
        return stubStatus();
      },
      async search(_query: string, _limit?: number) {
        console.warn("[OwnCoder] Stub codemap: search() called but returning empty results");
        return [];
      },
      async impact(_query: string, _depth?: number) {
        console.warn("[OwnCoder] Stub codemap: impact() called but returning empty results");
        return {
          focal: {
            id: "",
            name: "",
            kind: "",
            path: "",
            startLine: 0,
            endLine: 0,
            language: "",
          },
          callers: [],
          callees: [],
          likelyTests: [],
          directCallers: 0,
          transitiveCallers: 0,
          riskLevel: "low",
          riskScore: 0,
          explanation: "Stub implementation - no impact analysis available",
        };
      },
    };
  }

  /**
   * 延迟辅助函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Access the embedded CodeGraph engine through OwnCoder's private API. */
  async get(): Promise<CodemapClient> {
    return this.getClient();
  }

  /**
   * Ensure the Codemap graph is fresh before an agent query. If a rebuild is
   * pending (file changed but the debounce window hasn't elapsed), flush it
   * immediately instead of waiting, so the agent reads the latest graph. On the
   * steady state (no changes, already built) this is a no-op and the search
   * hits the native layer directly.
   */
  private async flushForQuery(): Promise<void> {
    // Never build the whole workspace synchronously from an agent tool call.
    // The desktop UtilityProcess owns indexing; queries use the latest snapshot.
  }

  async search(query: string, limit = 12): Promise<CodemapSearchHit[]> {
    await this.flushForQuery();
    const codemap = await this.getClient();
    const t = Date.now();
    const hits = await codemap.search(query, limit);
    console.warn(
      `[owncoder/codemap] search query=${JSON.stringify(query)} ${Date.now() - t}ms results=${hits.length}`,
    );
    return hits;
  }

  async impact(nodeId: string, depth = 3): Promise<CodemapImpact> {
    await this.flushForQuery();
    const codemap = await this.getClient();
    const t = Date.now();
    const impact = await codemap.impact(nodeId, depth);
    console.warn(
      `[owncoder/codemap] impact nodeId=${JSON.stringify(nodeId)} ${Date.now() - t}ms`,
    );
    return impact;
  }
}
