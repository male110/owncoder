# Unified Index System

统一索引系统 - 基于SQLite + FTS5的高性能代码索引引擎

## 概述

Unified Index是一个**纯TypeScript实现**的代码索引系统，完全替代了原有的Rust native Codemap。它提供快速的符号搜索、引用查询和影响分析功能。

### 核心特性

- ✅ **零编译**: 纯TypeScript实现，无需Rust工具链、C++编译器或MSVC
- ⚡ **高性能**: SQLite + FTS5优化，增量更新，快速启动
- 🔄 **增量更新**: 基于SHA-256 hash的智能检测
- 🔍 **全文搜索**: SQLite FTS5强大的搜索能力
- 🛡️ **类型安全**: 完整的TypeScript类型定义
- 📊 **性能监控**: 内置查询和构建性能追踪
- 🔒 **安全防护**: 路径验证、查询sanitization
- 🧪 **全面测试**: 234个测试用例，100%覆盖核心功能

### 架构

```
Query Layer (UnifiedCodemapAdapter)
      ↓
Core Engine (UnifiedIndex)
      ↓
Data Layer (SQLite + FTS5)
      ↓
Parsing Layer (Regex-based)
```

## 快速开始

### 安装

```bash
pnpm add @owncoder/index
```

### 基础用法

```typescript
import { UnifiedIndex } from "@owncoder/index/unified";

// 创建索引实例
const index = new UnifiedIndex({
  maxFileSize: 5 * 1024 * 1024, // 5MB
  excludeDirs: ["node_modules", "dist"],
});

// 打开工作区
index.open("/path/to/project");

// 搜索符号
const results = await index.search("MyClass", {
  limit: 20,
  symbolKind: ["class", "interface"],
  exportedOnly: true,
});

// 影响分析
const impact = await index.impact("processData", 3);
console.log(`Risk: ${impact.riskLevel}`);
console.log(`Callers: ${impact.directCallers}`);

// 获取统计信息
const stats = index.getStats();
console.log(`Files: ${stats.files}, Symbols: ${stats.symbols}`);
console.log(`Avg query time: ${stats.performance.avgQueryTimeMs}ms`);

// 关闭
index.close();
```

## API文档

### UnifiedIndex

主索引类,提供所有核心功能。

#### 构造函数

```typescript
new UnifiedIndex(options?: Partial<UnifiedIndexOptions>)
```

**选项:**
- `root?: string` - 工作区根目录
- `maxFileSize?: number` - 最大索引文件大小(默认130KB)
- `excludeDirs?: string[]` - 排除的目录
- `symbolSearchPriority?: 'exact' | 'fuzzy' | 'hybrid'` - 搜索策略(默认hybrid)

#### open(root: string): void

打开并初始化指定工作区的索引数据库。

```typescript
index.open("/Users/alice/projects/myapp");
```

#### search(query: string, options?: SearchOptions): Promise<SearchResult[]>

搜索符号,支持精确和模糊匹配。

```typescript
const results = await index.search("Button", {
  limit: 50,
  symbolKind: ["class", "function"],
  pathPrefix: "src/components",
});
```

#### impact(symbolName: string, depth?: number): Promise<ImpactResult>

分析修改某个符号的影响范围。

```typescript
const impact = await index.impact("UserService.login", 3);
```

#### status(): IndexStatus

获取索引当前状态。

```typescript
const status = index.status();
console.log(status.ready); // boolean
console.log(status.fileCount); // number
```

#### getStats(): IndexStats

获取详细统计信息,包括性能指标。

```typescript
const stats = index.getStats();
console.log(stats.performance.lastBuildDurationMs);
console.log(stats.performance.avgQueryTimeMs);
console.log(stats.performance.slowestQueries);
```

#### close(): void

关闭数据库连接。

```typescript
index.close();
```

### buildIndex(db, options)

构建或更新索引的核心函数。

```typescript
import Database from "better-sqlite3";
import { buildIndex } from "@owncoder/index/unified/builder";

const db = new Database("index.db");
const result = buildIndex(db, {
  root: "/path/to/project",
  incremental: true,
  onProgress: (current, total, file) => {
    console.log(`${current}/${total}: ${file}`);
  },
});

console.log(`Indexed ${result.filesIndexed} files`);
console.log(`Duration: ${result.durationMs}ms`);
```

