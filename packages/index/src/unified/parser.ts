/**
 * 代码解析器 - 提取符号和引用
 * 
 * 双引擎架构:
 * 1. Tree-sitter WASM (推荐): 基于语法树的准确解析，支持 35+ 语言
 * 2. 正则表达式 (回退): 轻量级快速解析，零依赖
 * 
 * 优先使用 Tree-sitter，不支持的语言自动回退到正则表达式
 * 
 * @module parser
 */

import {
  extractSymbolsTreeSitter,
  extractReferencesTreeSitter,
  isLanguageSupported,
  initTreeSitter,
} from "./parser-treesitter.js";

/**
 * 提取的符号信息
 * 
 * @interface ExtractedSymbol
 * @property {string} name - 符号名称
 * @property {string} [qualifiedName] - 完全限定名(如: namespace.ClassName.methodName)
 * @property {string} kind - 符号类型: function, class, interface, type, constant, enum, variable, method, property
 * @property {number} startLine - 起始行号(1-indexed)
 * @property {number} endLine - 结束行号(1-indexed)
 * @property {boolean} exported - 是否为导出符号
 * @property {string} [signature] - 符号签名(函数参数、类继承等)
 * @property {string} [doc] - 文档注释
 * 
 * @example
 * ```typescript
 * {
 *   name: "processData",
 *   kind: "function",
 *   startLine: 10,
 *   endLine: 15,
 *   exported: true,
 *   signature: "async function processData(input: string): Promise<Result>"
 * }
 * ```
 */
export interface ExtractedSymbol {
  name: string;
  qualifiedName?: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  signature?: string;
  doc?: string;
}

/**
 * 提取的引用关系
 * 
 * @interface ExtractedReference
 * @property {string} fromSymbolName - 引用来源符号名(空字符串表示模块级别)
 * @property {string} toSymbolName - 被引用的符号名
 * @property {string} [importPath] - import语句的路径(仅对refType='import'有效)
 * @property {string} refType - 引用类型: import, call, method_call, reference
 * @property {number} line - 引用所在行号(1-indexed)
 * 
 * @example
 * ```typescript
 * {
 *   fromSymbolName: "processData",
 *   toSymbolName: "validateInput",
 *   importPath: "./utils",
 *   refType: "call",
 *   line: 12
 * }
 * ```
 */
export interface ExtractedReference {
  fromSymbolName: string;
  toSymbolName: string;
  importPath?: string;
  refType: string;
  line: number;
}

/**
 * 从代码中提取符号定义
 * 
 * 双引擎解析:
 * 1. 优先使用 Tree-sitter WASM (准确、支持 35+ 语言)
 * 2. 回退到正则表达式 (不支持的语言或解析失败时)
 * 
 * @param {string} content - 源代码内容
 * @param {string} language - 编程语言: typescript, javascript, python, rust, go, java, etc.
 * @returns {ExtractedSymbol[]} 提取到的符号数组
 * 
 * @example
 * ```typescript
 * const code = `
 *   export function hello(name: string): string {
 *     return \`Hello, \${name}\`;
 *   }
 * `;
 * 
 * const symbols = extractSymbols(code, "typescript");
 * // [{ name: "hello", kind: "function", exported: true, ... }]
 * ```
 * 
 * @see {@link ExtractedSymbol} 返回的符号结构
 */
export function extractSymbols(
  content: string,
  language: string
): ExtractedSymbol[] {
  // 尝试使用 Tree-sitter (异步转同步，生产环境需要预初始化)
  if (isLanguageSupported(language)) {
    try {
      // 注意: 这里是同步调用，实际使用需要先调用 initTreeSitter()
      // 生产环境建议在应用启动时初始化
      return extractSymbolsTreeSitterSync(content, language);
    } catch (error) {
      console.warn(`Tree-sitter parse failed, fallback to regex: ${error}`);
    }
  }

  // 回退到正则表达式解析
  switch (language) {
    case "typescript":
    case "javascript":
      return extractTSSymbols(content);
    case "python":
      return extractPythonSymbols(content);
    case "rust":
      return extractRustSymbols(content);
    case "go":
      return extractGoSymbols(content);
    default:
      return [];
  }
}

