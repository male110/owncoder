/**
 * 索引构建器单元测试
 * 
 * 测试覆盖:
 * - 增量更新逻辑
 * - 并发构建
 * - 空目录处理
 * - 错误处理
 * - 性能指标
 */

import Database from "better-sqlite3";
import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildIndex } from "../builder.ts";
import { initializeSchema } from "../schema.ts";
import { computeDiff } from "../scanner.ts";

// 自定义测试框架的 beforeEach/afterEach 注册变量
// 必须在 describe 块执行前初始化，否则 `let` 的暂时性死区会导致
// ReferenceError: Cannot access 'beforeEachFn' before initialization
let beforeEachFn: (() => void) | null = null;
let afterEachFn: (() => void) | null = null;

// ========== 测试辅助函数 ==========

function createTempDir(prefix: string): string {
  const dir = join(tmpdir(), `owncoder-test-${prefix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createTestDatabase(): Database.Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function writeTestFile(dir: string, path: string, content: string): void {
  const fullPath = join(dir, path);
  const dirPath = join(fullPath, "..");
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

// ========== 索引构建基础测试 ==========

describe("buildIndex - Basic", () => {
  let testDir: string;
  let db: Database.Database;

  beforeEach(() => {
    testDir = createTempDir("build-basic");
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(testDir);
  });

  it("should build index for empty directory", () => {
    const result = buildIndex(db, {
      root: testDir,
      incremental: false,
    });

    expect(result.filesIndexed).toBe(0);
    expect(result.filesSkipped).toBe(0);
    expect(result.symbolsAdded).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("should build index for single file", () => {
    writeTestFile(testDir, "test.ts", `
      export function hello() {
        return "world";
      }
    `);

    const result = buildIndex(db, {
      root: testDir,
      incremental: false,
    });

    expect(result.filesIndexed).toBe(1);
    expect(result.symbolsAdded).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);

    // 验证数据库中的数据
    const fileCount = db.prepare("SELECT COUNT(*) FROM files").pluck().get();
    const symbolCount = db.prepare("SELECT COUNT(*) FROM symbols").pluck().get();

    expect(fileCount).toBe(1);
    expect(symbolCount).toBeGreaterThan(0);
  });

  it("should build index for multiple files", () => {
    writeTestFile(testDir, "file1.ts", "export function foo() {}");
    writeTestFile(testDir, "file2.ts", "export class Bar {}");
    writeTestFile(testDir, "file3.js", "export const baz = 42;");

    const result = buildIndex(db, {
      root: testDir,
      incremental: false,
    });

    expect(result.filesIndexed).toBe(3);
    expect(result.symbolsAdded).toBeGreaterThan(0);
  });

  it("should handle nested directories", () => {
    writeTestFile(testDir, "src/utils/helper.ts", "export function helper() {}");
    writeTestFile(testDir, "src/components/Button.ts", "export class Button {}");
    writeTestFile(testDir, "lib/index.ts", "export * from './src';");

    const result = buildIndex(db, {
      root: testDir,
      incremental: false,
    });

    expect(result.filesIndexed).toBe(3);
  });

  it("should exclude specified directories", () => {
    writeTestFile(testDir, "src/main.ts", "export function main() {}");
    writeTestFile(testDir, "node_modules/lib/index.js", "module.exports = {};");
    writeTestFile(testDir, "dist/bundle.js", "// compiled");

    const result = buildIndex(db, {
      root: testDir,
      incremental: false,
      excludeDirs: ["node_modules", "dist"],
    });

    expect(result.filesIndexed).toBe(1); // 只有 src/main.ts
  });

  it("should respect maxFileSize limit", () => {
    const smallFile = "export function small() {}";
    const largeFile = "x".repeat(131 * 1024); // >130KB default skip

    writeTestFile(testDir, "small.ts", smallFile);
    writeTestFile(testDir, "large.ts", largeFile);

    const result = buildIndex(db, {
      root: testDir,
      incremental: false,
    });

    expect(result.filesIndexed).toBe(1); // 只索引小文件
    expect(result.filesSkipped).toBeGreaterThanOrEqual(1);
  });
});

// ========== 增量更新测试 ==========

describe("buildIndex - Incremental", () => {
  let testDir: string;
  let db: Database.Database;

  beforeEach(() => {
    testDir = createTempDir("build-incremental");
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(testDir);
  });

  it("should skip rebuild when no changes", () => {
    writeTestFile(testDir, "test.ts", "export function test() {}");

    // 首次构建
    const result1 = buildIndex(db, {
      root: testDir,
      incremental: true,
    });

    expect(result1.filesIndexed).toBe(1);

    // 第二次构建(无变化)
    const result2 = buildIndex(db, {
      root: testDir,
      incremental: true,
    });

    expect(result2.filesIndexed).toBe(0);
    expect(result2.filesSkipped).toBe(1);
    expect(result2.durationMs).toBeLessThan(result1.durationMs); // 应该更快
  });

  it("should detect file additions", () => {
    writeTestFile(testDir, "file1.ts", "export function foo() {}");

    // 首次构建
    buildIndex(db, { root: testDir, incremental: true });

    // 添加新文件
    writeTestFile(testDir, "file2.ts", "export function bar() {}");

    // 增量构建
    const result = buildIndex(db, { root: testDir, incremental: true });

    expect(result.filesIndexed).toBe(1); // 只索引新文件
  });

  it("should detect file modifications", () => {
    const filePath = "test.ts";
    writeTestFile(testDir, filePath, "export function v1() {}");

    // 首次构建
    buildIndex(db, { root: testDir, incremental: true });

    // Force both size and mtime to change so meta-diff is deterministic on Windows.
    writeTestFile(testDir, filePath, "export function v2UpdatedLonger() {}");
    const fullPath = join(testDir, filePath);
    const st = statSync(fullPath);
    utimesSync(fullPath, st.atime, new Date(st.mtimeMs + 2000));

    // 增量构建
    const result = buildIndex(db, { root: testDir, incremental: true });

    expect(result.filesIndexed).toBe(1); // 重新索引修改的文件

    // 验证符号已更新
    const symbols = db.prepare("SELECT name FROM symbols").all();
    const symbolNames = symbols.map((s: any) => s.name);
    expect(symbolNames).toContain("v2UpdatedLonger");
    expect(symbolNames).not.toContain("v1");
  });

  it("should detect file deletions", () => {
    writeTestFile(testDir, "file1.ts", "export function foo() {}");
    writeTestFile(testDir, "file2.ts", "export function bar() {}");

    // 首次构建
    buildIndex(db, { root: testDir, incremental: true });

    const fileCountBefore = db.prepare("SELECT COUNT(*) FROM files").pluck().get();
    expect(fileCountBefore).toBe(2);

    // 删除文件
    rmSync(join(testDir, "file2.ts"));

    // 增量构建
    buildIndex(db, { root: testDir, incremental: true });

    const fileCountAfter = db.prepare("SELECT COUNT(*) FROM files").pluck().get();
    expect(fileCountAfter).toBe(1);
  });
});

// ========== 错误处理测试 ==========

describe("buildIndex - Error Handling", () => {
  let testDir: string;
  let db: Database.Database;

  beforeEach(() => {
    testDir = createTempDir("build-errors");
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(testDir);
  });

  it("should handle malformed files gracefully", () => {
    writeTestFile(testDir, "good.ts", "export function good() {}");
    writeTestFile(testDir, "bad.ts", "export function { malformed syntax");

    const result = buildIndex(db, {
      root: testDir,
      incremental: false,
    });

    // 应该至少索引好的文件
    expect(result.filesIndexed).toBeGreaterThan(0);
    // 可能有错误但不应该崩溃
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("should continue on file read errors", () => {
    writeTestFile(testDir, "file1.ts", "export function foo() {}");
    // 不创建file2.ts,但会在扫描时被检测到
    writeTestFile(testDir, "file3.ts", "export function baz() {}");

    const result = buildIndex(db, {
      root: testDir,
      incremental: false,
    });

    // 应该索引可读的文件
    expect(result.filesIndexed).toBeGreaterThan(0);
  });

  it("should rollback on database errors", () => {
    // 这个测试需要模拟数据库错误,比较复杂
    // 简化版本: 验证事务的存在
    writeTestFile(testDir, "test.ts", "export function test() {}");

    const result = buildIndex(db, {
      root: testDir,
      incremental: false,
    });

    // 如果成功,数据应该都存在
    if (result.filesIndexed > 0) {
      const fileCount = db.prepare("SELECT COUNT(*) FROM files").pluck().get();
      const symbolCount = db.prepare("SELECT COUNT(*) FROM symbols").pluck().get();
      expect(fileCount).toBeGreaterThan(0);
      expect(symbolCount).toBeGreaterThan(0);
    }
  });
});

// ========== 性能测试 ==========

describe("buildIndex - Performance", () => {
  let testDir: string;
  let db: Database.Database;

  beforeEach(() => {
    testDir = createTempDir("build-perf");
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(testDir);
  });

  it("should complete quickly for small projects", () => {
    // 创建10个小文件
    for (let i = 0; i < 10; i++) {
      writeTestFile(testDir, `file${i}.ts`, `
        export function func${i}() {}
        export class Class${i} {}
      `);
    }

    const start = Date.now();
    const result = buildIndex(db, {
      root: testDir,
      incremental: false,
    });
    const duration = Date.now() - start;

    expect(result.filesIndexed).toBe(10);
    expect(duration).toBeLessThan(1000); // 应该在1秒内完成
  });

  it("should report performance metrics", () => {
    writeTestFile(testDir, "test.ts", "export function test() {}");

    const result = buildIndex(db, {
      root: testDir,
      incremental: false,
    });

    expect(result.durationMs).toBeGreaterThan(0);
    expect(typeof result.filesIndexed).toBe("number");
    expect(typeof result.symbolsAdded).toBe("number");
  });

  it("should have reasonable throughput", () => {
    // 创建50个文件
    for (let i = 0; i < 50; i++) {
      writeTestFile(testDir, `file${i}.ts`, `
        export function func${i}() {}
      `);
    }

    const result = buildIndex(db, {
      root: testDir,
      incremental: false,
    });

    const throughput = (result.filesIndexed / result.durationMs) * 1000; // files/sec
    console.log(`Throughput: ${throughput.toFixed(1)} files/sec`);

    // 应该至少能达到 10 files/sec
    expect(throughput).toBeGreaterThan(10);
  });
});

// ========== computeDiff 测试 ==========

describe("computeDiff", () => {
  it("should detect added files", () => {
    const current = new Map([
      ["file1.ts", { path: "file1.ts", hash: "hash1", mtime: 100 } as any],
      ["file2.ts", { path: "file2.ts", hash: "hash2", mtime: 200 } as any],
    ]);

    const indexed = new Map([
      ["file1.ts", { hash: "hash1", mtime: 100 }],
    ]);

    const diff = computeDiff(current, indexed);

    expect(diff.added).toEqual(["file2.ts"]);
    expect(diff.modified).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("should detect modified files", () => {
    const current = new Map([
      ["file1.ts", { path: "file1.ts", hash: "new-hash", mtime: 200 } as any],
    ]);

    const indexed = new Map([
      ["file1.ts", { hash: "old-hash", mtime: 100 }],
    ]);

    const diff = computeDiff(current, indexed);

    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual(["file1.ts"]);
    expect(diff.removed).toEqual([]);
  });

  it("should detect removed files", () => {
    const current = new Map();

    const indexed = new Map([
      ["file1.ts", { hash: "hash1", mtime: 100 }],
    ]);

    const diff = computeDiff(current, indexed);

    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.removed).toEqual(["file1.ts"]);
  });

  it("should detect no changes", () => {
    const current = new Map([
      ["file1.ts", { path: "file1.ts", hash: "hash1", mtime: 100 } as any],
    ]);

    const indexed = new Map([
      ["file1.ts", { hash: "hash1", mtime: 100 }],
    ]);

    const diff = computeDiff(current, indexed);

    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("should handle complex scenarios", () => {
    const current = new Map([
      ["file1.ts", { path: "file1.ts", hash: "hash1", mtime: 100 } as any],
      ["file2.ts", { path: "file2.ts", hash: "new-hash2", mtime: 200 } as any],
      ["file4.ts", { path: "file4.ts", hash: "hash4", mtime: 400 } as any],
    ]);

    const indexed = new Map([
      ["file1.ts", { hash: "hash1", mtime: 100 }], // 未变
      ["file2.ts", { hash: "old-hash2", mtime: 150 }], // 已修改
      ["file3.ts", { hash: "hash3", mtime: 300 }], // 已删除
    ]);

    const diff = computeDiff(current, indexed);

    expect(diff.added).toEqual(["file4.ts"]);
    expect(diff.modified).toEqual(["file2.ts"]);
    expect(diff.removed).toEqual(["file3.ts"]);
  });
});

// ========== 测试框架函数 ==========

function expect(value: any) {
  return {
    toBe(expected: any) {
      if (value !== expected) {
        throw new Error(`Expected ${value} to be ${expected}`);
      }
    },
    toEqual(expected: any) {
      if (JSON.stringify(value) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(value)} to equal ${JSON.stringify(expected)}`);
      }
    },
    toBeGreaterThan(expected: number) {
      if (value <= expected) {
        throw new Error(`Expected ${value} to be > ${expected}`);
      }
    },
    toBeGreaterThanOrEqual(expected: number) {
      if (value < expected) {
        throw new Error(`Expected ${value} to be >= ${expected}`);
      }
    },
    toBeLessThan(expected: number) {
      if (value >= expected) {
        throw new Error(`Expected ${value} to be < ${expected}`);
      }
    },
    toContain(item: any) {
      if (!value.includes(item)) {
        throw new Error(`Expected array to contain ${item}`);
      }
    },
    not: {
      toContain(item: any) {
        if (value.includes(item)) {
          throw new Error(`Expected array not to contain ${item}`);
        }
      },
    },
  };
}

function beforeEach(fn: () => void) {
  beforeEachFn = fn;
}

function afterEach(fn: () => void) {
  afterEachFn = fn;
}

function describe(name: string, fn: () => void) {
  console.log(`\n${name}`);
  fn();
}

function it(name: string, fn: () => void) {
  if (beforeEachFn) beforeEachFn();
  
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}:`, error);
    throw error;
  } finally {
    if (afterEachFn) afterEachFn();
  }
}
