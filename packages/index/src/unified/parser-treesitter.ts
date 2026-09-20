/**
 * Tree-sitter WASM 解析器 - 高性能、多语言支持
 * 
 * 基于 web-tree-sitter 和 tree-sitter-wasms
 * 支持 35+ 编程语言的准确语法解析
 * 
 * @module parser-treesitter
 */

import Parser from "web-tree-sitter";
import type { ExtractedSymbol, ExtractedReference } from "./parser.js";

/**
 * Tree-sitter 语言映射表
 * 
 * 格式: { 文件扩展名/语言标识: wasm文件名 }
 */
const LANGUAGE_MAP: Record<string, string> = {
  // Web & JavaScript生态
  javascript: "tree-sitter-javascript",
  js: "tree-sitter-javascript",
  typescript: "tree-sitter-typescript",
  ts: "tree-sitter-typescript",
  tsx: "tree-sitter-tsx",
  jsx: "tree-sitter-javascript", // JSX 使用 JavaScript 解析器

  // 系统编程
  c: "tree-sitter-c",
  cpp: "tree-sitter-cpp",
  cc: "tree-sitter-cpp",
  cxx: "tree-sitter-cpp",
  h: "tree-sitter-cpp",
  hpp: "tree-sitter-cpp",
  rust: "tree-sitter-rust",
  rs: "tree-sitter-rust",
  go: "tree-sitter-go",
  zig: "tree-sitter-zig",
  swift: "tree-sitter-swift",

  // 虚拟机语言
  java: "tree-sitter-java",
  kotlin: "tree-sitter-kotlin",
  kt: "tree-sitter-kotlin",
  scala: "tree-sitter-scala",

  // 脚本语言
  python: "tree-sitter-python",
  py: "tree-sitter-python",
  ruby: "tree-sitter-ruby",
  rb: "tree-sitter-ruby",
  php: "tree-sitter-php",
  lua: "tree-sitter-lua",
  dart: "tree-sitter-dart",

  // 函数式语言
  elixir: "tree-sitter-elixir",
  ex: "tree-sitter-elixir",
  exs: "tree-sitter-elixir",
  elm: "tree-sitter-elm",
  ocaml: "tree-sitter-ocaml",
  ml: "tree-sitter-ocaml",
  rescript: "tree-sitter-rescript",
  res: "tree-sitter-rescript",
  elisp: "tree-sitter-elisp",
  el: "tree-sitter-elisp",

  // .NET 生态
  csharp: "tree-sitter-c_sharp",
  cs: "tree-sitter-c_sharp",

  // 前端样式
  css: "tree-sitter-css",
  html: "tree-sitter-html",
  vue: "tree-sitter-vue",

  // 数据格式
  json: "tree-sitter-json",
  yaml: "tree-sitter-yaml",
  yml: "tree-sitter-yaml",
  toml: "tree-sitter-toml",

  // 其他
  bash: "tree-sitter-bash",
  sh: "tree-sitter-bash",
  objc: "tree-sitter-objc",
  m: "tree-sitter-objc",
  solidity: "tree-sitter-solidity",
  sol: "tree-sitter-solidity",
  ql: "tree-sitter-ql",
};

/**
 * 已加载的语言解析器缓存
 */
const languageCache = new Map<string, Parser.Language>();

/**
 * Parser 实例缓存
 */
let parserInstance: Parser | null = null;

/**
 * 初始化 Tree-sitter 解析器
 * 
 * 必须在首次调用解析函数前调用
 * 
 * @returns Promise<void>
 * 
 * @example
 * ```typescript
 * await initTreeSitter();
 * const symbols = await extractSymbolsTreeSitter(code, "typescript");
 * ```
 */
