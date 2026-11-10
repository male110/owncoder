# run_script：精准定位与探索示例

本文件是按需查阅的示例库，不自动注入模型上下文。内置系统提示词不包含本文件的操作链；工具描述只保留适用边界和调用约束，完整范例集中在这里维护。

用法：先判断是否需要脚本。若只需一次 `grep`、`glob` 或 `read_file` 且可直接使用其返回值，应调用对应的顶层工具，不要套 `run_script`。只有需要在 JavaScript 中实质过滤、聚合、解析或交叉匹配结果，或需要协调多次工具调用时，才将合适的 `javascript` 代码块作为 `run_script` 的 `code` 参数。每个脚本内的 `tools.call` 除外层 `run_script` 调用外还消耗嵌套调用预算。

约定：
- 以下 `tools.call(name, args)` 形式只适用于 `run_script` 脚本内部；顶层直接调用使用平台提供的工具接口。脚本内调用返回 `{ ok, output }`，失败需检查 `ok`。工具只能这样调用——`tools` 上没有具名函数，`const { grep, read_file } = tools` 后直接 `grep({...})` 会抛 TypeError。**文件搜索一律走受控的 `grep`/`glob` 工具，不要在脚本里用 bash/child_process 拼 `grep`/`find`/`ls` 命令**：`await tools.call("grep", { pattern: "getUser\\(", file_path: "src/main/java", glob: "**/*.java", output_mode: "files_with_matches" })`。这两个工具的路径都是 workspace-relative，自动遵守 `.gitignore`，并跳过点目录、生成目录（node_modules/dist/build/out/target/vendor 等）、锁文件、二进制和超过 2MB 的文件——不需要再手动加 `--include`/`--exclude-dir`。`glob` 按文件名模式定位文件（`**/*.java`、`*.json`），`grep` 按内容定位；两者输出都是 workspace-relative 路径，`grep` content 模式每行形如 `path:line:text`，`files_with_matches` 每行一个路径，`count` 每行形如 `path:N`。
- `read_file` 返回 `[lines 1-N of T]` 头和 `N|` 行号前缀，不是裸文件。保留行号方便引用证据；当前范围读取的 `T` 仅是已扫描行数估计，不能用于准确总行数统计。
- 最多60次工具调用，默认120秒（最高300秒），返回输出上限24KB（超过8KB时，若 run_script 传了 intent 参数则按意图关键词开窗提取相关片段，而不是只留前缀）。下面的循环均有边界，不应盲目遍历整仓库。
- 搜索或打印上限不是完整性保证。遇到截断，缩小范围或分页（`grep` 支持 `head_limit`/`offset`，`glob`/`grep` 支持 `max_results`）；保留未确认项，不用“没看到”代替“不存在”。
- 脚本只写代码，不用写注释。
- 工具路径全部是当前 workspace 的相对路径（`.` 表示工作区根），**不要使用 `/workspace`、`/e/...` 这类容器绝对路径**——它们在 Windows 上不存在。bash 工具与 child_process 字符串命令仅在确需外部命令（构建、版本探测等）时使用：Windows 默认使用系统 PowerShell（`powershell.exe`），字符串命令应采用 PowerShell 语法，例如变量用 `$value = ...`，管道用 `|`，重定向用 `>` 或 `2>&1`，路径使用 `C:\work\file.txt` 或当前 workspace 相对路径；不要假设 POSIX 的 `/dev/null`、`$VAR`、`cat` 或 `/e/...` 路径可用。Spec 模式的只读门禁只允许单条只读命令——该模式请直接用 `grep`/`glob`/`read_file` 编排。
- `node:vm` 不是安全隔离边界；脚本仍需遵守宿主权限和确认规则。脚本只能 `require` Node 内建模块（`fs`/`path`/`node:process` 等，`node:` 前缀可选）做计算辅助；动态 `import()` 与 `require` 等效，不支持静态 `import` 语句。`process`/`Buffer`/`__dirname`/`__filename`/`fetch` 全局不存在——需要时用 `require("node:process")` 等内建模块取。文件读写一律走 `tools.call`（`read_file`/`write_file`/`apply_patch`），文件搜索走 `grep`/`glob`，不要用 `fs` 直读直写。

## 1. 经典：找到调用方，排除测试、生成代码和定义