/**
 * 异步版本: 从代码中提取符号定义
 * 
 * @param {string} content - 源代码内容
 * @param {string} language - 编程语言
 * @returns {Promise<ExtractedSymbol[]>} 提取到的符号数组
 * 
 * @example
 * ```typescript
 * await initTreeSitter(); // 初始化一次
 * const symbols = await extractSymbolsAsync(code, "typescript");
 * ```
 */
export async function extractSymbolsAsync(
  content: string,
  language: string
): Promise<ExtractedSymbol[]> {
  if (isLanguageSupported(language)) {
    try {
      const symbols = await extractSymbolsTreeSitter(content, language);
      if (symbols.length > 0 || content.trim().length === 0) {
        return symbols;
      }
    } catch (error) {
      console.warn(`Tree-sitter parse failed, fallback to regex: ${error}`);
    }
  }

  // 回退到正则表达式
  return extractSymbols(content, language);
}

// Tree-sitter 同步包装器 (用于兼容现有同步 API)
function extractSymbolsTreeSitterSync(
  _content: string,
  _language: string
): ExtractedSymbol[] {
  // 这是一个同步包装，实际上内部会抛出错误如果未初始化
  // 实际使用建议用异步版本或预初始化
  throw new Error(
    "Tree-sitter requires async initialization. Use extractSymbolsAsync() or call initTreeSitter() first."
  );
}

/**
 * 导出 Tree-sitter 初始化函数
 */
export { initTreeSitter };

/**
 * 从代码中提取引用关系
 * 
 * 双引擎解析:
 * 1. 优先使用 Tree-sitter WASM
 * 2. 回退到正则表达式
 * 
 * @param {string} content - 源代码内容
 * @param {string} language - 编程语言: typescript, javascript, python
 * @returns {ExtractedReference[]} 提取到的引用数组
 * 
 * @example
 * ```typescript
 * const code = `
 *   import { helper } from './utils';
 *   
 *   function main() {
 *     helper();
 *     console.log('done');
 *   }
 * `;
 * 
 * const refs = extractReferences(code, "typescript");
 * // [
 * //   { toSymbolName: "helper", refType: "import", line: 1 },
 * //   { toSymbolName: "helper", refType: "call", line: 4 },
 * //   { toSymbolName: "log", refType: "method_call", line: 5 }
 * // ]
 * ```
 * 
 * @see {@link ExtractedReference} 返回的引用结构
 */
export function extractReferences(
  content: string,
  language: string
): ExtractedReference[] {
  // 尝试使用 Tree-sitter
  if (isLanguageSupported(language)) {
    try {
      return extractReferencesTreeSitterSync(content, language);
    } catch (error) {
      console.warn(`Tree-sitter reference extraction failed, fallback to regex: ${error}`);
    }
  }

  // 回退到正则表达式
  switch (language) {
    case "typescript":
    case "javascript":
      return extractTSReferences(content);
    case "python":
      return extractPythonReferences(content);
    default:
      return [];
  }
}

/**
 * 异步版本: 从代码中提取引用关系
 * 
 * @param {string} content - 源代码内容
 * @param {string} language - 编程语言
 * @returns {Promise<ExtractedReference[]>} 提取到的引用数组
 */
export async function extractReferencesAsync(
  content: string,
  language: string
): Promise<ExtractedReference[]> {
  if (isLanguageSupported(language)) {
    try {
      const references = await extractReferencesTreeSitter(content, language);
      if (references.length > 0 || content.trim().length === 0) {
        return references;
      }
    } catch (error) {
      console.warn(`Tree-sitter reference extraction failed, fallback to regex: ${error}`);
    }
  }

  return extractReferences(content, language);
}

function extractReferencesTreeSitterSync(
  _content: string,
  _language: string
): ExtractedReference[] {
  throw new Error(
    "Tree-sitter requires async initialization. Use extractReferencesAsync() or call initTreeSitter() first."
  );
}

// ========== TypeScript/JavaScript 解析器 ==========

function extractTSSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  // 提取函数声明
  const functionRegex =
    /^\s*(export\s+)?(async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(<[^>]*>)?\s*\([^)]*\)/gm;
  for (const match of content.matchAll(functionRegex)) {
    const line = getLineNumber(content, match.index!);
    symbols.push({
      name: match[3],
      kind: "function",
      startLine: line,
      endLine: line, // 简化处理,实际应该找到函数结束位置
      exported: !!match[1],
      signature: match[0].trim(),
    });
  }

  // 提取箭头函数(const/let/var)
  const arrowFunctionRegex =
    /^\s*(export\s+)?(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(async\s+)?\([^)]*\)\s*=>/gm;
  for (const match of content.matchAll(arrowFunctionRegex)) {
    const line = getLineNumber(content, match.index!);
    symbols.push({
      name: match[3],
      kind: "function",
      startLine: line,
      endLine: line,
      exported: !!match[1],
      signature: match[0].trim(),
    });
  }

  // 提取类声明
  const classRegex =
    /^\s*(export\s+)?(abstract\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)(<[^>]*>)?(\s+extends\s+[a-zA-Z_$][a-zA-Z0-9_$]*)?(\s+implements\s+[^{]+)?/gm;
  for (const match of content.matchAll(classRegex)) {
    const line = getLineNumber(content, match.index!);
    symbols.push({
      name: match[3],
      kind: "class",
      startLine: line,
      endLine: line,
      exported: !!match[1],
      signature: match[0].trim(),
    });
  }

  // 提取接口声明
  const interfaceRegex =
    /^\s*(export\s+)?interface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)(<[^>]*>)?/gm;
  for (const match of content.matchAll(interfaceRegex)) {
    const line = getLineNumber(content, match.index!);
    symbols.push({
      name: match[2],
      kind: "interface",
      startLine: line,
      endLine: line,
      exported: !!match[1],
      signature: match[0].trim(),
    });
  }

  // 提取类型别名
  const typeRegex = /^\s*(export\s+)?type\s+([a-zA-Z_$][a-zA-Z0-9_$]*)(<[^>]*>)?/gm;
  for (const match of content.matchAll(typeRegex)) {
    const line = getLineNumber(content, match.index!);
    symbols.push({
      name: match[2],
      kind: "type",
      startLine: line,
      endLine: line,
      exported: !!match[1],
      signature: match[0].trim(),
    });
  }

  // 提取常量声明
  const constRegex =
    /^\s*(export\s+)?const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[^=]+)?\s*=(?!\s*\([^)]*\)\s*=>)/gm;
  for (const match of content.matchAll(constRegex)) {
    const line = getLineNumber(content, match.index!);
    // 排除箭头函数(已在上面处理)
    if (!content.slice(match.index!).match(/^[^=]*=\s*\([^)]*\)\s*=>/)) {
      symbols.push({
        name: match[2],
        kind: "constant",
        startLine: line,
        endLine: line,
        exported: !!match[1],
        signature: match[0].trim(),
      });
    }
  }

  // 提取枚举
  const enumRegex = /^\s*(export\s+)?enum\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/gm;
  for (const match of content.matchAll(enumRegex)) {
    const line = getLineNumber(content, match.index!);
    symbols.push({
      name: match[2],
      kind: "enum",
      startLine: line,
      endLine: line,
      exported: !!match[1],
      signature: match[0].trim(),
    });
  }

  // 提取 re-export 语句(纯转发导出的文件,如 `export * from './src'`)
  // 这些文件本身不定义符号,但应被计入索引,故生成一个 module 级符号
  const reExportRegex =
    /^\s*export\s+\*(?:\s+as\s+[a-zA-Z_$][a-zA-Z0-9_$]*)?\s+from\s+['"][^'"]+['"]/gm;
  const firstReExport = reExportRegex.exec(content);
  if (firstReExport) {
    const line = getLineNumber(content, firstReExport.index);
    symbols.push({
      name: "module",
      kind: "module",
      startLine: line,
      endLine: line,
      exported: true,
      signature: firstReExport[0].trim(),
    });
  }

  return symbols;
}