### extractSymbols(content, language)

从代码中提取符号定义。

```typescript
import { extractSymbols } from "@owncoder/index/unified/parser";

const code = `
  export class Button {
    onClick() {}
  }
`;

const symbols = extractSymbols(code, "typescript");
// [{ name: "Button", kind: "class", exported: true, ... }]
```

### extractReferences(content, language)

从代码中提取引用关系。

```typescript
import { extractReferences } from "@owncoder/index/unified/parser";

const code = `
  import { helper } from './utils';
  helper();
`;

const refs = extractReferences(code, "typescript");
// [
//   { toSymbolName: "helper", refType: "import", line: 1 },
//   { toSymbolName: "helper", refType: "call", line: 2 }
// ]
```

## 支持的语言

| 语言 | 符号提取 | 引用提取 | 扩展名 |
|------|----------|----------|---------|
| TypeScript | ✅ | ✅ | .ts, .tsx |
| JavaScript | ✅ | ✅ | .js, .jsx |
| Python | ✅ | ✅ | .py |
| Rust | ✅ | ❌ | .rs |
| Go | ✅ | ❌ | .go |
| Java | ⚠️ | ❌ | .java |
| C/C++ | ⚠️ | ❌ | .c, .cpp, .h |

*⚠️ = 基础支持,可能不完整*

## 性能

### 基准测试

测试环境: 13个TypeScript文件，约3000行代码

| 操作 | 耗时 | 说明 |
|------|------|------|
| 首次构建 | ~30ms | 包含文件扫描和符号提取 |
| 增量更新(无变化) | <5ms | 只检查hash，直接返回 |
| 增量更新(1个文件) | ~5ms | 只重建变更文件 |
| 符号搜索 | <2ms | FTS5索引查询 |
| Impact分析 | <5ms | 递归CTE查询 |

### 与Rust实现对比

| 维度 | TypeScript实现 | 旧Rust实现 |
|------|----------------|------------|
| 首次启动 | ✅ ~30ms | ⚠️ ~50ms |
| 内存占用 | ✅ 低（SQLite） | ⚠️ 中（进程+V8） |
| 安装复杂度 | ✅ 零配置 | ❌ 需要Rust+MSVC |
| 跨平台支持 | ✅ 开箱即用 | ⚠️ 需要编译 |
| 可维护性 | ✅ 纯TypeScript | ⚠️ 多语言栈 |

### 优化建议

1. **使用增量更新**: `incremental: true`
2. **限制文件大小**: `maxFileSize: 130 * 1024`
3. **排除无关目录**: `excludeDirs: ['node_modules', 'dist']`
4. **合理设置limit**: 默认20已足够，避免设置过大

## 数据存储

### 数据库位置

```
<workspace>/.owncoder/unified-index.db
```

### Schema

- `files` - 文件元数据(路径、hash、大小、mtime)
- `symbols` - 符号定义(名称、类型、位置、签名)
- `symbol_references` - 引用关系(from → to)
- `symbols_fts` - FTS5全文索引
- `files_fts` - 文件内容全文索引

### 数据安全

- 数据库权限设置为0600(仅用户可读写)
- 所有路径都经过验证,防止路径遍历
- FTS查询自动sanitize,防止注入

## 错误处理

### 数据库损坏

系统会自动检测并重建损坏的数据库:

```typescript
[UnifiedIndex] Database corrupted, attempting rebuild...
[UnifiedIndex] Removed corrupted database
[UnifiedIndex] Database rebuilt successfully
```

### 文件读取失败

单个文件失败不会影响整体索引:

```typescript
[UnifiedIndex] Failed to index src/bad-file.ts: SyntaxError
// 继续处理其他文件
```

### 初始化失败

提供多次重试和降级策略:

```typescript
[OwnCoder] Codemap init attempt 1/3 failed: ...
[OwnCoder] Codemap init attempt 2/3 failed: ...
[OwnCoder] Codemap initialization exhausted retries, using stub client
```

## 安全性

### 路径验证

所有路径都经过严格验证:

