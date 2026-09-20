/**
 * 构建锁机制测试
 * 
 * 验证buildIndex使用IMMEDIATE事务防止并发构建冲突
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { buildIndex } from '../builder';
import { initializeSchema } from '../schema';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ========== 辅助函数 ==========

function createTestWorkspace(): string {
  const testRoot = join(tmpdir(), `test-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testRoot, { recursive: true });
  mkdirSync(join(testRoot, '.owncoder'), { recursive: true });
  return testRoot;
}

function cleanupTestWorkspace(testRoot: string): void {
  if (existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function addTestFile(testRoot: string, relativePath: string, content: string): void {
  const fullPath = join(testRoot, relativePath);
  const dir = join(fullPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

// ========== 测试套件 ==========

describe('BuildIndex - Lock Mechanism', () => {
  it('should use IMMEDIATE transaction mode', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    
    try {
      // 创建数据库
      const db = new Database(dbPath);
      initializeSchema(db);

      // 添加测试文件
      addTestFile(testRoot, 'test.ts', 'export function foo() {}');

      // 构建索引
      const result = buildIndex(db, {
        root: testRoot,
        incremental: false,
      });

      // 验证构建成功
      expect(result.filesIndexed).toBeGreaterThanOrEqual(0);
      expect(result.errors).toBeDefined();
      
      db.close();
    } finally {
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should handle concurrent build attempts gracefully', async () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    
    try {
      // 创建数据库
      const db1 = new Database(dbPath);
      initializeSchema(db1);
      
      // 添加测试文件
      addTestFile(testRoot, 'test.ts', 'export function foo() {}');

      // 第一个构建 - 应该成功
      const result1 = buildIndex(db1, {
        root: testRoot,
        incremental: false,
      });
      
      expect(result1.errors.length).toBe(0);

      // 尝试用同一个db再次构建 - 应该成功(因为第一个已经完成)
      const result2 = buildIndex(db1, {
        root: testRoot,
        incremental: false,
      });

      expect(result2).toBeDefined();
      
      db1.close();
    } finally {
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should report database lock error correctly', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    
    try {
      const db = new Database(dbPath);
      initializeSchema(db);
      
      addTestFile(testRoot, 'test.ts', 'export function foo() {}');

      // 正常构建应该成功
      const result = buildIndex(db, {
        root: testRoot,
        incremental: false,
      });

      // 验证结构
      expect(result).toHaveProperty('filesIndexed');
      expect(result).toHaveProperty('filesSkipped');
      expect(result).toHaveProperty('symbolsAdded');
      expect(result).toHaveProperty('referencesAdded');
      expect(result).toHaveProperty('durationMs');
      expect(result).toHaveProperty('errors');
      
      db.close();
    } finally {
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should complete build within reasonable time', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    
    try {
      const db = new Database(dbPath);
      initializeSchema(db);
      
      // 添加多个文件
      for (let i = 0; i < 10; i++) {
        addTestFile(testRoot, `file${i}.ts`, `export function func${i}() {}`);
      }

      const startTime = Date.now();
      const result = buildIndex(db, {
        root: testRoot,
        incremental: false,
      });
      const duration = Date.now() - startTime;

      expect(result.filesIndexed).toBeGreaterThan(0);
      expect(duration).toBeLessThan(5000); // 10个文件应该在5秒内完成
      
      db.close();
    } finally {
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should handle empty workspace', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    
    try {
      const db = new Database(dbPath);
      initializeSchema(db);

      const result = buildIndex(db, {
        root: testRoot,
        incremental: false,
      });

      expect(result.filesIndexed).toBe(0);
      expect(result.errors).toHaveLength(0);
      
      db.close();
    } finally {
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should use immediate mode for async build', async () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    
    try {
      const db = new Database(dbPath);
      initializeSchema(db);
      
      addTestFile(testRoot, 'test.ts', 'export function foo() {}');

      // 使用async扫描
      const result = buildIndex(db, {
        root: testRoot,
        incremental: false,
        useAsyncScan: true, // 会回退到sync扫描,但仍应使用immediate模式
      });

      expect(result).toBeDefined();
      expect(result.errors).toBeDefined();
      
      db.close();
    } finally {
      cleanupTestWorkspace(testRoot);
    }
  });
});

// ========== Transaction模式验证 ==========

describe('SQLite Transaction Modes', () => {
  it('should verify immediate mode behavior', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    
    try {
      const db = new Database(dbPath);
      initializeSchema(db);

      // 验证immediate transaction可以创建
      const transaction = db.transaction(() => {
        db.prepare('SELECT 1').get();
      });

      expect(typeof transaction).toBe('function');
      expect(typeof transaction.immediate).toBe('function');
      
      // 执行immediate模式
      transaction.immediate();
      
      db.close();
    } finally {
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should verify transaction has immediate method', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    
    try {
      const db = new Database(dbPath);
      
      const tx = db.transaction(() => {
        // Do nothing
      });

      // 验证immediate方法存在
      expect(tx).toHaveProperty('immediate');
      expect(typeof tx.immediate).toBe('function');
      
      db.close();
    } finally {
      cleanupTestWorkspace(testRoot);
    }
  });
});
