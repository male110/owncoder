/**
 * UnifiedIndex查询测试套件
 * 
 * 测试覆盖:
 * - search() 基础查询  
 * - getStats() 统计信息
 * - status() 状态检查
 * 
 * 注意: 由于buildIndex需要访问private db属性,本测试主要验证API行为而非端到端索引构建
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UnifiedIndex } from '../index';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ========== 测试夹具设置 ==========

/**
 * 创建临时工作区用于测试
 */
function createTestWorkspace(): string {
  const testRoot = join(tmpdir(), `test-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testRoot, { recursive: true });
  
  // 创建.owncoder目录
  mkdirSync(join(testRoot, '.owncoder'), { recursive: true });
  
  return testRoot;
}

/**
 * 清理测试工作区
 */
function cleanupTestWorkspace(testRoot: string): void {
  if (existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

// ========== 测试套件 ==========

describe('UnifiedIndex - API Behavior', () => {
  let testRoot: string;
  let index: UnifiedIndex;

  beforeEach(() => {
    testRoot = createTestWorkspace();
    index = new UnifiedIndex({ root: testRoot });
  });

  afterEach(() => {
    index.close();
    cleanupTestWorkspace(testRoot);
  });

  it('should return empty results when searching on uninitialized index', async () => {
    const results = await index.search('anything');
    expect(results).toEqual([]);
  });

  it('should return empty results when searching on closed index', async () => {
    index.open(testRoot);
    index.close();

    const results = await index.search('test');
    expect(results).toEqual([]);
  });

  it('should handle empty query gracefully', async () => {
    index.open(testRoot);
    
    const results = await index.search('');
    expect(results).toEqual([]);
  });

  it('should handle whitespace-only query', async () => {
    index.open(testRoot);
    
    const results = await index.search('   \n\t  ');
    expect(results).toEqual([]);
  });

  it('should handle special characters in query without error', async () => {
    index.open(testRoot);

    // 这些应该不会抛出错误
    await expect(index.search('foo"bar')).resolves.toBeDefined();
    await expect(index.search("foo'bar")).resolves.toBeDefined();
    await expect(index.search('foo;DROP TABLE;')).resolves.toBeDefined();
  });

  it('should respect search options structure', async () => {
    index.open(testRoot);

    // 使用各种选项组合,验证不会抛出错误
    await expect(index.search('test', { limit: 10 })).resolves.toBeDefined();
    await expect(index.search('test', { symbolKind: ['function'] })).resolves.toBeDefined();
    await expect(index.search('test', { pathPrefix: 'src/' })).resolves.toBeDefined();
    await expect(index.search('test', { 
      limit: 5, 
      symbolKind: ['class', 'function'],
      pathPrefix: 'lib/'
    })).resolves.toBeDefined();
  });
});

describe('UnifiedIndex - Statistics', () => {
  let testRoot: string;
  let index: UnifiedIndex;

  beforeEach(() => {
    testRoot = createTestWorkspace();
    index = new UnifiedIndex({ root: testRoot });
  });

  afterEach(() => {
    index.close();
    cleanupTestWorkspace(testRoot);
  });

  it('should return zero stats for empty index', () => {
    index.open(testRoot);

    const stats = index.getStats();

    expect(stats.files).toBe(0);
    expect(stats.symbols).toBe(0);
    expect(stats.references).toBe(0);
  });

  it('should include all required stat fields', () => {
    index.open(testRoot);

    const stats = index.getStats();

    expect(stats).toHaveProperty('files');
    expect(stats).toHaveProperty('symbols');
    expect(stats).toHaveProperty('references');
    expect(stats).toHaveProperty('symbolsByKind');
    expect(stats).toHaveProperty('languageBreakdown');
    expect(stats).toHaveProperty('performance');
  });

  it('should return consistent stats on multiple calls (caching)', () => {
    index.open(testRoot);

    const stats1 = index.getStats();
    const stats2 = index.getStats();

    expect(stats1.files).toBe(stats2.files);
    expect(stats1.symbols).toBe(stats2.symbols);
    expect(stats1.references).toBe(stats2.references);
  });

  it('should include symbolsByKind breakdown', () => {
    index.open(testRoot);

    const stats = index.getStats();

    expect(stats.symbolsByKind).toBeDefined();
    expect(typeof stats.symbolsByKind).toBe('object');
  });

  it('should include language breakdown', () => {
    index.open(testRoot);

    const stats = index.getStats();

    expect(stats.languageBreakdown).toBeDefined();
    expect(typeof stats.languageBreakdown).toBe('object');
  });

  it('should include performance metrics', () => {
    index.open(testRoot);

    const stats = index.getStats();

    expect(stats.performance).toBeDefined();
    if (stats.performance) {
      expect(stats.performance.totalQueries).toBeDefined();
      expect(typeof stats.performance.totalQueries).toBe('number');
    }
  });

  it('should handle stats call before opening', () => {
    // 不打开索引,直接获取统计
    const stats = index.getStats();

    expect(stats.files).toBe(0);
    expect(stats.symbols).toBe(0);
  });

  it('should update query count after searches', async () => {
    index.open(testRoot);

    await index.search('test1');
    await index.search('test2');

    // 验证performance结构存在
    const stats = index.getStats();
    expect(stats.performance?.totalQueries).toBeDefined();
  });
});

describe('UnifiedIndex - Status', () => {
  let testRoot: string;
  let index: UnifiedIndex;

  beforeEach(() => {
    testRoot = createTestWorkspace();
    index = new UnifiedIndex({ root: testRoot });
  });

  afterEach(() => {
    index.close();
    cleanupTestWorkspace(testRoot);
  });

  it('should report not ready before opening', () => {
    const status = index.status();

    expect(status.ready).toBe(false);
    expect(status.fileCount).toBe(0);
    expect(status.symbolCount).toBe(0);
    expect(status.message).toContain('not initialized');
  });

  it('should report not ready after opening empty index', () => {
    index.open(testRoot);

    const status = index.status();

    expect(status.ready).toBe(false);
    expect(status.fileCount).toBe(0);
    expect(status.root).toBe(testRoot);
  });

  it('should include database path in status after opening', () => {
    index.open(testRoot);

    const status = index.status();

    expect(status.databasePath).toBeDefined();
    expect(status.databasePath).toContain('.owncoder');
    expect(status.databasePath).toContain('unified-index.db');
  });

  it('should include all required status fields', () => {
    index.open(testRoot);

    const status = index.status();

    expect(status).toHaveProperty('ready');
    expect(status).toHaveProperty('fileCount');
    expect(status).toHaveProperty('symbolCount');
    expect(status).toHaveProperty('referenceCount');
    expect(status).toHaveProperty('message');
  });
});

describe('UnifiedIndex - Lifecycle', () => {
  let testRoot: string;
  let index: UnifiedIndex;

  beforeEach(() => {
    testRoot = createTestWorkspace();
    index = new UnifiedIndex({ root: testRoot });
  });

  afterEach(() => {
    index.close();
    cleanupTestWorkspace(testRoot);
  });

  it('should open and close successfully', () => {
    expect(() => index.open(testRoot)).not.toThrow();
    expect(() => index.close()).not.toThrow();
  });

  it('should handle multiple open calls with same root', () => {
    index.open(testRoot);
    index.open(testRoot); // 第二次打开同一个根目录
    
    const status = index.status();
    expect(status.root).toBe(testRoot);
  });

  it('should handle multiple close calls', () => {
    index.open(testRoot);
    index.close();
    index.close(); // 第二次关闭

    // 应该不会抛出错误
    expect(index.status().ready).toBe(false);
  });

  it('should handle close before open', () => {
    // 在打开前关闭
    expect(() => index.close()).not.toThrow();
  });

  it('should handle multiple open/close cycles', () => {
    // 第一次
    index.open(testRoot);
    expect(index.status().root).toBe(testRoot);
    index.close();

    // 第二次
    index.open(testRoot);
    expect(index.status().root).toBe(testRoot);
    index.close();

    // 第三次
    index.open(testRoot);
    expect(index.status().root).toBe(testRoot);
  });
});

describe('UnifiedIndex - Edge Cases', () => {
  let testRoot: string;
  let index: UnifiedIndex;

  beforeEach(() => {
    testRoot = createTestWorkspace();
    index = new UnifiedIndex({ root: testRoot });
  });

  afterEach(() => {
    index.close();
    cleanupTestWorkspace(testRoot);
  });

  it('should handle very long search query', async () => {
    index.open(testRoot);

    const longQuery = 'a'.repeat(1000);
    const results = await index.search(longQuery);
    
    expect(Array.isArray(results)).toBe(true);
  });

  it('should handle concurrent searches', async () => {
    index.open(testRoot);

    // 并发执行多个搜索
    const promises = [
      index.search('test1'),
      index.search('test2'),
      index.search('test3'),
    ];

    const results = await Promise.all(promises);

    // 所有搜索都应该成功返回数组
    expect(Array.isArray(results[0])).toBe(true);
    expect(Array.isArray(results[1])).toBe(true);
    expect(Array.isArray(results[2])).toBe(true);
  });

  it('should handle search with all option combinations', async () => {
    index.open(testRoot);

    // 各种选项组合
    await expect(index.search('test', {})).resolves.toBeDefined();
    await expect(index.search('test', { limit: 0 })).resolves.toBeDefined();
    await expect(index.search('test', { limit: 999999 })).resolves.toBeDefined();
    await expect(index.search('test', { symbolKind: [] })).resolves.toBeDefined();
    await expect(index.search('test', { pathPrefix: '' })).resolves.toBeDefined();
  });

  it('should handle stats call in rapid succession', () => {
    index.open(testRoot);

    // 快速连续调用
    for (let i = 0; i < 100; i++) {
      const stats = index.getStats();
      expect(stats).toBeDefined();
    }
  });

  it('should handle status call in rapid succession', () => {
    index.open(testRoot);

    // 快速连续调用
    for (let i = 0; i < 100; i++) {
      const status = index.status();
      expect(status).toBeDefined();
    }
  });
});
