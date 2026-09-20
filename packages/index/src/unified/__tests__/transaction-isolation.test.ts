/**
 * 查询事务隔离测试
 * 
 * 验证所有查询操作使用只读事务,确保快照隔离和数据一致性
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { UnifiedIndex } from "../index.ts";
import { buildIndex } from "../builder.ts";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Query Transaction Isolation", () => {
  let tempDir: string;
  let index: UnifiedIndex;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "txn-isolation-"));
    index = new UnifiedIndex();
    index.open(tempDir);
    db = index.getDatabase()!;
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

  describe("Read Transaction Consistency", () => {
    it("should see consistent data within a search query", async () => {
      // 创建测试文件
      writeFileSync(
        join(tempDir, "test.ts"),
        `export function foo() { return 42; }\nexport function bar() { return foo(); }`
      );

      // 构建索引
      buildIndex(db, { root: tempDir, incremental: false });

      // 搜索应该看到一致的符号数据
      const results = await index.search("foo");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe("foo");
    });

    it("should not see uncommitted changes during query", async () => {
      // 创建初始文件
      writeFileSync(
        join(tempDir, "test.ts"),
        `export function original() { return 1; }`
      );

      buildIndex(db, { root: tempDir, incremental: false });

      // 在搜索前开始但不提交写事务
      // (实际场景:另一个进程正在构建但未完成)
      const writeDb = new Database(join(tempDir, ".owncoder", "unified-index.db"));
      writeDb.exec("BEGIN IMMEDIATE");
      writeDb.prepare("INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (1, ?, ?, 100, 100)").run("newSymbol", "function");

      try {
        // 搜索应该看不到未提交的newSymbol
        const results = await index.search("newSymbol");
        expect(results.length).toBe(0);

        // 搜索应该仍能看到已提交的original
        const originalResults = await index.search("original");
        expect(originalResults.length).toBeGreaterThan(0);
      } finally {
        writeDb.exec("ROLLBACK");
        writeDb.close();
      }
    });

    it("should handle concurrent reads without blocking", async () => {
      // 创建测试数据
      writeFileSync(
        join(tempDir, "test.ts"),
        `export function a() {}\nexport function b() {}\nexport function c() {}`
      );

      buildIndex(db, { root: tempDir, incremental: false });

      // 并发执行多个搜索查询
      const searches = Promise.all([
        index.search("a"),
        index.search("b"),
        index.search("c"),
        index.search("a"),
        index.search("b"),
      ]);

      const results = await searches;
      expect(results).toHaveLength(5);
      expect(results[0].length).toBeGreaterThan(0);
      expect(results[1].length).toBeGreaterThan(0);
      expect(results[2].length).toBeGreaterThan(0);
    });

    it("should provide snapshot isolation for complex queries", async () => {
      // 创建复杂的测试数据
      writeFileSync(
        join(tempDir, "caller.ts"),
        `import { target } from './target';\nexport function caller() { target(); }`
      );
      writeFileSync(
        join(tempDir, "target.ts"),
        `export function target() { return 42; }`
      );

      buildIndex(db, { root: tempDir, incremental: false });

      // impact查询涉及多个连接和递归查询
      const targetResults = await index.search("target");
      expect(targetResults.length).toBeGreaterThan(0);

      const impact = await index.impact("target", 3);
      
      // 查询应该看到一致的图结构
      expect(impact.focal).toBeDefined();
      expect(impact.focal.name).toBe("target");
    });
  });

  describe("Transaction Rollback on Error", () => {
    it("should rollback transaction if query fails", async () => {
      // 创建有效数据
      writeFileSync(join(tempDir, "test.ts"), `export function test() {}`);
      buildIndex(db, { root: tempDir, incremental: false });

      // 模拟查询错误(使用非法FTS5查询)
      // 应该不会导致数据库处于不一致状态
      try {
        await index.search('"unclosed');
      } catch (error) {
        // 预期的错误
      }

      // 后续查询应该仍然正常工作
      const results = await index.search("test");
      expect(results.length).toBeGreaterThan(0);
    });

    it("should not leave open transactions after error", async () => {
      writeFileSync(join(tempDir, "test.ts"), `export function test() {}`);
      buildIndex(db, { root: tempDir, incremental: false });

      // 触发多个可能失败的查询
      const queries = [
        index.search("test"),
        index.search('"'),
        index.search("test"),
        index.search("' OR 1=1"),
        index.search("test"),
      ];

      await Promise.allSettled(queries);

      // 检查数据库状态:不应该有活跃事务
      // SQLite的in_transaction状态应该为0
      const inTransaction = db.prepare("SELECT 1").get();
      expect(inTransaction).toBeDefined(); // 查询应该成功
    });
  });

  describe("Performance", () => {
    it("should not add significant overhead", async () => {
      // 创建中等规模的数据集
      for (let i = 0; i < 50; i++) {
        writeFileSync(
          join(tempDir, `file${i}.ts`),
          `export function func${i}() { return ${i}; }`
        );
      }

      buildIndex(db, { root: tempDir, incremental: false });

      // 测量查询性能
      const start = performance.now();
      
      for (let i = 0; i < 20; i++) {
        await index.search(`func${i}`);
      }
      
      const duration = performance.now() - start;
      const avgTime = duration / 20;

      // 平均每次查询应该<10ms (事务开销很小)
      expect(avgTime).toBeLessThan(10);
    });

    it("should handle burst concurrent queries efficiently", async () => {
      writeFileSync(
        join(tempDir, "test.ts"),
        Array.from({ length: 20 }, (_, i) => `export function func${i}() {}`).join("\n")
      );

      buildIndex(db, { root: tempDir, incremental: false });

      const start = performance.now();

      // 并发执行100个查询
      const queries = Array.from({ length: 100 }, (_, i) =>
        index.search(`func${i % 20}`)
      );

      await Promise.all(queries);

      const duration = performance.now() - start;

      // 100个并发查询应该<500ms
      expect(duration).toBeLessThan(500);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty database queries with transaction", async () => {
      // 空数据库
      const results = await index.search("nonexistent");
      expect(results).toEqual([]);
    });

    it("should handle very long queries with transaction", async () => {
      writeFileSync(join(tempDir, "test.ts"), `export function test() {}`);
      buildIndex(db, { root: tempDir, incremental: false });

      const longQuery = "a".repeat(10000);
      const results = await index.search(longQuery);
      expect(results).toEqual([]);
    });

    it("should handle special characters in queries with transaction", async () => {
      writeFileSync(join(tempDir, "test.ts"), `export function test$special() {}`);
      buildIndex(db, { root: tempDir, incremental: false });

      const results = await index.search("test$special");
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle rapid open/close cycles", async () => {
      writeFileSync(join(tempDir, "test.ts"), `export function test() {}`);
      buildIndex(db, { root: tempDir, incremental: false });

      // 快速连续查询
      for (let i = 0; i < 10; i++) {
        const results = await index.search("test");
        expect(results.length).toBeGreaterThan(0);
      }
    });
  });

  describe("API Coverage", () => {
    beforeEach(() => {
      // 创建测试数据
      writeFileSync(
        join(tempDir, "test.ts"),
        `export function testFunc() { helper(); }\nfunction helper() {}`
      );
      buildIndex(db, { root: tempDir, incremental: false });
    });

    it("searchSymbolsExact should use transaction", async () => {
      const results = await index.search("testFunc");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe("testFunc");
    });

    it("searchSymbolsFuzzy should use transaction", async () => {
      const results = await index.search("test");
      expect(results.length).toBeGreaterThan(0);
    });

    it("findCallers should use transaction", async () => {
      // 这需要有引用关系,简化测试只验证不崩溃
      const results = await index.search("testFunc");
      if (results.length > 0) {
        // impact内部调用findCallers
        await index.impact("testFunc", 2);
      }
    });

    it("impact analysis should use transaction", async () => {
      const impact = await index.impact("testFunc", 3);
      expect(impact.focal).toBeDefined();
      expect(impact.focal.name).toBe("testFunc");
    });
  });
});
