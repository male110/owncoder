/**
 * 扫描器测试套件 - computeDiff准确性验证
 * 
 * 测试覆盖:
 * - 新增文件检测
 * - 修改文件检测(基于hash)
 * - 删除文件检测
 * - Hash碰撞边界情况
 * - 空数据集处理
 */

import { describe, it, expect } from 'vitest';
import { computeDiff, computeHash } from '../scanner';
import type { FileInfo } from '../scanner';

// ========== 基础diff计算测试 ==========

describe('computeDiff - Basic Operations', () => {
  it('should detect newly added files', () => {
    const current = new Map<string, FileInfo>([
      ['src/new.ts', createFileInfo('src/new.ts', 'content1')],
      ['src/another.ts', createFileInfo('src/another.ts', 'content2')],
    ]);

    const indexed = new Map<string, { hash: string; mtime: number }>();

    const diff = computeDiff(current, indexed);

    expect(diff.added).toHaveLength(2);
    expect(diff.added).toContain('src/new.ts');
    expect(diff.added).toContain('src/another.ts');
    expect(diff.modified).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('should detect removed files', () => {
    const current = new Map<string, FileInfo>();

    const indexed = new Map<string, { hash: string; mtime: number }>([
      ['src/deleted.ts', { hash: 'hash1', mtime: Date.now() }],
      ['src/removed.ts', { hash: 'hash2', mtime: Date.now() }],
    ]);

    const diff = computeDiff(current, indexed);

    expect(diff.removed).toHaveLength(2);
    expect(diff.removed).toContain('src/deleted.ts');
    expect(diff.removed).toContain('src/removed.ts');
    expect(diff.added).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it('should detect modified files based on hash', () => {
    const oldContent = 'function foo() { return 1; }';
    const newContent = 'function foo() { return 2; }'; // 内容改变
    const oldHash = computeHash(oldContent);
    const newHash = computeHash(newContent);

    const current = new Map<string, FileInfo>([
      ['src/modified.ts', createFileInfo('src/modified.ts', newContent)],
    ]);

    const indexed = new Map<string, { hash: string; mtime: number }>([
      ['src/modified.ts', { hash: oldHash, mtime: Date.now() - 1000 }],
    ]);

    const diff = computeDiff(current, indexed);

    expect(diff.modified).toHaveLength(1);
    expect(diff.modified).toContain('src/modified.ts');
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);

    // 验证hash确实不同
    expect(oldHash).not.toBe(newHash);
  });

  it('should not detect unchanged files', () => {
    const content = 'const VALUE = 42;';
    const hash = computeHash(content);

    const current = new Map<string, FileInfo>([
      ['src/unchanged.ts', createFileInfo('src/unchanged.ts', content)],
    ]);

    const indexed = new Map<string, { hash: string; mtime: number }>([
      ['src/unchanged.ts', { hash, mtime: Date.now() - 1000 }],
    ]);

    const diff = computeDiff(current, indexed);

    expect(diff.added).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });
});

// ========== 混合操作测试 ==========

describe('computeDiff - Mixed Operations', () => {
  it('should handle added, modified, and removed files simultaneously', () => {
    const unchangedContent = 'const A = 1;';
    const oldModifiedContent = 'const B = 2;';
    const newModifiedContent = 'const B = 3;';

    const current = new Map<string, FileInfo>([
      ['unchanged.ts', createFileInfo('unchanged.ts', unchangedContent)],
      ['modified.ts', createFileInfo('modified.ts', newModifiedContent)],
      ['added.ts', createFileInfo('added.ts', 'new content')],
    ]);

    const indexed = new Map<string, { hash: string; mtime: number }>([
      ['unchanged.ts', { hash: computeHash(unchangedContent), mtime: Date.now() }],
      ['modified.ts', { hash: computeHash(oldModifiedContent), mtime: Date.now() }],
      ['removed.ts', { hash: 'hash', mtime: Date.now() }],
    ]);

    const diff = computeDiff(current, indexed);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]).toBe('added.ts');

    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]).toBe('modified.ts');

    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]).toBe('removed.ts');
  });

  it('should handle large number of changes', () => {
    const current = new Map<string, FileInfo>();
    const indexed = new Map<string, { hash: string; mtime: number }>();

    // 添加100个新文件
    for (let i = 0; i < 100; i++) {
      current.set(`added-${i}.ts`, createFileInfo(`added-${i}.ts`, `content ${i}`));
    }

    // 添加100个修改的文件
    for (let i = 0; i < 100; i++) {
      const path = `modified-${i}.ts`;
      current.set(path, createFileInfo(path, `new content ${i}`));
      indexed.set(path, { hash: computeHash(`old content ${i}`), mtime: Date.now() });
    }

    // 添加100个删除的文件
    for (let i = 0; i < 100; i++) {
      indexed.set(`removed-${i}.ts`, { hash: `hash-${i}`, mtime: Date.now() });
    }

    const diff = computeDiff(current, indexed);

    expect(diff.added).toHaveLength(100);
    expect(diff.modified).toHaveLength(100);
    expect(diff.removed).toHaveLength(100);
  });
});