问题：哪些业务代码调用 `getByBlankAndStudentPaperIds`？一次 `grep` 内容搜索拿到“匹配带接收者的调用表达式”，再在 JS 里排除测试/生成目录并按位置去重，最后最多返回四个调用点的局部源码。这个模式排除了常见定义形式，但不能识别所有 Java 语法、同名方法和重载。

```javascript
const symbol = "getByBlankAndStudentPaperIds";
const hits = await tools.call("grep", {
  pattern: "\\b" + symbol + "\\s*\\(",
  file_path: "src",
  glob: "**/*.java",
  output_mode: "content",
  max_results: 40,
});
if (!hits.ok) throw new Error(hits.output);

const points = [];
for (const line of hits.output.split("\n").map(s => s.trim()).filter(Boolean)) {
  if (/(^|\/)(test|generated)\//.test(line)) continue;
  const m = line.match(/^([^:]+):(\d+):/);
  if (m) points.push({ file: m[1], line: Number(m[2]) });
}
for (const p of points.slice(0, 4)) {
  const r = await tools.call("read_file", {
    file_path: p.file, offset: Math.max(1, p.line - 3), limit: 8,
  });
  if (!r.ok) throw new Error(r.output);
  console.log("调用候选 " + p.file + ":" + p.line + "\n" + r.output);
}
console.log("文本调用候选=" + points.length + "，展示最多4处；符号绑定仍需索引/LSP确认。");
```

同一文件同时命中不等于同一方法。下一步按证据行号核验方法/类级注解、传播属性、代理调用与自调用；不要直接回答“事务生效”。可将条件替换为“路由+Service”“表名+Mapper”“配置读取+客户端创建”等。

## 3. 高技巧：上下游双向夹逼，定位流程连接点

问题：入口 `submitHomework` 与最终 `saveBatch` 之间可能由哪个方法衔接？从入口窗口提取下游方法名，再与写入点所在文件交叉匹配，只返回连接候选附近证据。

```javascript
const root = "src/main/java";
async function search(pattern, opts) {
  const o = opts || {};
  const r = await tools.call("grep", {
    pattern: pattern,
    file_path: o.path || root,
    glob: "**/*.java",
    output_mode: o.filesOnly ? "files_with_matches" : "content",
    context: o.context || 0,
    max_results: 60,
  });
  if (!r.ok) throw new Error(r.output);
  return r.output;
}
const hits = await search("\\bsubmitHomework\\s*\\(");
const declarations = hits.split("\n").map(s => s.trim()).filter(s => /\b(public|protected|private)\b/.test(s));
if (declarations.length !== 1) throw new Error("入口定义未唯一确认，请限定文件或符号");
const entry = declarations[0].match(/^(.+?\.java):(\d+):/);
if (!entry) throw new Error("无法解析入口位置");
const body = await tools.call("read_file", {
  file_path: entry[1], offset: Number(entry[2]), limit: 35,
});
if (!body.ok) throw new Error(body.output);
const names = [...new Set(
  [...body.output.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1])
)].filter(s => !["get", "set", "equals", "toString", "size"].includes(s));
if (!names.length) throw new Error("入口窗口没有可用下游线索，需调整读取范围");
const sites = await search("\\.\\s*saveBatch\\s*\\(", { filesOnly: true });
console.log("入口 " + entry[1] + ":" + entry[2]);
for (const file of sites.split("\n").map(s => s.trim()).filter(s => s.endsWith(".java")).slice(0, 6)) {
  const bridge = await search("\\b(" + names.map(s => s.replace(/[$]/g, "\\$")).join("|") + ")\\s*\\(", { path: file, context: 3 });
  if (/\.java:\d+:/.test(bridge)) console.log("连接候选 " + file + "\n" + bridge);
}
console.log("仅检查入口附近35行与最多6个写入文件；结果是文本线索，尚未证明完整调用链。");
```

## 5. 表加字段：定位该表对应的 Entity / VO / Mapper 类

需求场景：`exam_task_topic_teacher_paper` 表新增 `from_user_id`、`from_review_type` 字段，要找到对应的实体/VO 类去加字段。表名到类名是驼峰转换，直接搜类名前缀 `ExamTaskTopicTeacherPaper` 就能一次网住所有相关类，再按目录角色分类、逐文件核对类声明——确认它是 class 还是 interface（Mapper 往往是接口），避免把只是引用了该类的业务代码当成定义文件。

