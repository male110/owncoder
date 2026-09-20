/**
 * 适配器公共API测试
 * 
 * 验证UnifiedIndex公共API的正确性和适配器使用
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { UnifiedIndex } from "../index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("UnifiedIndex Public API", () => {
  let tempDir: string;
  let index: UnifiedIndex;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "unified-index-adapter-"));
    index = new UnifiedIndex();
  });

  afterEach(() => {
    index.close();
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch (error) {
        // Windows可能锁定文件,忽略删除错误
      }
    }
  });

  describe("getDatabase()", () => {
    it("should return null when not initialized", () => {
      const db = index.getDatabase();
      expect(db).toBeNull();
    });

    it("should return database instance after open()", () => {
      index.open(tempDir);
      const db = index.getDatabase();
      
      expect(db).not.toBeNull();
      expect(db).toBeDefined();
      expect(typeof db?.prepare).toBe("function");
    });

    it("should return null after close()", () => {
      index.open(tempDir);
      expect(index.getDatabase()).not.toBeNull();
      
      index.close();
      expect(index.getDatabase()).toBeNull();
    });

    it("should allow database operations via returned instance", () => {
      index.open(tempDir);
      const db = index.getDatabase();
      
      expect(db).not.toBeNull();
      if (!db) return;
      
      // 验证可以执行查询
      const count = db.prepare("SELECT COUNT(*) FROM files").pluck().get() as number;
      expect(typeof count).toBe("number");
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it("should be reusable after reopen", () => {
      index.open(tempDir);
      const db1 = index.getDatabase();
      expect(db1).not.toBeNull();
      
      index.close();
      expect(index.getDatabase()).toBeNull();
      
      index.open(tempDir);
      const db2 = index.getDatabase();
      expect(db2).not.toBeNull();
      expect(db2).not.toBe(db1); // 新的数据库实例
    });
  });

  describe("updateBuildMetrics()", () => {
    beforeEach(() => {
      index.open(tempDir);
    });

    it("should update build metrics", () => {
      const metrics = {
        durationMs: 1234,
        filesProcessed: 56,
      };
      
      index.updateBuildMetrics(metrics);
      
      const stats = index.getStats();
      expect(stats.performance?.lastBuildDurationMs).toBe(1234);
      expect(stats.performance?.lastBuildFilesProcessed).toBe(56);
      expect(stats.performance?.lastBuildTimestamp).toBeDefined();
      expect(stats.performance?.lastBuildTimestamp).toBeGreaterThan(Date.now() - 1000);
    });

    it("should update lastIndexedAt timestamp", () => {
      const beforeTime = Date.now();
      
      index.updateBuildMetrics({
        durationMs: 100,
        filesProcessed: 10,
      });
      
      const status = index.status();
      expect(status.lastIndexedAt).toBeDefined();
      expect(status.lastIndexedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(status.lastIndexedAt).toBeLessThanOrEqual(Date.now());
    });

    it("should allow multiple updates", () => {
      index.updateBuildMetrics({ durationMs: 100, filesProcessed: 10 });
      index.updateBuildMetrics({ durationMs: 200, filesProcessed: 20 });
      index.updateBuildMetrics({ durationMs: 300, filesProcessed: 30 });
      
      const stats = index.getStats();
      expect(stats.performance?.lastBuildDurationMs).toBe(300);
      expect(stats.performance?.lastBuildFilesProcessed).toBe(30);
    });

    it("should accept zero values", () => {
      index.updateBuildMetrics({ durationMs: 0, filesProcessed: 0 });
      
      const stats = index.getStats();
      expect(stats.performance?.lastBuildDurationMs).toBe(0);
      expect(stats.performance?.lastBuildFilesProcessed).toBe(0);
    });

    it("should accept large values", () => {
      index.updateBuildMetrics({
        durationMs: 999999,
        filesProcessed: 10000,
      });
      
      const stats = index.getStats();
      expect(stats.performance?.lastBuildDurationMs).toBe(999999);
      expect(stats.performance?.lastBuildFilesProcessed).toBe(10000);
    });
  });

  describe("API integration", () => {
    it("should work together for typical adapter usage", () => {
      // 1. 打开索引
      index.open(tempDir);
      
      // 2. 获取数据库实例
      const db = index.getDatabase();
      expect(db).not.toBeNull();
      
      // 3. 模拟构建完成
      index.updateBuildMetrics({
        durationMs: 5678,
        filesProcessed: 123,
      });
      
      // 4. 使缓存失效
      index.invalidateStatsCache();
      
      // 5. 验证状态
      const stats = index.getStats();
      expect(stats.performance?.lastBuildDurationMs).toBe(5678);
      expect(stats.performance?.lastBuildFilesProcessed).toBe(123);
      
      const status = index.status();
      expect(status.lastIndexedAt).toBeDefined();
    });

    it("should maintain type safety", () => {
      index.open(tempDir);
      
      // getDatabase返回类型应该是 Database | null
      const db = index.getDatabase();
      if (db) {
        // TypeScript应该知道这里db不是null
        const stmt = db.prepare("SELECT 1");
        expect(stmt).toBeDefined();
      }
      
      // updateBuildMetrics需要正确的参数类型
      index.updateBuildMetrics({
        durationMs: 100,
        filesProcessed: 10,
      });
      
      // 缺少必需字段应该报错
      // index.updateBuildMetrics({ durationMs: 100 });
      
      // 错误的字段类型应该报错
      // index.updateBuildMetrics({ durationMs: "100", filesProcessed: 10 });
    });
  });

  describe("Edge cases", () => {
    it("should handle updateBuildMetrics before open", () => {
      // 不应该崩溃,但指标可能不会持久化
      expect(() => {
        index.updateBuildMetrics({
          durationMs: 100,
          filesProcessed: 10,
        });
      }).not.toThrow();
    });

    it("should handle getDatabase multiple times", () => {
      index.open(tempDir);
      
      const db1 = index.getDatabase();
      const db2 = index.getDatabase();
      const db3 = index.getDatabase();
      
      // 应该返回相同的实例
      expect(db1).toBe(db2);
      expect(db2).toBe(db3);
    });

    it("should handle metrics update after close", () => {
      index.open(tempDir);
      index.close();
      
      // 不应该崩溃
      expect(() => {
        index.updateBuildMetrics({
          durationMs: 100,
          filesProcessed: 10,
        });
      }).not.toThrow();
    });
  });
});