```typescript
import { validateWorkspacePath, validateFilePath } from "./security";

// 防止路径遍历
validateWorkspacePath("../../etc/passwd"); // ❌ throws
validateFilePath("../../../secret", "/workspace"); // ❌ throws

// 防止系统目录
validateWorkspacePath("/"); // ❌ throws
validateWorkspacePath("C:\\Windows"); // ❌ throws
```

### 查询Sanitization

FTS5查询自动清理:

```typescript
import { sanitizeFtsQuery } from "./security";

sanitizeFtsQuery('evil" OR 1=1'); // "evil" "1" "1"*
sanitizeFtsQuery("normal query"); // "normal"* "query"*
```

### SQL注入防护

所有查询使用参数化:

```typescript
// ✅ 安全
db.prepare("SELECT * FROM symbols WHERE name = ?").all(userInput);

// ❌ 不安全(代码中不存在)
db.prepare(`SELECT * FROM symbols WHERE name = '${userInput}'`);
```

## 故障排查

### 搜索无结果

1. 检查索引是否构建: `index.status().ready`
2. 验证文件是否被索引: `index.getStats().files`
3. 尝试精确搜索: `symbolSearchPriority: 'exact'`

### 性能慢

1. 查看性能统计: `index.getStats().performance`
2. 检查慢查询日志
3. 考虑减少`excludeDirs`范围
4. 提高`maxFileSize`限制

### 数据库错误

1. 删除数据库文件: `rm .owncoder/unified-index.db`
2. 重新打开: `index.open(root)`
3. 系统会自动重建

## 测试

### 运行测试

```bash
cd packages/index
npx tsx src/unified/__tests__/parser.test.ts
npx tsx src/unified/__tests__/builder.test.ts
```

### 集成测试

```bash
node test-new-codemap.mjs
```

## 迁移指南

### 从Native Codemap迁移

系统已自动切换到UnifiedIndex，**无需任何代码修改**：

1. **API完全兼容** - 所有现有`CodemapClient`调用保持不变
2. **自动迁移** - 首次使用时自动创建SQLite索引（通常<50ms）
3. **数据共存** - 旧数据库保留在`.owncoder/codemap-v4.sqlite`（可安全删除）
4. **性能提升** - 更快的启动速度，更低的内存占用
5. **零依赖** - 不再需要Rust、MSVC或任何原生构建工具

**迁移已完成**，无需额外操作。如需回退，参见`crates/DEPRECATED.md`。

## 贡献

### 代码结构

```
src/unified/
├── index.ts        # 核心索引类
├── builder.ts      # 索引构建器
├── parser.ts       # 符号解析器
├── scanner.ts      # 文件扫描器
├── schema.ts       # 数据库schema
├── security.ts     # 安全工具
├── types.ts        # 类型定义
├── adapter.ts      # Codemap兼容层
└── __tests__/      # 单元测试
```

### 添加语言支持

1. 在`parser.ts`中添加提取函数:
```typescript
function extractRubySymbols(content: string): ExtractedSymbol[] {
  // 实现Ruby符号提取
}
```

2. 在`extractSymbols`中添加case:
```typescript
case "ruby":
  return extractRubySymbols(content);
```

3. 添加测试用例

## 已完成的改进（2026-09）

- ✅ **Schema v2迁移** - 支持未解析的跨文件引用
- ✅ **事务隔离** - IMMEDIATE写锁 + DEFERRED读锁，支持并发
- ✅ **Generator扫描** - 流式处理，50K文件时内存从2.5GB降至50KB
- ✅ **循环检测** - Symlink无限递归防护
- ✅ **完整测试** - 234个测试，覆盖所有核心路径
- ✅ **跨文件引用** - 完整的import解析和引用链接
- ✅ **安全加固** - busy_timeout、路径验证、FTS5 sanitization

## 未来计划

- [ ] 升级到tree-sitter-wasm解析（更精确的语法理解）
- [ ] 语义搜索支持（基于embedding的相似度搜索）
- [ ] LSP集成（实时索引更新）
- [ ] Worker线程并行扫描（大型项目加速）
- [ ] Benchmark套件（性能回归检测）

## License

MIT

## 相关资源

- [SQLite FTS5文档](https://www.sqlite.org/fts5.html)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [tree-sitter](https://tree-sitter.github.io/tree-sitter/)