export async function initTreeSitter(): Promise<void> {
  if (parserInstance) return;

  const isNode = typeof process !== "undefined" && process.versions?.node;

  if (isNode) {
    // Node.js 环境：定位 tree-sitter.wasm 文件
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const { existsSync, readdirSync } = await import("node:fs");

    const currentFile = fileURLToPath(import.meta.url);
    
    // 查找 tree-sitter.wasm 的函数
    const findWasmPath = (): string | undefined => {
      let dir = dirname(currentFile);
      
      for (let i = 0; i < 10; i++) {
        // 检查 node_modules/web-tree-sitter/tree-sitter.wasm
        const directPath = join(dir, "node_modules", "web-tree-sitter", "tree-sitter.wasm");
        if (existsSync(directPath)) return directPath;
        
        // 检查 pnpm 的 .pnpm 目录
        const pnpmDir = join(dir, "node_modules", ".pnpm");
        if (existsSync(pnpmDir)) {
          try {
            const entries = readdirSync(pnpmDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory() && entry.name.startsWith("web-tree-sitter@")) {
                const wasmPath = join(pnpmDir, entry.name, "node_modules", "web-tree-sitter", "tree-sitter.wasm");
                if (existsSync(wasmPath)) return wasmPath;
              }
            }
          } catch {
            // ignore
          }
        }
        
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      
      return undefined;
    };

    const wasmPath = findWasmPath();
    
    if (wasmPath) {
      await Parser.init({
        locateFile: () => wasmPath
      });
    } else {
      // 回退到默认行为（可能会失败）
      await Parser.init();
    }
  } else {
    // 浏览器环境
    await Parser.init();
  }

  parserInstance = new Parser();
}

/**
 * 加载指定语言的解析器
 * 
 * @param language - 语言标识或文件扩展名
 * @returns Promise<Parser.Language | null> - 解析器语言对象，不支持时返回 null
 * 
 * @internal
 */