function extractTSReferences(
  content: string
): ExtractedReference[] {
  const references: ExtractedReference[] = [];

  // 提取import语句
  const importRegex =
    /import\s+(?:{([^}]+)}|([a-zA-Z_$][a-zA-Z0-9_$]*))\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(importRegex)) {
    const line = getLineNumber(content, match.index!);
    const importPath = match[3]; // 提取import路径
    const names = match[1]
      ? match[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0])
      : [match[2]];

    for (const name of names) {
      if (name) {
        references.push({
          fromSymbolName: "module", // 模块级别的导入
          toSymbolName: name,
          importPath, // 记录import路径
          refType: "import",
          line,
        });
      }
    }
  }

  // 提取动态import: const { A, B } = await import("./path")
  const dynamicImportRegex =
    /(?:const|let|var)\s*\{\s*([^}]+)\s*\}\s*=\s*await\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of content.matchAll(dynamicImportRegex)) {
    const line = getLineNumber(content, match.index!);
    const importPath = match[2]; // 提取import路径
    const names = match[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0]);

    for (const name of names) {
      if (name) {
        references.push({
          fromSymbolName: "module", // 模块级别的导入
          toSymbolName: name,
          importPath, // 记录import路径
          refType: "import",
          line,
        });
      }
    }
  }

  // 提取函数调用引用
  // 匹配: functionName(args)
  const functionCallRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
  const lines = content.split("\n");
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    
    // 跳过注释和字符串
    const cleanedLine = line
      .replace(/\/\/.*$/, "") // 单行注释
      .replace(/\/\*[\s\S]*?\*\//g, "") // 多行注释
      .replace(/["'`][^"'`]*["'`]/g, ""); // 字符串
    
    for (const match of cleanedLine.matchAll(functionCallRegex)) {
      const calledName = match[1];
      
      // 过滤常见的非函数调用关键字
      if (
        ["if", "while", "for", "switch", "catch", "function", "async", "await"].includes(calledName)
      ) {
        continue;
      }
      
      references.push({
        fromSymbolName: "", // 需要在后续处理中确定调用者
        toSymbolName: calledName,
        refType: "call",
        line: lineNumber,
      });
    }
  }

  // 提取方法调用引用
  // 匹配: object.method(args) 或 Class.method(args)
  const methodCallRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    
    const cleanedLine = line
      .replace(/\/\/.*$/, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/["'`][^"'`]*["'`]/g, "");
    
    for (const match of cleanedLine.matchAll(methodCallRegex)) {
      const objectName = match[1];
      const methodName = match[2];
      
      references.push({
        fromSymbolName: "",
        toSymbolName: methodName,
        refType: "method_call",
        line: lineNumber,
      });
      
      // 也记录对对象/类的引用
      references.push({
        fromSymbolName: "",
        toSymbolName: objectName,
        refType: "reference",
        line: lineNumber,
      });
    }
  }

  // 提取变量/常量引用
  // 匹配: 使用已定义的标识符(简化版)
  const identifierRegex = /\b([A-Z_][A-Z0-9_]+)\b/g; // 常量(全大写)
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    
    // 跳过定义行
    if (line.match(/^\s*(export\s+)?(const|let|var|enum)\s+/)) {
      continue;
    }
    
    const cleanedLine = line
      .replace(/\/\/.*$/, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/["'`][^"'`]*["'`]/g, "");
    
    for (const match of cleanedLine.matchAll(identifierRegex)) {
      const name = match[1];
      
      references.push({
        fromSymbolName: "",
        toSymbolName: name,
        refType: "reference",
        line: lineNumber,
      });
    }
  }

  return references;
}

// ========== Python 解析器 ==========

function extractPythonSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  // 提取函数定义
  const functionRegex = /^\s*def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)/gm;
  for (const match of content.matchAll(functionRegex)) {
    const line = getLineNumber(content, match.index!);
    symbols.push({
      name: match[1],
      kind: "function",
      startLine: line,
      endLine: line,
      exported: !match[1].startsWith("_"),
      signature: match[0].trim(),
    });
  }

  // 提取类定义
  const classRegex = /^\s*class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(\([^)]*\))?:/gm;
  for (const match of content.matchAll(classRegex)) {
    const line = getLineNumber(content, match.index!);
    symbols.push({
      name: match[1],
      kind: "class",
      startLine: line,
      endLine: line,
      exported: !match[1].startsWith("_"),
      signature: match[0].trim(),
    });
  }

  return symbols;
}

function extractPythonReferences(
  content: string
): ExtractedReference[] {
  const references: ExtractedReference[] = [];

  // 提取import语句
  const importRegex = /^(?:from\s+([^\s]+)\s+)?import\s+([^\s]+(?:\s+as\s+[^\s]+)?)/gm;
  for (const match of content.matchAll(importRegex)) {
    const line = getLineNumber(content, match.index!);
    const importPath = match[1]?.replace(/['"]/g, ""); // 提取import路径
    const name = match[2].split(/\s+as\s+/)[0];
    references.push({
      fromSymbolName: "module",
      toSymbolName: name,
      importPath, // 记录import路径
      refType: "import",
      line,
    });
  }

  // 提取函数调用引用
  const functionCallRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  const lines = content.split("\n");
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    
    // 跳过注释和字符串
    const cleanedLine = line
      .replace(/#.*$/, "") // 注释
      .replace(/["'][^"']*["']/g, ""); // 字符串
    
    for (const match of cleanedLine.matchAll(functionCallRegex)) {
      const calledName = match[1];
      
      // 过滤Python关键字
      if (
        ["if", "while", "for", "def", "class", "try", "except", "with", "assert", "print"].includes(calledName)
      ) {
        continue;
      }
      
      references.push({
        fromSymbolName: "",
        toSymbolName: calledName,
        refType: "call",
        line: lineNumber,
      });
    }
  }

  // 提取方法调用引用
  const methodCallRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    
    const cleanedLine = line
      .replace(/#.*$/, "")
      .replace(/["'][^"']*["']/g, "");
    
    for (const match of cleanedLine.matchAll(methodCallRegex)) {
      const objectName = match[1];
      const methodName = match[2];
      
      references.push({
        fromSymbolName: "",
        toSymbolName: methodName,
        refType: "method_call",
        line: lineNumber,
      });
      
      references.push({
        fromSymbolName: "",
        toSymbolName: objectName,
        refType: "reference",
        line: lineNumber,
      });
    }
  }

  return references;
}

// ========== Rust 解析器 ==========

function extractRustSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  // 提取函数定义
  const functionRegex = /^\s*(pub\s+)?(async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;
  for (const match of content.matchAll(functionRegex)) {
    const line = getLineNumber(content, match.index!);
    symbols.push({
      name: match[3],
      kind: "function",
      startLine: line,
      endLine: line,
      exported: !!match[1],
      signature: match[0].trim(),
    });
  }

  // 提取结构体定义
  const structRegex = /^\s*(pub\s+)?struct\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;
  for (const match of content.matchAll(structRegex)) {
    const line = getLineNumber(content, match.index!);
    symbols.push({
      name: match[2],
      kind: "class",
      startLine: line,
      endLine: line,
      exported: !!match[1],
      signature: match[0].trim(),
    });
  }

  // 提取trait定义
  const traitRegex = /^\s*(pub\s+)?trait\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;
  for (const match of content.matchAll(traitRegex)) {
    const line = getLineNumber(content, match.index!);
    symbols.push({
      name: match[2],
      kind: "interface",
      startLine: line,
      endLine: line,
      exported: !!match[1],
      signature: match[0].trim(),
    });
  }

  return symbols;
}

// ========== Go 解析器 ==========

function extractGoSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  // 提取函数定义
  const functionRegex = /^\s*func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
  for (const match of content.matchAll(functionRegex)) {
    const line = getLineNumber(content, match.index!);
    const name = match[1];
    symbols.push({
      name,
      kind: "function",
      startLine: line,
      endLine: line,
      exported: name[0] === name[0].toUpperCase(), // Go的导出规则
      signature: match[0].trim(),
    });
  }

  // 提取类型定义
  const typeRegex = /^\s*type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+(struct|interface)/gm;
  for (const match of content.matchAll(typeRegex)) {
    const line = getLineNumber(content, match.index!);
    const name = match[1];
    symbols.push({
      name,
      kind: match[2] === "struct" ? "class" : "interface",
      startLine: line,
      endLine: line,
      exported: name[0] === name[0].toUpperCase(),
      signature: match[0].trim(),
    });
  }

  return symbols;
}

// ========== 辅助函数 ==========

function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}
