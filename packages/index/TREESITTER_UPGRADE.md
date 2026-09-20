# Tree-sitter WASM 升级

## 概述

将索引系统从基于正则表达式的简单解析器升级到基于 tree-sitter WASM 的准确语法解析器。

## 主要改进

### 1. 语言支持大幅扩展

**之前**: 10种语言（TypeScript、JavaScript、TSX、JSX、Python、Rust、Go、Java、C++、C）

**现在**: 35+种语言，包括：

- **Web & JavaScript 生态**: TypeScript, JavaScript, TSX, JSX
- **系统编程**: C, C++, Rust, Go, Zig, Swift
- **JVM 语言**: Java, Kotlin, Scala
- **脚本语言**: Python, Ruby, PHP, Lua, Bash, Dart
- **函数式语言**: Elixir, Elm, OCaml, ReScript, Elisp
- **.NET 生态**: C#
- **前端样式**: CSS, HTML, Vue
- **数据格式**: JSON, YAML, TOML
- **其他**: Objective-C, Solidity, QL

### 2. 解析准确性提升

- **之前**: 基于正则表达式，可能产生假阳性，无法处理复杂语法结构
- **现在**: 基于语法树的准确解析，理解代码结构

### 3. 双引擎架构

保持向后兼容，采用渐进式升级策略：

```typescript
// 优先使用 tree-sitter
if (isLanguageSupported(language)) {
  try {
    return await extractSymbolsTreeSitter(content, language);
  } catch (error) {
    console.warn('Tree-sitter failed, fallback to regex');
  }
}

// 回退到正则表达式
return extractSymbolsRegex(content, language);
```

## 新增 API

### 初始化

```typescript
import { initTreeSitter } from '@owncoder/index';

// 应用启动时调用一次
await initTreeSitter();
```

### 异步解析

```typescript
import { extractSymbolsAsync, extractReferencesAsync } from '@owncoder/index';

// 异步提取符号
const symbols = await extractSymbolsAsync(code, 'typescript');

// 异步提取引用
const references = await extractReferencesAsync(code, 'typescript');
```

### Tree-sitter 直接调用

```typescript
import {
  extractSymbolsTreeSitter,
  extractReferencesTreeSitter,
  isLanguageSupported,
  getSupportedLanguages,
} from '@owncoder/index';

// 检查语言支持
if (isLanguageSupported('kotlin')) {
  const symbols = await extractSymbolsTreeSitter(code, 'kotlin');
}

// 获取所有支持的语言
const languages = getSupportedLanguages();
console.log(languages); // ['typescript', 'python', 'rust', ...]
```

## 文件变更

### 新增文件

- `packages/index/src/unified/parser-treesitter.ts` - Tree-sitter WASM 解析器实现
- `packages/index/src/unified/__tests__/parser-treesitter.test.ts` - 测试套件

### 修改文件

- `packages/index/src/unified/parser.ts` - 添加双引擎支持
- `packages/index/src/unified/types.ts` - 扩展 SUPPORTED_LANGUAGES
- `packages/index/src/index.ts` - 导出新 API
- `packages/index/package.json` - 添加 tree-sitter-wasms 依赖
- `README.md` - 更新语言支持说明

## 技术细节

### WASM 加载策略

根据运行环境自动选择加载方式：

```typescript
// Node.js: 直接读取文件系统
const wasmBuffer = readFileSync(wasmPath);
const lang = await Parser.Language.load(wasmBuffer);

// Browser: 使用 fetch
const response = await fetch(wasmUrl);
const wasmBuffer = await response.arrayBuffer();
const lang = await Parser.Language.load(wasmBuffer);
```

### 语言解析器缓存

```typescript
const languageCache = new Map<string, Parser.Language>();

// 首次加载后缓存，避免重复加载
if (languageCache.has(wasmName)) {
  return languageCache.get(wasmName)!;
}
```

### 符号提取策略

每种语言使用定制的提取器：

- **TypeScript/JavaScript**: 提取函数、箭头函数、类、接口、类型、枚举
- **Python**: 提取函数、类，识别私有符号（`_` 前缀）
- **Rust**: 提取函数、结构体、trait，识别 `pub` 可见性
- **Go**: 提取函数、类型，识别首字母大写导出规则
- **JVM 语言**: 提取方法、类、接口，识别 `public` 修饰符
- **C/C++**: 提取函数、类、结构体
- **通用策略**: 模式匹配后备方案

## 使用示例

### 基础用法

```typescript
import { UnifiedIndex, initTreeSitter } from '@owncoder/index';

// 1. 初始化 tree-sitter
await initTreeSitter();

// 2. 创建索引
const index = new UnifiedIndex();
index.open('/path/to/project');

// 3. 索引会自动使用 tree-sitter 解析
await buildIndex(index.getDatabase()!, {
  root: '/path/to/project',
  incremental: true,
});

// 4. 搜索（享受更准确的结果）
const results = await index.search('MyClass');
```

### 手动解析

```typescript
import { extractSymbolsAsync } from '@owncoder/index';

const kotlinCode = `
class Person(val name: String) {
    fun greet(): String {
        return "Hello, $name"
    }
}
`;

const symbols = await extractSymbolsAsync(kotlinCode, 'kotlin');
// [
//   { name: 'Person', kind: 'class', exported: true, ... },
//   { name: 'greet', kind: 'function', exported: true, ... }
// ]
```

## 性能影响

- **解析速度**: Tree-sitter 比正则表达式稍慢，但差异可接受（毫秒级）
- **内存占用**: WASM 模块按需加载并缓存，初次加载后无额外开销
- **准确性**: 显著提升，几乎零假阳性

## 向后兼容性

- 所有现有 API 保持不变
- 同步 API (`extractSymbols`, `extractReferences`) 继续工作，但建议使用异步版本
- 不支持的语言自动回退到正则表达式解析

## 未来改进

1. **更多语言**: 添加 Haskell、F#、Clojure 等
2. **更精细的引用分析**: 追踪变量引用、类型引用
3. **语义理解**: 结合类型信息进行更智能的分析
4. **增量解析**: 利用 tree-sitter 的增量解析能力优化性能

## 依赖

- `web-tree-sitter`: ^0.24.4（已有）
- `tree-sitter-wasms`: ^0.1.13（新增）

## 测试

运行测试：

```bash
pnpm --filter @owncoder/index test parser-treesitter
```

测试覆盖：
- 语言支持检测
- TypeScript 符号提取（函数、类、接口、类型、枚举）
- Python 符号提取（函数、类、私有符号）
- 引用提取（import、函数调用）
- 不支持的语言回退

## 注意事项

1. **初始化**: 使用 tree-sitter 前必须调用 `initTreeSitter()`
2. **异步**: 推荐使用异步 API (`extractSymbolsAsync`、`extractReferencesAsync`)
3. **WASM 文件**: 确保 `node_modules/tree-sitter-wasms/out/` 目录可访问
4. **浏览器部署**: 需要配置 WASM 文件的正确路径

## 总结

此次升级显著提升了索引系统的语言支持和解析准确性，同时保持向后兼容。通过双引擎架构，系统能够优雅地处理新旧语言，为用户提供更好的代码理解和导航体验。