async function loadLanguage(language: string): Promise<Parser.Language | null> {
  const normalized = language.toLowerCase();
  const wasmName = LANGUAGE_MAP[normalized];

  if (!wasmName) {
    return null; // 不支持的语言
  }

  // 从缓存获取
  if (languageCache.has(wasmName)) {
    return languageCache.get(wasmName)!;
  }

  try {
    // 尝试从文件系统加载 WASM
    // Node.js 环境: 直接读取文件
    // 浏览器环境: 通过 fetch
    const isNode = typeof process !== "undefined" && process.versions?.node;
    
    if (isNode) {
      // Node.js 环境
      const { existsSync, readFileSync, readdirSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      const { dirname, join } = await import("node:path");
      
      const currentFile = fileURLToPath(import.meta.url);
      const findLanguageWasm = (): string | undefined => {
        let dir = dirname(currentFile);
        for (let i = 0; i < 12; i++) {
          const directPath = join(
            dir,
            "node_modules",
            "tree-sitter-wasms",
            "out",
            `${wasmName}.wasm`,
          );
          if (existsSync(directPath)) return directPath;

          const pnpmDir = join(dir, "node_modules", ".pnpm");
          if (existsSync(pnpmDir)) {
            try {
              for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
                if (!entry.isDirectory() || !entry.name.startsWith("tree-sitter-wasms@")) {
                  continue;
                }
                const pnpmPath = join(
                  pnpmDir,
                  entry.name,
                  "node_modules",
                  "tree-sitter-wasms",
                  "out",
                  `${wasmName}.wasm`,
                );
                if (existsSync(pnpmPath)) return pnpmPath;
              }
            } catch {
              // Continue searching parent directories.
            }
          }

          const parent = dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        return undefined;
      };

      const wasmPath = findLanguageWasm();
      if (!wasmPath) return null;
      const wasmBuffer = readFileSync(wasmPath);
      const lang = await Parser.Language.load(new Uint8Array(wasmBuffer));
      languageCache.set(wasmName, lang);
      return lang;
    } else {
      // 浏览器环境 - 使用 fetch
      const wasmUrl = `/node_modules/tree-sitter-wasms/out/${wasmName}.wasm`;
      const response = await fetch(wasmUrl);
      const wasmBuffer = await response.arrayBuffer();
      const lang = await Parser.Language.load(new Uint8Array(wasmBuffer));
      languageCache.set(wasmName, lang);
      return lang;
    }
  } catch (error) {
    console.warn(`Failed to load tree-sitter language: ${wasmName}`, error);
    return null;
  }
}

/**
 * 使用 Tree-sitter 提取符号定义
 * 
 * @param content - 源代码内容
 * @param language - 编程语言标识
 * @returns Promise<ExtractedSymbol[]> - 提取到的符号数组
 * 
 * @example
 * ```typescript
 * await initTreeSitter();
 * const code = `
 *   export function hello(name: string): string {
 *     return \`Hello, \${name}\`;
 *   }
 * `;
 * 
 * const symbols = await extractSymbolsTreeSitter(code, "typescript");
 * // [{ name: "hello", kind: "function", exported: true, ... }]
 * ```
 */
export async function extractSymbolsTreeSitter(
  content: string,
  language: string
): Promise<ExtractedSymbol[]> {
  if (!parserInstance) {
    throw new Error("Tree-sitter not initialized. Call initTreeSitter() first.");
  }

  const lang = await loadLanguage(language);
  if (!lang) {
    return []; // 不支持的语言，返回空数组
  }

  parserInstance.setLanguage(lang);
  const tree = parserInstance.parse(content);

  const symbols: ExtractedSymbol[] = [];
  const cursor = tree.walk();

  // 根据语言选择不同的遍历策略
  const extractor = getSymbolExtractor(language);
  extractor(cursor, symbols, content);

  return symbols;
}

/**
 * 使用 Tree-sitter 提取引用关系
 * 
 * @param content - 源代码内容
 * @param language - 编程语言标识
 * @returns Promise<ExtractedReference[]> - 提取到的引用数组
 */
export async function extractReferencesTreeSitter(
  content: string,
  language: string
): Promise<ExtractedReference[]> {
  if (!parserInstance) {
    throw new Error("Tree-sitter not initialized. Call initTreeSitter() first.");
  }

  const lang = await loadLanguage(language);
  if (!lang) {
    return [];
  }

  parserInstance.setLanguage(lang);
  const tree = parserInstance.parse(content);

  const references: ExtractedReference[] = [];
  const cursor = tree.walk();

  const extractor = getReferenceExtractor(language);
  extractor(cursor, references, content);

  return references;
}

// ========== 符号提取器策略 ==========

type SymbolExtractor = (
  cursor: Parser.TreeCursor,
  symbols: ExtractedSymbol[],
  _content: string
) => void;

function getSymbolExtractor(language: string): SymbolExtractor {
  const normalized = language.toLowerCase();

  // TypeScript/JavaScript 系列
  if (["typescript", "ts", "tsx", "javascript", "js", "jsx"].includes(normalized)) {
    return extractTSSymbolsFromTree;
  }

  // Python
  if (["python", "py"].includes(normalized)) {
    return extractPythonSymbolsFromTree;
  }

  // Rust
  if (["rust", "rs"].includes(normalized)) {
    return extractRustSymbolsFromTree;
  }

  // Go
  if (["go"].includes(normalized)) {
    return extractGoSymbolsFromTree;
  }

  // Java/Kotlin/Scala
  if (["java", "kotlin", "kt", "scala"].includes(normalized)) {
    return extractJVMSymbolsFromTree;
  }

  // C/C++
  if (["c", "cpp", "cc", "cxx", "h", "hpp"].includes(normalized)) {
    return extractCppSymbolsFromTree;
  }

  // 默认通用提取器
  return extractGenericSymbolsFromTree;
}

// ========== TypeScript/JavaScript 符号提取 ==========

function extractTSSymbolsFromTree(
  cursor: Parser.TreeCursor,
  symbols: ExtractedSymbol[],
  _content: string
): void {
  const traverse = (cursor: Parser.TreeCursor) => {
    const node = cursor.currentNode;
    const nodeType = node.type;

    // 函数声明
    if (
      nodeType === "function_declaration" ||
      nodeType === "function_signature" ||
      nodeType === "method_definition"
    ) {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isExported = node.parent?.type === "export_statement";
        symbols.push({
          name: nameNode.text,
          kind: nodeType === "method_definition" ? "method" : "function",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isExported,
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    // 箭头函数 (const foo = () => {})
    if (nodeType === "lexical_declaration" || nodeType === "variable_declaration") {
      const declarator = node.child(1);
      if (declarator?.type === "variable_declarator") {
        const nameNode = declarator.childForFieldName("name");
        const valueNode = declarator.childForFieldName("value");

        if (
          nameNode &&
          valueNode &&
          (valueNode.type === "arrow_function" || valueNode.type === "function")
        ) {
          const isExported = node.parent?.type === "export_statement";
          symbols.push({
            name: nameNode.text,
            kind: "function",
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            exported: isExported,
            signature: node.text.split("\n")[0].trim(),
          });
        }
      }
    }

    // 类声明
    if (nodeType === "class_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isExported = node.parent?.type === "export_statement";
        symbols.push({
          name: nameNode.text,
          kind: "class",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isExported,
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    // 接口声明
    if (nodeType === "interface_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isExported = node.parent?.type === "export_statement";
        symbols.push({
          name: nameNode.text,
          kind: "interface",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isExported,
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    // 类型别名
    if (nodeType === "type_alias_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isExported = node.parent?.type === "export_statement";
        symbols.push({
          name: nameNode.text,
          kind: "type",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isExported,
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    // 枚举
    if (nodeType === "enum_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isExported = node.parent?.type === "export_statement";
        symbols.push({
          name: nameNode.text,
          kind: "enum",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isExported,
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    // 递归遍历子节点
    if (cursor.gotoFirstChild()) {
      do {
        traverse(cursor);
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };

  traverse(cursor);
}

// ========== Python 符号提取 ==========

function extractPythonSymbolsFromTree(
  cursor: Parser.TreeCursor,
  symbols: ExtractedSymbol[],
  _content: string
): void {
  const traverse = (cursor: Parser.TreeCursor) => {
    const node = cursor.currentNode;
    const nodeType = node.type;

    // 函数定义
    if (nodeType === "function_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const name = nameNode.text;
        symbols.push({
          name,
          kind: "function",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: !name.startsWith("_"),
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    // 类定义
    if (nodeType === "class_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const name = nameNode.text;
        symbols.push({
          name,
          kind: "class",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: !name.startsWith("_"),
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    if (cursor.gotoFirstChild()) {
      do {
        traverse(cursor);
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };

  traverse(cursor);
}

// ========== Rust 符号提取 ==========

function extractRustSymbolsFromTree(
  cursor: Parser.TreeCursor,
  symbols: ExtractedSymbol[],
  _content: string
): void {
  const traverse = (cursor: Parser.TreeCursor) => {
    const node = cursor.currentNode;
    const nodeType = node.type;

    // 函数定义
    if (nodeType === "function_item") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isPublic = node.text.startsWith("pub ");
        symbols.push({
          name: nameNode.text,
          kind: "function",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isPublic,
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    // 结构体
    if (nodeType === "struct_item") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isPublic = node.text.startsWith("pub ");
        symbols.push({
          name: nameNode.text,
          kind: "class",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isPublic,
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    // Trait
    if (nodeType === "trait_item") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isPublic = node.text.startsWith("pub ");
        symbols.push({
          name: nameNode.text,
          kind: "interface",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isPublic,
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    if (cursor.gotoFirstChild()) {
      do {
        traverse(cursor);
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };

  traverse(cursor);
}

// ========== Go 符号提取 ==========

function extractGoSymbolsFromTree(
  cursor: Parser.TreeCursor,
  symbols: ExtractedSymbol[],
  _content: string
): void {
  const traverse = (cursor: Parser.TreeCursor) => {
    const node = cursor.currentNode;
    const nodeType = node.type;

    // 函数声明
    if (nodeType === "function_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const name = nameNode.text;
        symbols.push({
          name,
          kind: "function",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: name[0] === name[0].toUpperCase(),
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    // 类型定义
    if (nodeType === "type_declaration") {
      const specNode = node.child(1);
      if (specNode?.type === "type_spec") {
        const nameNode = specNode.childForFieldName("name");
        const typeNode = specNode.childForFieldName("type");

        if (nameNode && typeNode) {
          const name = nameNode.text;
          const kind = typeNode.type === "struct_type" ? "class" : "type";

          symbols.push({
            name,
            kind,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            exported: name[0] === name[0].toUpperCase(),
            signature: node.text.split("\n")[0].trim(),
          });
        }
      }
    }

    if (cursor.gotoFirstChild()) {
      do {
        traverse(cursor);
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };

  traverse(cursor);
}

// ========== JVM 语言符号提取 (Java/Kotlin/Scala) ==========

function extractJVMSymbolsFromTree(
  cursor: Parser.TreeCursor,
  symbols: ExtractedSymbol[],
  _content: string
): void {
  const traverse = (cursor: Parser.TreeCursor) => {
    const node = cursor.currentNode;
    const nodeType = node.type;

    // 方法声明
    if (nodeType === "method_declaration" || nodeType === "function_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isPublic = node.text.includes("public ");
        symbols.push({
          name: nameNode.text,
          kind: "function",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isPublic,
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    // 类声明
    if (nodeType === "class_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isPublic = node.text.includes("public ");
        symbols.push({
          name: nameNode.text,
          kind: "class",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isPublic,
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    // 接口声明
    if (nodeType === "interface_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isPublic = node.text.includes("public ");
        symbols.push({
          name: nameNode.text,
          kind: "interface",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isPublic,
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    if (cursor.gotoFirstChild()) {
      do {
        traverse(cursor);
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };

  traverse(cursor);
}

// ========== C/C++ 符号提取 ==========

function extractCppSymbolsFromTree(
  cursor: Parser.TreeCursor,
  symbols: ExtractedSymbol[],
  _content: string
): void {
  const traverse = (cursor: Parser.TreeCursor) => {
    const node = cursor.currentNode;
    const nodeType = node.type;

    // 函数定义
    if (nodeType === "function_definition" || nodeType === "function_declarator") {
      const declaratorNode =
        nodeType === "function_definition"
          ? node.childForFieldName("declarator")
          : node;

      if (declaratorNode) {
        const nameNode = declaratorNode.childForFieldName("declarator");
        const actualName =
          nameNode?.type === "identifier" ? nameNode : nameNode?.childForFieldName("declarator");

        if (actualName) {
          symbols.push({
            name: actualName.text,
            kind: "function",
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            exported: true, // C/C++ 导出规则复杂，简化处理
            signature: node.text.split("\n")[0].trim(),
          });
        }
      }
    }

    // 类/结构体
    if (nodeType === "class_specifier" || nodeType === "struct_specifier") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          kind: "class",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: true,
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    if (cursor.gotoFirstChild()) {
      do {
        traverse(cursor);
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };

  traverse(cursor);
}

// ========== 通用符号提取器 ==========

function extractGenericSymbolsFromTree(
  cursor: Parser.TreeCursor,
  symbols: ExtractedSymbol[],
  _content: string
): void {
  const traverse = (cursor: Parser.TreeCursor) => {
    const node = cursor.currentNode;
    const nodeType = node.type;

    // 通用模式匹配
    if (
      nodeType.includes("function") ||
      nodeType.includes("method") ||
      nodeType.includes("class") ||
      nodeType.includes("interface") ||
      nodeType.includes("struct")
    ) {
      const nameNode =
        node.childForFieldName("name") || node.childForFieldName("declarator");

      if (nameNode) {
        let kind = "function";
        if (nodeType.includes("class") || nodeType.includes("struct")) {
          kind = "class";
        } else if (nodeType.includes("interface")) {
          kind = "interface";
        }

        symbols.push({
          name: nameNode.text,
          kind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: true,
          signature: node.text.split("\n")[0].trim(),
        });
      }
    }

    if (cursor.gotoFirstChild()) {
      do {
        traverse(cursor);
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };

  traverse(cursor);
}

// ========== 引用提取器策略 ==========

type ReferenceExtractor = (
  cursor: Parser.TreeCursor,
  references: ExtractedReference[],
  _content: string
) => void;

function getReferenceExtractor(language: string): ReferenceExtractor {
  const normalized = language.toLowerCase();

  if (["typescript", "ts", "tsx", "javascript", "js", "jsx"].includes(normalized)) {
    return extractTSReferencesFromTree;
  }

  if (["python", "py"].includes(normalized)) {
    return extractPythonReferencesFromTree;
  }

  return extractGenericReferencesFromTree;
}

function extractTSReferencesFromTree(
  cursor: Parser.TreeCursor,
  references: ExtractedReference[],
  _content: string
): void {
  const traverse = (cursor: Parser.TreeCursor) => {
    const node = cursor.currentNode;
    const nodeType = node.type;

    // Import 语句
    if (nodeType === "import_statement") {
      const sourceNode = node.childForFieldName("source");
      const importPath = sourceNode?.text.replace(/['"]/g, "");

      const clauseNode = node.child(1);
      if (clauseNode?.type === "import_clause") {
        // Named imports: import { A, B } from './module'
        const namedImports = clauseNode.descendantsOfType("import_specifier");
        for (const specifier of namedImports) {
          const nameNode = specifier.childForFieldName("name");
          if (nameNode) {
            references.push({
              fromSymbolName: "module",
              toSymbolName: nameNode.text,
              importPath,
              refType: "import",
              line: node.startPosition.row + 1,
            });
          }
        }

        // Default import: import A from './module'
        const defaultImport = clauseNode.child(0);
        if (defaultImport?.type === "identifier") {
          references.push({
            fromSymbolName: "module",
            toSymbolName: defaultImport.text,
            importPath,
            refType: "import",
            line: node.startPosition.row + 1,
          });
        }
      }
    }

    // 函数调用
    if (nodeType === "call_expression") {
      const functionNode = node.childForFieldName("function");
      if (functionNode) {
        let calledName = "";

        // 直接调用: foo()
        if (functionNode.type === "identifier") {
          calledName = functionNode.text;
        }
        // 方法调用: obj.method()
        else if (functionNode.type === "member_expression") {
          const propertyNode = functionNode.childForFieldName("property");
          if (propertyNode) {
            calledName = propertyNode.text;
          }
        }

        if (calledName) {
          references.push({
            fromSymbolName: "",
            toSymbolName: calledName,
            refType: "call",
            line: node.startPosition.row + 1,
          });
        }
      }
    }

    if (cursor.gotoFirstChild()) {
      do {
        traverse(cursor);
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };

  traverse(cursor);
}

function extractPythonReferencesFromTree(
  cursor: Parser.TreeCursor,
  references: ExtractedReference[],
  _content: string
): void {
  const traverse = (cursor: Parser.TreeCursor) => {
    const node = cursor.currentNode;
    const nodeType = node.type;

    // Import 语句
    if (nodeType === "import_statement" || nodeType === "import_from_statement") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        references.push({
          fromSymbolName: "module",
          toSymbolName: nameNode.text,
          refType: "import",
          line: node.startPosition.row + 1,
        });
      }
    }

    // 函数调用
    if (nodeType === "call") {
      const functionNode = node.childForFieldName("function");
      if (functionNode) {
        let calledName = "";

        if (functionNode.type === "identifier") {
          calledName = functionNode.text;
        } else if (functionNode.type === "attribute") {
          const attrNode = functionNode.childForFieldName("attribute");
          if (attrNode) {
            calledName = attrNode.text;
          }
        }

        if (calledName) {
          references.push({
            fromSymbolName: "",
            toSymbolName: calledName,
            refType: "call",
            line: node.startPosition.row + 1,
          });
        }
      }
    }

    if (cursor.gotoFirstChild()) {
      do {
        traverse(cursor);
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };

  traverse(cursor);
}

function extractGenericReferencesFromTree(
  cursor: Parser.TreeCursor,
  references: ExtractedReference[],
  _content: string
): void {
  // 通用引用提取逻辑（简化版）
  const traverse = (cursor: Parser.TreeCursor) => {
    const node = cursor.currentNode;
    const nodeType = node.type;

    if (nodeType.includes("call")) {
      const nameNode = node.childForFieldName("function") || node.child(0);
      if (nameNode && nameNode.type === "identifier") {
        references.push({
          fromSymbolName: "",
          toSymbolName: nameNode.text,
          refType: "call",
          line: node.startPosition.row + 1,
        });
      }
    }

    if (cursor.gotoFirstChild()) {
      do {
        traverse(cursor);
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };

  traverse(cursor);
}

/**
 * 检查语言是否受支持
 * 
 * @param language - 语言标识或文件扩展名
 * @returns boolean - 是否支持
 * 
 * @example
 * ```typescript
 * isLanguageSupported("typescript") // true
 * isLanguageSupported("cobol") // false
 * ```
 */
export function isLanguageSupported(language: string): boolean {
  return language.toLowerCase() in LANGUAGE_MAP;
}

/**
 * 获取所有支持的语言列表
 * 
 * @returns string[] - 支持的语言标识数组
 */
export function getSupportedLanguages(): string[] {
  return Object.keys(LANGUAGE_MAP);
}