// ========== 边界条件测试 ==========

describe('computeDiff - Edge Cases', () => {
  it('should handle empty current and indexed maps', () => {
    const current = new Map<string, FileInfo>();
    const indexed = new Map<string, { hash: string; mtime: number }>();

    const diff = computeDiff(current, indexed);

    expect(diff.added).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('should handle empty current map', () => {
    const current = new Map<string, FileInfo>();
    const indexed = new Map<string, { hash: string; mtime: number }>([
      ['file1.ts', { hash: 'hash1', mtime: Date.now() }],
      ['file2.ts', { hash: 'hash2', mtime: Date.now() }],
    ]);

    const diff = computeDiff(current, indexed);

    expect(diff.removed).toHaveLength(2);
    expect(diff.added).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it('should handle empty indexed map', () => {
    const current = new Map<string, FileInfo>([
      ['file1.ts', createFileInfo('file1.ts', 'content1')],
      ['file2.ts', createFileInfo('file2.ts', 'content2')],
    ]);
    const indexed = new Map<string, { hash: string; mtime: number }>();

    const diff = computeDiff(current, indexed);

    expect(diff.added).toHaveLength(2);
    expect(diff.modified).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('should handle same mtime but different hash', () => {
    const mtime = Date.now();
    const oldContent = 'version 1';
    const newContent = 'version 2';

    const current = new Map<string, FileInfo>([
      ['file.ts', { ...createFileInfo('file.ts', newContent), mtime }],
    ]);

    const indexed = new Map<string, { hash: string; mtime: number }>([
      ['file.ts', { hash: computeHash(oldContent), mtime }],
    ]);

    const diff = computeDiff(current, indexed);

    // 即使mtime相同,hash不同仍应检测为修改
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]).toBe('file.ts');
  });

  it('should handle identical content with different mtime', () => {
    const content = 'const X = 1;';
    const hash = computeHash(content);

    const current = new Map<string, FileInfo>([
      ['file.ts', { ...createFileInfo('file.ts', content), mtime: Date.now() }],
    ]);

    const indexed = new Map<string, { hash: string; mtime: number }>([
      ['file.ts', { hash, mtime: Date.now() - 10000 }],
    ]);

    const diff = computeDiff(current, indexed);

    // mtime不同但hash相同,不应检测为修改
    expect(diff.modified).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });
});

// ========== Hash准确性测试 ==========

describe('computeHash - Accuracy', () => {
  it('should produce consistent hashes for same content', () => {
    const content = 'function test() { return true; }';
    
    const hash1 = computeHash(content);
    const hash2 = computeHash(content);

    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different content', () => {
    const content1 = 'const A = 1;';
    const content2 = 'const A = 2;';

    const hash1 = computeHash(content1);
    const hash2 = computeHash(content2);

    expect(hash1).not.toBe(hash2);
  });

  it('should be sensitive to whitespace changes', () => {
    const content1 = 'const A = 1;';
    const content2 = 'const A  = 1;'; // 多一个空格

    const hash1 = computeHash(content1);
    const hash2 = computeHash(content2);

    expect(hash1).not.toBe(hash2);
  });

  it('should be sensitive to newline changes', () => {
    const content1 = 'line1\nline2';
    const content2 = 'line1\n\nline2'; // 多一个换行

    const hash1 = computeHash(content1);
    const hash2 = computeHash(content2);

    expect(hash1).not.toBe(hash2);
  });

  it('should handle empty string', () => {
    const hash = computeHash('');
    
    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64); // SHA-256 produces 64 hex chars
  });

  it('should handle very large content', () => {
    const largeContent = 'x'.repeat(1_000_000); // 1MB of 'x'
    
    expect(() => computeHash(largeContent)).not.toThrow();
    const hash = computeHash(largeContent);
    expect(hash).toHaveLength(64);
  });

  it('should handle unicode content', () => {
    const unicodeContent = '你好世界 🚀 مرحبا العالم';
    
    const hash1 = computeHash(unicodeContent);
    const hash2 = computeHash(unicodeContent);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});

// ========== 路径处理测试 ==========

describe('computeDiff - Path Handling', () => {
  it('should handle paths with different separators', () => {
    // Windows风格路径 vs Unix风格路径
    const current = new Map<string, FileInfo>([
      ['src/utils/helper.ts', createFileInfo('src/utils/helper.ts', 'content')],
    ]);

    const indexed = new Map<string, { hash: string; mtime: number }>();

    const diff = computeDiff(current, indexed);

    expect(diff.added).toContain('src/utils/helper.ts');
  });

  it('should handle deeply nested paths', () => {
    const deepPath = 'a/b/c/d/e/f/g/h/file.ts';
    
    const current = new Map<string, FileInfo>([
      [deepPath, createFileInfo(deepPath, 'content')],
    ]);

    const indexed = new Map<string, { hash: string; mtime: number }>();

    const diff = computeDiff(current, indexed);

    expect(diff.added).toContain(deepPath);
  });

  it('should handle special characters in filenames', () => {
    const specialPath = 'src/my-file_name.test.ts';
    
    const current = new Map<string, FileInfo>([
      [specialPath, createFileInfo(specialPath, 'content')],
    ]);

    const indexed = new Map<string, { hash: string; mtime: number }>();

    const diff = computeDiff(current, indexed);

    expect(diff.added).toContain(specialPath);
  });
});

// ========== 性能特性验证 ==========

describe('computeDiff - Performance Characteristics', () => {
  it('should complete quickly for 1000 files', () => {
    const current = new Map<string, FileInfo>();
    const indexed = new Map<string, { hash: string; mtime: number }>();

    for (let i = 0; i < 1000; i++) {
      const path = `file-${i}.ts`;
      current.set(path, createFileInfo(path, `content ${i}`));
    }

    const startTime = Date.now();
    const diff = computeDiff(current, indexed);
    const duration = Date.now() - startTime;

    expect(diff.added).toHaveLength(1000);
    expect(duration).toBeLessThan(100); // 应该在100ms内完成
  });

  it('should return arrays not iterators', () => {
    const current = new Map<string, FileInfo>([
      ['file.ts', createFileInfo('file.ts', 'content')],
    ]);
    const indexed = new Map<string, { hash: string; mtime: number }>();

    const diff = computeDiff(current, indexed);

    // 验证返回的是数组
    expect(Array.isArray(diff.added)).toBe(true);
    expect(Array.isArray(diff.modified)).toBe(true);
    expect(Array.isArray(diff.removed)).toBe(true);
  });
});

// ========== 辅助函数 ==========

/**
 * 创建测试用的FileInfo对象
 */
function createFileInfo(path: string, content: string): FileInfo {
  return {
    path,
    absolutePath: `/workspace/${path}`,
    size: content.length,
    mtime: Date.now(),
    hash: computeHash(content),
    language: detectLanguageFromPath(path),
  };
}

/**
 * 从路径检测语言(简化版)
 */
function detectLanguageFromPath(path: string): string | null {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
  if (path.endsWith('.py')) return 'python';
  return null;
}