```javascript
const r = await tools.call("grep", {
  pattern: "ExamTaskTopicTeacherPaper",
  file_path: ".",
  glob: "**/*.java",
  output_mode: "files_with_matches",
});
if (!r.ok) throw new Error(r.output);
const found = r.output.split("\n").map(s => s.trim()).filter(f => f.endsWith(".java"));
if (!found.length) throw new Error("未找到该表对应的类");

const items = await Promise.all(found.map(async f => {
  const d = await tools.call("grep", {
    pattern: "(class|interface) ExamTaskTopicTeacherPaper",
    file_path: f,
  });
  const role = /entity/i.test(f) ? "Entity" : /vo/i.test(f) ? "VO" : "其他";
  const decl = /(?:class|interface)\s+\w+/.exec(d.output)?.[0] ?? "(无类声明)";
  return role + " " + f + " — " + decl;
}));
console.log(items.join("\n"));
```

要点：先 `grep` 的 `files_with_matches` 一次性拿到全部命中文件（中间结果不进上下文，且自动遵守 `.gitignore`、跳过生成目录），按目录路径判角色，第二次 grep 只为核对每个文件的类声明。输出形如：

```
Entity marking-core/src/main/java/com/modi/entity/ExamTaskTopicTeacherPaper.java — class ExamTaskTopicTeacherPaper
其他 marking-core/src/main/java/com/modi/mapper/ExamTaskTopicTeacherPaperMapper.java — interface ExamTaskTopicTeacherPaperMapper
VO marking-core/src/main/java/com/modi/vo/ExamTaskTopicTeacherPaperVO.java — class ExamTaskTopicTeacherPaperVO
```

拿到类定义位置后，再用 `read_file` 精读对应文件加字段即可。同构场景：表/接口/配置项改名、删字段、排查某张表被哪些类承载。只知道文件名时用 `glob`：`tools.call("glob", { pattern: "**/*ExamTaskTopicTeacherPaper*.java", file_path: "." })`。

## 6. 探索定位：多工具组合查找与精读

问题：找到所有调用 `parseBody` 的业务代码文件，排除测试和生成目录，只读取前 3 个匹配文件的前 40 行。这个模式展示标准探索工作流：`grep`（`files_with_matches`）拿候选文件 → JS 切片限制数量 → `read_file` 精读 → `grep`（content）定位具体行号。

```javascript
const candidates = await tools.call("grep", {
  pattern: "parseBody",
  file_path: "src",
  glob: "**/*.ts",
  output_mode: "files_with_matches",
});
if (!candidates.ok) throw new Error(candidates.output);
// 生成目录已被工具自动跳过；测试目录按路径在 JS 里排除
const files = candidates.output.split("\n").map(s => s.trim()).filter(f => f && !/(^|\/)(test|generated)\//.test(f));
if (!files.length) throw new Error("未找到包含 parseBody 的源文件");

for (const f of files.slice(0, 3)) {
  const r = await tools.call("read_file", { file_path: f, limit: 40 });
  if (!r.ok) throw new Error(r.output);
  console.log("=== " + f + " ===\n" + r.output);
}

const firstFile = files[0];
const lines = await tools.call("grep", {
  pattern: "parseBody",
  file_path: firstFile,
  max_results: 10,
});
if (!lines.ok) throw new Error(lines.output);
console.log(firstFile + " 中的精确行号:\n" + lines.output);
```

要点：
- `grep` 的 `files_with_matches` 一次性拿到全部命中文件（中间结果不进上下文），用 `max_results` 或 JS `slice` 设边界。
- 测试/生成目录里的命中按路径在 JS 里排除——工具已自动遵守 `.gitignore` 并跳过生成目录，只剩业务自定义目录需要过滤。
- `read_file` 只读前 40 行（已确认的 small scope），不是全文件。
- content 模式自带 `path:line:` 前缀，可直接拿到精确行号，方便后续 `apply_patch` 引用。
- 同构场景：函数调用链追踪、接口实现查找、配置项引用定位、表字段被哪些类承载。

## 常见错误模式与修复方法

