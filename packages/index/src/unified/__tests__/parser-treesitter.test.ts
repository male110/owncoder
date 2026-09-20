/**
 * Tree-sitter 解析器测试
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  initTreeSitter,
  extractSymbolsTreeSitter,
  extractReferencesTreeSitter,
  isLanguageSupported,
  getSupportedLanguages,
} from "../parser-treesitter.js";

describe("parser-treesitter", () => {
  beforeAll(async () => {
    // 初始化 tree-sitter (测试环境需要)
    await initTreeSitter();
  });

  describe("isLanguageSupported", () => {
    it("should support common languages", () => {
      expect(isLanguageSupported("typescript")).toBe(true);
      expect(isLanguageSupported("javascript")).toBe(true);
      expect(isLanguageSupported("python")).toBe(true);
      expect(isLanguageSupported("rust")).toBe(true);
      expect(isLanguageSupported("go")).toBe(true);
      expect(isLanguageSupported("java")).toBe(true);
      expect(isLanguageSupported("csharp")).toBe(true);
      expect(isLanguageSupported("ruby")).toBe(true);
    });

    it("should not support unsupported languages", () => {
      expect(isLanguageSupported("cobol")).toBe(false);
      expect(isLanguageSupported("fortran")).toBe(false);
    });
  });

  describe("getSupportedLanguages", () => {
    it("should return list of supported languages", () => {
      const languages = getSupportedLanguages();
      expect(languages.length).toBeGreaterThan(30);
      expect(languages).toContain("typescript");
      expect(languages).toContain("python");
      expect(languages).toContain("rust");
    });
  });

  describe("extractSymbolsTreeSitter - TypeScript", () => {
    it("should extract function declarations", async () => {
      const code = `
        export function hello(name: string): string {
          return \`Hello, \${name}\`;
        }
      `;

      const symbols = await extractSymbolsTreeSitter(code, "typescript");

      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe("hello");
      expect(symbols[0].kind).toBe("function");
      expect(symbols[0].exported).toBe(true);
    });

    it("should extract arrow functions", async () => {
      const code = `
        export const add = (a: number, b: number) => a + b;
      `;

      const symbols = await extractSymbolsTreeSitter(code, "typescript");

      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe("add");
      expect(symbols[0].kind).toBe("function");
      expect(symbols[0].exported).toBe(true);
    });

    it("should extract class declarations", async () => {
      const code = `
        export class Person {
          constructor(public name: string) {}
          
          greet() {
            return \`Hello, \${this.name}\`;
          }
        }
      `;

      const symbols = await extractSymbolsTreeSitter(code, "typescript");

      const classes = symbols.filter((s) => s.kind === "class");
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe("Person");
      expect(classes[0].exported).toBe(true);
    });

    it("should extract interfaces", async () => {
      const code = `
        export interface User {
          id: number;
          name: string;
        }
      `;

      const symbols = await extractSymbolsTreeSitter(code, "typescript");

      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe("User");
      expect(symbols[0].kind).toBe("interface");
      expect(symbols[0].exported).toBe(true);
    });

    it("should extract type aliases", async () => {
      const code = `
        export type UserId = string | number;
      `;

      const symbols = await extractSymbolsTreeSitter(code, "typescript");

      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe("UserId");
      expect(symbols[0].kind).toBe("type");
      expect(symbols[0].exported).toBe(true);
    });

    it("should extract enums", async () => {
      const code = `
        export enum Status {
          Active,
          Inactive
        }
      `;

      const symbols = await extractSymbolsTreeSitter(code, "typescript");

      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe("Status");
      expect(symbols[0].kind).toBe("enum");
      expect(symbols[0].exported).toBe(true);
    });
  });

  describe("extractSymbolsTreeSitter - Python", () => {
    it("should extract function definitions", async () => {
      const code = `
def hello(name):
    return f"Hello, {name}"
      `;

      const symbols = await extractSymbolsTreeSitter(code, "python");

      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe("hello");
      expect(symbols[0].kind).toBe("function");
      expect(symbols[0].exported).toBe(true); // Python 不以_开头即为公开
    });

    it("should extract class definitions", async () => {
      const code = `
class Person:
    def __init__(self, name):
        self.name = name
    
    def greet(self):
        return f"Hello, {self.name}"
      `;

      const symbols = await extractSymbolsTreeSitter(code, "python");

      const classes = symbols.filter((s) => s.kind === "class");
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe("Person");
    });

    it("should detect private functions", async () => {
      const code = `
def _internal_helper():
    pass

def public_api():
    pass
      `;

      const symbols = await extractSymbolsTreeSitter(code, "python");

      expect(symbols).toHaveLength(2);
      
      const privateFunc = symbols.find((s) => s.name === "_internal_helper");
      expect(privateFunc?.exported).toBe(false);
      
      const publicFunc = symbols.find((s) => s.name === "public_api");
      expect(publicFunc?.exported).toBe(true);
    });
  });

  describe("extractReferencesTreeSitter - TypeScript", () => {
    it("should extract import statements", async () => {
      const code = `
        import { helper, util } from './utils';
        import logger from './logger';
      `;

      const references = await extractReferencesTreeSitter(code, "typescript");

      expect(references.length).toBeGreaterThanOrEqual(2);
      
      const helperImport = references.find((r) => r.toSymbolName === "helper");
      expect(helperImport).toBeDefined();
      expect(helperImport?.refType).toBe("import");
      expect(helperImport?.importPath).toBe("./utils");
      
      const loggerImport = references.find((r) => r.toSymbolName === "logger");
      expect(loggerImport).toBeDefined();
      expect(loggerImport?.refType).toBe("import");
      expect(loggerImport?.importPath).toBe("./logger");
    });

    it("should extract function calls", async () => {
      const code = `
        function main() {
          helper();
          console.log('done');
        }
      `;

      const references = await extractReferencesTreeSitter(code, "typescript");

      const helperCall = references.find((r) => r.toSymbolName === "helper");
      expect(helperCall).toBeDefined();
      expect(helperCall?.refType).toBe("call");
      
      const logCall = references.find((r) => r.toSymbolName === "log");
      expect(logCall).toBeDefined();
      expect(logCall?.refType).toBe("call");
    });
  });

  describe("extractReferencesTreeSitter - Python", () => {
    it("should extract import statements", async () => {
      const code = `
from utils import helper
import os
      `;

      const references = await extractReferencesTreeSitter(code, "python");

      expect(references.length).toBeGreaterThanOrEqual(2);
      
      const helperImport = references.find((r) => r.toSymbolName === "helper");
      expect(helperImport).toBeDefined();
      expect(helperImport?.refType).toBe("import");
      
      const osImport = references.find((r) => r.toSymbolName === "os");
      expect(osImport).toBeDefined();
      expect(osImport?.refType).toBe("import");
    });

    it("should extract function calls", async () => {
      const code = `
def main():
    helper()
    print("done")
      `;

      const references = await extractReferencesTreeSitter(code, "python");

      const helperCall = references.find((r) => r.toSymbolName === "helper");
      expect(helperCall).toBeDefined();
      expect(helperCall?.refType).toBe("call");
      
      const printCall = references.find((r) => r.toSymbolName === "print");
      expect(printCall).toBeDefined();
      expect(printCall?.refType).toBe("call");
    });
  });

  describe("unsupported languages", () => {
    it("should return empty arrays for unsupported languages", async () => {
      const code = "some code";
      
      const symbols = await extractSymbolsTreeSitter(code, "cobol");
      expect(symbols).toEqual([]);
      
      const references = await extractReferencesTreeSitter(code, "cobol");
      expect(references).toEqual([]);
    });
  });
});
