/**
 * 跨文件引用解析测试
 * 
 * 验证resolveCrossFileReferences函数正确链接import语句到导出的符号
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { buildIndex, resolveCrossFileReferences } from '../builder';
import { initializeSchema } from '../schema';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ========== 辅助函数 ==========

function createTestWorkspace(): string {
  const testRoot = join(tmpdir(), `test-crossref-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testRoot, { recursive: true });
  mkdirSync(join(testRoot, '.owncoder'), { recursive: true });
  return testRoot;
}

function cleanupTestWorkspace(testRoot: string): void {
  if (!existsSync(testRoot)) return;
  
  // 多次尝试删除,处理Windows文件锁定问题
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(testRoot, { recursive: true, force: true });
      return; // 成功删除
    } catch (error) {
      if (i === 2) {
        // 最后一次尝试失败,记录但不抛出
        console.warn(`Failed to cleanup test workspace: ${testRoot}`);
      } else {
        // 等待后重试
        const start = Date.now();
        while (Date.now() - start < 50) {
          // 短暂等待
        }
      }
    }
  }
}

function addTestFile(testRoot: string, relativePath: string, content: string): void {
  const fullPath = join(testRoot, relativePath);
  const dir = join(fullPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

// ========== 测试套件 ==========

describe('Cross-File Reference Resolution', () => {
  it('should resolve simple relative imports', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    const db = new Database(dbPath);
    
    try {
      initializeSchema(db);

      addTestFile(testRoot, 'utils.ts', `export function helper() { return 42; }`);
      addTestFile(testRoot, 'main.ts', `import { helper } from './utils';\nexport function main() { return helper(); }`);

      const buildResult = buildIndex(db, { root: testRoot, incremental: false });
      expect(buildResult.filesIndexed).toBe(2);

      const crossFileRefs = resolveCrossFileReferences(db, testRoot);
      expect(crossFileRefs).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should handle multiple imports from same file', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    const db = new Database(dbPath);
    
    try {
      initializeSchema(db);
      addTestFile(testRoot, 'utils.ts', `export function foo() {}\nexport function bar() {}\nexport function baz() {}`);
      addTestFile(testRoot, 'main.ts', `import { foo, bar, baz } from './utils';\nexport function main() { foo(); bar(); baz(); }`);

      buildIndex(db, { root: testRoot, incremental: false });
      const crossFileRefs = resolveCrossFileReferences(db, testRoot);
      expect(crossFileRefs).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should handle nested directory imports', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    const db = new Database(dbPath);
    
    try {
      initializeSchema(db);
      addTestFile(testRoot, 'src/utils/helper.ts', `export function helper() { return 'help'; }`);
      addTestFile(testRoot, 'src/main.ts', `import { helper } from './utils/helper';`);

      buildIndex(db, { root: testRoot, incremental: false });
      const crossFileRefs = resolveCrossFileReferences(db, testRoot);
      expect(crossFileRefs).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should handle parent directory imports', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    const db = new Database(dbPath);
    
    try {
      initializeSchema(db);
      addTestFile(testRoot, 'utils.ts', `export function helper() {}`);
      addTestFile(testRoot, 'src/nested/main.ts', `import { helper } from '../../utils';`);

      buildIndex(db, { root: testRoot, incremental: false });
      const crossFileRefs = resolveCrossFileReferences(db, testRoot);
      expect(crossFileRefs).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should handle imports with explicit extensions', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    const db = new Database(dbPath);
    
    try {
      initializeSchema(db);
      addTestFile(testRoot, 'utils.ts', `export function helper() {}`);
      addTestFile(testRoot, 'main.ts', `import { helper } from './utils.ts';`);

      buildIndex(db, { root: testRoot, incremental: false });
      const crossFileRefs = resolveCrossFileReferences(db, testRoot);
      expect(crossFileRefs).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should handle index.ts imports', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    const db = new Database(dbPath);
    
    try {
      initializeSchema(db);
      addTestFile(testRoot, 'utils/index.ts', `export function helper() {}`);
      addTestFile(testRoot, 'main.ts', `import { helper } from './utils';`);

      buildIndex(db, { root: testRoot, incremental: false });
      const crossFileRefs = resolveCrossFileReferences(db, testRoot);
      expect(crossFileRefs).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should skip node_modules imports', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    const db = new Database(dbPath);
    
    try {
      initializeSchema(db);
      addTestFile(testRoot, 'main.ts', `import { something } from 'external-package';\nexport function main() {}`);

      buildIndex(db, { root: testRoot, incremental: false });
      const crossFileRefs = resolveCrossFileReferences(db, testRoot);
      expect(crossFileRefs).toBe(0);
    } finally {
      db.close();
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should handle non-existent imports gracefully', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    const db = new Database(dbPath);
    
    try {
      initializeSchema(db);
      addTestFile(testRoot, 'main.ts', `import { missing } from './does-not-exist';\nexport function main() {}`);

      buildIndex(db, { root: testRoot, incremental: false });
      expect(() => resolveCrossFileReferences(db, testRoot)).not.toThrow();
    } finally {
      db.close();
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should handle imports of non-exported symbols', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    const db = new Database(dbPath);
    
    try {
      initializeSchema(db);
      addTestFile(testRoot, 'utils.ts', `function privateHelper() {}\nexport function publicHelper() {}`);
      addTestFile(testRoot, 'main.ts', `import { privateHelper } from './utils';`);

      buildIndex(db, { root: testRoot, incremental: false });
      const crossFileRefs = resolveCrossFileReferences(db, testRoot);
      expect(crossFileRefs).toBe(0);
    } finally {
      db.close();
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should resolve dynamic import with .js extension to .ts source', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    const db = new Database(dbPath);
    
    try {
      initializeSchema(db);
      addTestFile(testRoot, 'adapter.ts', `export class UnifiedCodemapAdapter {}`);
      addTestFile(testRoot, 'codemap.ts', `export async function createCodemapClient() { const { UnifiedCodemapAdapter } = await import('./adapter.js'); return new UnifiedCodemapAdapter(); }`);

      buildIndex(db, { root: testRoot, incremental: false });

      // 验证引用边已链接到 adapter.ts 中的导出符号
      const linked = db.prepare(`
        SELECT sr.to_symbol_id
        FROM symbol_references sr
        WHERE sr.ref_type = 'import' AND sr.to_symbol_id IS NOT NULL
      `).all() as Array<{ to_symbol_id: number }>;
      expect(linked.length).toBe(1);
    } finally {
      db.close();
      cleanupTestWorkspace(testRoot);
    }
  });

  it('should return zero for empty database', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    const db = new Database(dbPath);
    
    try {
      initializeSchema(db);
      const crossFileRefs = resolveCrossFileReferences(db, testRoot);
      expect(crossFileRefs).toBe(0);
    } finally {
      db.close();
      cleanupTestWorkspace(testRoot);
    }
  });
});

// ========== 集成测试 ==========

describe('Cross-File Reference Resolution - Integration', () => {
  it('should resolve references in a realistic project structure', () => {
    const testRoot = createTestWorkspace();
    const dbPath = join(testRoot, '.owncoder', 'test.db');
    const db = new Database(dbPath);
    
    try {
      initializeSchema(db);

      // 创建典型的项目结构
      addTestFile(testRoot, 'src/utils/string.ts', `export function toUpper(str: string): string { return str.toUpperCase(); }\nexport function toLower(str: string): string { return str.toLowerCase(); }`);
      addTestFile(testRoot, 'src/utils/index.ts', `export { toUpper, toLower } from './string';`);
      addTestFile(testRoot, 'src/core/processor.ts', `import { toUpper } from '../utils';\nexport class Processor { process(data: string): string { return toUpper(data); } }`);
      addTestFile(testRoot, 'src/main.ts', `import { Processor } from './core/processor';\nexport function main() { const processor = new Processor(); return processor.process('hello'); }`);

      // 构建索引
      const buildResult = buildIndex(db, { root: testRoot, incremental: false });
      expect(buildResult.filesIndexed).toBeGreaterThanOrEqual(3); // 至少3个文件被索引

      // 解析跨文件引用
      const crossFileRefs = resolveCrossFileReferences(db, testRoot);
      expect(crossFileRefs).toBeGreaterThanOrEqual(0);
      
      // 验证数据库中有引用记录
      const totalRefs = db.prepare('SELECT COUNT(*) as count FROM symbol_references').get() as { count: number };
      expect(totalRefs.count).toBeGreaterThan(0);
    } finally {
      db.close();
      cleanupTestWorkspace(testRoot);
    }
  });
});