以下三类错误均源于工具调用载荷在传输/解析层被截断或引号错乱，**不是 run_script 运行器（纯 V8 `vm.Script`）对字符的禁令**。字符串内的 `<` 本身合法。

### 错误模式一：脚本被截断、字符串未闭合 → V8 报 `Invalid or unexpected token`

**错误示例**：长脚本在传输过程中被截断，末尾字符串未闭合。

```javascript
// 截断后的脚本——字符串未闭合，V8 报 Invalid or unexpected token
const r = await tools.call("grep", {
  pattern: "someVeryLongPatternThatExceedsThePayloadLimit",
  file_path: "src",
// 脚本到这里就被截断了，缺少闭合的引号和后续代码
```

**根因**：载荷超出传输/解析层上限被截断，字符串引号未闭合。

**正确写法**：分步调用、每步脚本精简。把长操作拆成独立的小脚本，每步都短到不会被截断。

```javascript
// 步骤 1：先拿到文件列表
const list = await tools.call("grep", {
  pattern: "someVeryLongPatternThatExceedsThePayloadLimit",
  file_path: "src",
  glob: "**/*.ts",
  output_mode: "files_with_matches",
});
if (!list.ok) throw new Error(list.output);
const files = list.output.split("\n").filter(Boolean);

// 步骤 2：对每个文件单独搜索（脚本极短，不会截断）
for (const f of files) {
  const r = await tools.call("grep", {
    pattern: "someVeryLongPatternThatExceedsThePayloadLimit",
    file_path: f,
  });
  if (r.ok && r.output.trim()) console.log(f + "\n" + r.output.trim());
}
```

### 错误模式二：含尖括号的长 pattern 使引号配对被打乱 → V8 报 `Unexpected token '<'`

**错误示例**：含 `< >` 的长 pattern（如 Java 泛型 `LambdaQueryWrapper<X>`）使引号配对被打乱，`<` 暴露到代码位置。

```javascript
// 错误——含 < > 的长 pattern 嵌套在字符串中，引号配对被打乱
const r = await tools.call("grep", {
  pattern: "LambdaQueryWrapper<X<Y>>.class",
  file_path: "src",
});
// V8 报 Unexpected token '<'——不是因为 < 被禁止，而是引号配对错乱后 < 暴露到了代码位置
```

**根因**：载荷截断或引号错乱导致 `<` 暴露到代码位置，不是 `<` 字符本身被禁止。

**正确写法**：把 pattern 拆到变量、用模板字符串或反引号，必要时用字符类 `[<]` 规避。

```javascript
// 修复 1：把 pattern 拆到变量
const pattern = "LambdaQueryWrapper<X<Y>>.class";
const r = await tools.call("grep", { pattern: pattern, file_path: "src" });

// 修复 2：用模板字符串（反引号）包裹 pattern，避免引号嵌套
const r2 = await tools.call("grep", { pattern: `LambdaQueryWrapper<X<Y>>.class`, file_path: "src" });

// 修复 3：若引号嵌套仍出问题，用字符类 [<] 替代 <（正则中 [<] 等价于 <）
const r3 = await tools.call("grep", { pattern: "LambdaQueryWrapper[X<Y>].class", file_path: "src" });
```

### 关键原则

- 字符串内的 `<` 合法，`>` 合法，尖括号不是 run_script 的禁用字符。
- 报错 `Invalid or unexpected token` → 脚本被截断、字符串未闭合；用分步调用、每步脚本精简来修复。
- 报错 `Unexpected token '<'` → 引号配对错乱后 `<` 暴露到代码位置；用变量拆分、模板字符串或字符类 `[<]` 来修复。
- 任何报错先检查 `ok` 字段和错误信息，不要把传输层问题误判为字符禁令。

## 后续增加示例的要求

1. 只解决一个明确探索问题；优先用 `grep`/`glob` 的路径/计数模式筛选，再读取小范围证据。
2. 为搜索、循环和打印设置边界，检查工具失败与截断，保留不确定性。
3. 输出位置、必要原文、搜索范围与未确认项，不返回全部中间数据。
4. 先用 fixture 验证脚本，再将最短的操作链加入工具描述；不要把完整示例库塞回系统提示词。新增示例一律用 `grep`/`glob` 工具搜索，不要写 bash `grep`/`find`/`ls` 命令。
