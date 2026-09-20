/**
 * Scanner Generator测试
 * 
 * 验证scanWorkspace的Generator模式实现,确保:
 * - 正确逐个yield文件
 * - 内存友好,不会一次性加载所有文件
 * - 兼容现有使用方式(Array.from)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scanWorkspace } from "../scanner.ts";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("scanWorkspace Generator Mode", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "scanner-gen-"));
  });

  afterEach(() => {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch (error) {
        // Windows可能锁定文件,忽略删除错误
      }
    }
  });

  describe("Generator Behavior", () => {
    it("should be a generator function", () => {
      const result = scanWorkspace({ root: tempDir });
      
      // Generator对象应该有next方法和Symbol.iterator
      expect(typeof result.next).toBe("function");
      expect(typeof result[Symbol.iterator]).toBe("function");
    });

    it("should yield files one by one", () => {
      // 创建测试文件
      writeFileSync(join(tempDir, "file1.ts"), "export const a = 1;");
      writeFileSync(join(tempDir, "file2.ts"), "export const b = 2;");
      writeFileSync(join(tempDir, "file3.ts"), "export const c = 3;");

      const gen = scanWorkspace({ root: tempDir });
      
      // 第一次调用next
      const first = gen.next();
      expect(first.done).toBe(false);
      expect(first.value).toBeDefined();
      expect(first.value?.path).toMatch(/file[123]\.ts$/);

      // 第二次调用next
      const second = gen.next();
      expect(second.done).toBe(false);
      expect(second.value).toBeDefined();

      // 第三次调用next
      const third = gen.next();
      expect(third.done).toBe(false);
      expect(third.value).toBeDefined();

      // 第四次调用next - 应该结束
      const fourth = gen.next();
      expect(fourth.done).toBe(true);
      expect(fourth.value).toBeUndefined();
    });

    it("should work with for...of loop", () => {
      writeFileSync(join(tempDir, "a.ts"), "export const a = 1;");
      writeFileSync(join(tempDir, "b.ts"), "export const b = 2;");

      const files: string[] = [];
      for (const file of scanWorkspace({ root: tempDir })) {
        files.push(file.path);
      }

      expect(files).toHaveLength(2);
      expect(files).toContain("a.ts");
      expect(files).toContain("b.ts");
    });

    it("should support early termination", () => {
      // 创建多个文件
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(tempDir, `file${i}.ts`), `export const x${i} = ${i};`);
      }

      let count = 0;
      for (const _file of scanWorkspace({ root: tempDir })) {
        count++;
        if (count === 3) break; // 提前终止
      }

      expect(count).toBe(3); // 只处理了3个文件
    });

    it("should allow resuming iteration", () => {
      writeFileSync(join(tempDir, "a.ts"), "export const a = 1;");
      writeFileSync(join(tempDir, "b.ts"), "export const b = 2;");
      writeFileSync(join(tempDir, "c.ts"), "export const c = 3;");

      const gen = scanWorkspace({ root: tempDir });
      
      // 处理前两个
      gen.next();
      gen.next();

      // 处理剩余的
      const remaining = [];
      let result = gen.next();
      while (!result.done) {
        remaining.push(result.value);
        result = gen.next();
      }

      expect(remaining.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Backward Compatibility", () => {
    it("should work with Array.from()", () => {
      writeFileSync(join(tempDir, "test1.ts"), "export const x = 1;");
      writeFileSync(join(tempDir, "test2.ts"), "export const y = 2;");

      const files = Array.from(scanWorkspace({ root: tempDir }));

      expect(Array.isArray(files)).toBe(true);
      expect(files).toHaveLength(2);
      expect(files[0]).toHaveProperty("path");
      expect(files[0]).toHaveProperty("hash");
    });

    it("should work with spread operator", () => {
      writeFileSync(join(tempDir, "a.ts"), "export const a = 1;");
      writeFileSync(join(tempDir, "b.ts"), "export const b = 2;");

      const files = [...scanWorkspace({ root: tempDir })];

      expect(Array.isArray(files)).toBe(true);
      expect(files).toHaveLength(2);
    });

    it("should support manual iteration", () => {
      writeFileSync(join(tempDir, "test.ts"), "export const test = 1;");

      const gen = scanWorkspace({ root: tempDir });
      const files = [];
      
      for (let result = gen.next(); !result.done; result = gen.next()) {
        files.push(result.value);
      }

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("test.ts");
    });
  });

  describe("Memory Efficiency", () => {
    it("should not load all files into memory immediately", () => {
      // 创建一些文件
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(tempDir, `file${i}.ts`), `export const x${i} = ${i};`);
      }

      const gen = scanWorkspace({ root: tempDir });
      
      // Generator不应该立即处理所有文件
      // 我们可以通过调用next()来验证懒加载行为
      const firstCall = gen.next();
      expect(firstCall.done).toBe(false);
      
      // 此时只应该处理了一个文件
      // (虽然我们无法直接测量内存,但可以验证行为)
    });

    it("should handle large number of files efficiently", () => {
      // 创建100个文件
      for (let i = 0; i < 100; i++) {
        writeFileSync(join(tempDir, `file${i}.ts`), `export const x = ${i};`);
      }

      const start = performance.now();
      
      // 只处理前10个文件
      let count = 0;
      for (const _file of scanWorkspace({ root: tempDir })) {
        count++;
        if (count === 10) break;
      }

      const duration = performance.now() - start;

      expect(count).toBe(10);
      // 应该非常快,因为只处理了10个文件
      expect(duration).toBeLessThan(50); // <50ms
    });

    it("should support selective processing", () => {
      writeFileSync(join(tempDir, "important.ts"), "export const data = 1;");
      writeFileSync(join(tempDir, "skip.ts"), "export const skip = 1;");
      writeFileSync(join(tempDir, "also-important.ts"), "export const more = 1;");

      const important = [];
      for (const file of scanWorkspace({ root: tempDir })) {
        if (file.path.includes("important")) {
          important.push(file);
        }
      }

      expect(important).toHaveLength(2);
    });
  });

  describe("Nested Directories", () => {
    it("should yield files from nested directories", () => {
      mkdirSync(join(tempDir, "src"), { recursive: true });
      mkdirSync(join(tempDir, "src/lib"), { recursive: true });

      writeFileSync(join(tempDir, "root.ts"), "export const root = 1;");
      writeFileSync(join(tempDir, "src/index.ts"), "export const src = 1;");
      writeFileSync(join(tempDir, "src/lib/util.ts"), "export const lib = 1;");

      const files = [...scanWorkspace({ root: tempDir })];

      expect(files).toHaveLength(3);
      expect(files.some(f => f.path === "root.ts")).toBe(true);
      expect(files.some(f => f.path === "src/index.ts")).toBe(true);
      expect(files.some(f => f.path === "src/lib/util.ts")).toBe(true);
    });

    it("should respect directory exclusions", () => {
      mkdirSync(join(tempDir, "src"), { recursive: true });
      mkdirSync(join(tempDir, "node_modules"), { recursive: true });

      writeFileSync(join(tempDir, "src/index.ts"), "export const src = 1;");
      writeFileSync(join(tempDir, "node_modules/pkg.ts"), "export const pkg = 1;");

      const files = [...scanWorkspace({ root: tempDir })];

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("src/index.ts");
    });
  });

  describe("File Properties", () => {
    it("should include all required properties", () => {
      writeFileSync(join(tempDir, "test.ts"), "export const test = 1;");

      const gen = scanWorkspace({ root: tempDir });
      const file = gen.next().value;

      expect(file).toBeDefined();
      expect(file).toHaveProperty("path");
      expect(file).toHaveProperty("absolutePath");
      expect(file).toHaveProperty("size");
      expect(file).toHaveProperty("mtime");
      expect(file).toHaveProperty("hash");
      expect(file).toHaveProperty("language");

      expect(typeof file?.path).toBe("string");
      expect(typeof file?.hash).toBe("string");
      expect(typeof file?.size).toBe("number");
      expect(typeof file?.mtime).toBe("number");
    });

    it("should compute correct hash for files", () => {
      const content = "export const value = 42;";
      writeFileSync(join(tempDir, "test.ts"), content);

      const file = [...scanWorkspace({ root: tempDir })][0];

      expect(file.hash).toBeDefined();
      expect(file.hash.length).toBe(64); // SHA-256 produces 64 hex chars
    });

    it("should detect language correctly", () => {
      writeFileSync(join(tempDir, "script.ts"), "const x = 1;");
      writeFileSync(join(tempDir, "module.py"), "x = 1");
      writeFileSync(join(tempDir, "main.rs"), "fn main() {}");

      const files = [...scanWorkspace({ root: tempDir })];

      const tsFile = files.find(f => f.path === "script.ts");
      const pyFile = files.find(f => f.path === "module.py");
      const rsFile = files.find(f => f.path === "main.rs");

      expect(tsFile?.language).toBe("typescript");
      expect(pyFile?.language).toBe("python");
      expect(rsFile?.language).toBe("rust");
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty directory", () => {
      const files = [...scanWorkspace({ root: tempDir })];
      expect(files).toHaveLength(0);
    });

    it("should skip non-indexable files", () => {
      writeFileSync(join(tempDir, "readme.md"), "# README");
      writeFileSync(join(tempDir, "data.json"), "{}");
      writeFileSync(join(tempDir, "valid.ts"), "export const x = 1;");

      const files = [...scanWorkspace({ root: tempDir })];

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("valid.ts");
    });

    it("should handle files with special characters", () => {
      writeFileSync(join(tempDir, "file-with-dash.ts"), "export const x = 1;");
      writeFileSync(join(tempDir, "file_with_underscore.ts"), "export const y = 1;");

      const files = [...scanWorkspace({ root: tempDir })];

      expect(files).toHaveLength(2);
    });

    it("should handle files too large to index", () => {
      // 创建一个小文件
      writeFileSync(join(tempDir, "small.ts"), "export const x = 1;");
      
      // 创建一个超过默认限制的大文件(>130KB)
      const largeContent = "a".repeat(131 * 1024);
      writeFileSync(join(tempDir, "large.ts"), largeContent);

      const files = [...scanWorkspace({ root: tempDir })];

      // 只应该索引小文件
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("small.ts");
    });
  });
});
