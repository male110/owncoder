/**
 * 索引导航（检索优先的探索起点——Cursor 式 auto-context 的 owncoder 实现）。
 *
 * 探索漫游的一大根源是"不知道从哪入手"：模型只能靠 grep/read 一路试。
 * 索引对每个回合都是现成的先验知识——本模块把双路召回封装成三个消费者
 * 共享的核心：
 *   - Explore 子代理引导块（subagent/run-subagent.ts）
 *   - context_gather 索引导航候选（loop/context.ts）
 *   - 分解驱动的每步召回（buildRecallBlock：execute_tools 阶段从分解结果
 *     一次召回，注入 react 循环每一步与任务图节点 prompt）
 *
 * 双路（hybrid）：
 *   1. 语义路：index.ragSearch(query)——自然语言查询嵌入，命中 FTS 够不着的
 *      "无确切标识符"场景（代码语义索引，桌面端注入端口）；
 *   2. 关键词路：标识符提取 → index.ftsSearch per identifier——精确符号命中。
 *
 * 这里是内部上下文导航的 hybrid 召回，不改变公开 search_symbols 的职责；
 * 面向模型的语义向量检索由 search_semantic 工具单独提供。
 * 语义文件排前，关键词补充语义漏掉的文件与行号/签名。
 *
 * 全部 best-effort：两个 IndexClient 成员（ragSearch / ftsSearch）都是可选
 * 接口，stub / 未实现 / 抛错 / 空结果逐级降级，双路皆空返回 undefined，
 * 调用方行为与现状逐字一致。不引入 embeddings（模型在 desktop 端口侧）。
 */

import type { IndexClient, RagHit, SymbolSearchResult } from "@owncoder/index";

/** 单符号命中（语义路带 preview 摘录，关键词路带 kind/signature）。 */
export interface NavigationSymbolHit {
  name: string;
  kind?: string;
  line: number;
  endLine?: number;
  /** 单行预览（语义命中取 chunk 的签名/doc 行；关键词命中取 signature）。 */
  preview?: string;
}

/** 聚合后的单文件导航命中。 */
export interface NavigationFileHit {
  path: string;
  symbols: NavigationSymbolHit[];
  /** 语义路命中（排序优先，且说明来自代码向量索引而非关键词匹配）。 */
  semantic?: boolean;
}

/** 语义路查询 top-K。 */
const SEMANTIC_TOP_K = 12;
/** Low-confidence vector hits are navigation noise, not task evidence. */
const MIN_SEMANTIC_SCORE = 0.55;
const MAX_IDENTIFIERS = 8;
const MAX_FILES = 8;
const MAX_SYMBOLS_PER_FILE = 3;
const FTS_LIMIT = 20;
/** 渲染块总长硬上限（字符）：候选块注入后不裁剪，必须在此 bounded。 */
const MAX_BLOCK_CHARS = 1500;
/** preview 单行字符上限。 */
const PREVIEW_CHARS = 110;
/** 分解召回查询的合成上限（字符）：intent + 各任务文本 + 用户原文。 */
const RECALL_QUERY_MAX_CHARS = 2000;
const NAVIGATION_MEMO_TTL_MS = 30_000;
const navigationMemo = new WeakMap<IndexClient, Map<string, { expiresAt: number; hits: NavigationFileHit[] | undefined }>>();
/** 每步注入的召回块标题：导航指针——直达具名文件与符号范围，不附加"先读再依赖"指令。 */
export const RECALL_HEADING =
  "## Relevant code recalled for this task (navigation pointers — go straight to the named file and range)";

/** 标识符提取停用词：语言关键字与泛用词，保留业务标识符。 */
const STOP_WORDS = new Set([
  "the", "and", "with", "from", "this", "that", "using", "use", "used",
  "file", "files", "code", "function", "functions", "class", "classes",
  "method", "methods", "type", "types", "string", "number", "boolean",
  "object", "array", "value", "values", "true", "false", "null", "undefined",
  "import", "export", "const", "return", "returns", "error", "result",
  "results", "name", "names", "path", "paths", "line", "lines", "make",
  "get", "set", "new", "one", "two", "all", "any", "some", "into", "over",
  "when", "then", "than", "your", "you", "are", "for", "not", "but", "has",
  "have", "had", "was", "were", "will", "would", "should", "could",
]);

/**
 * 从任务/用户文本提取索引导航标识符：引号串（用户常直接引用符号名或
 * 路径片段）优先，再补驼峰/蛇形/点分限定名。去停用词、去重、上限 8。
 */
export function extractNavigationIdentifiers(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/["'`]([^"'`\n]{3,80})["'`]/g)) {
    const s = m[1]!.trim();
    if (s.length >= 3) found.add(s);
  }
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g)) {
    found.add(m[0]!);
  }
  return [...found].filter((id) => {
    if (id.length < 3 || id.length > 80) return false;
    if (/^\d/.test(id)) return false;
    if (!/[A-Za-z]/.test(id)) return false;
    return !STOP_WORDS.has(id.toLowerCase());
  }).slice(0, MAX_IDENTIFIERS);
}

/** 语义路：端口缺失/异常一律空数组（消费方降级关键词路）。 */
async function semanticHits(
  index: IndexClient,
  query: string,
): Promise<RagHit[]> {
  if (!index.ragSearch) return [];
  try {
    const hits = await index.ragSearch(query, SEMANTIC_TOP_K);
    return Array.isArray(hits)
      ? hits.filter((hit) => Number.isFinite(hit.score) && hit.score >= MIN_SEMANTIC_SCORE)
      : [];
  } catch {
    return [];
  }
}

/** 关键词路：单标识符查询失败不拖垮其余（best-effort）。 */
async function keywordHits(
  index: IndexClient,
  query: string,
): Promise<SymbolSearchResult[]> {
  if (!index.ftsSearch) return [];
  const identifiers = extractNavigationIdentifiers(query);
  if (identifiers.length === 0) return [];
  const out: SymbolSearchResult[] = [];
  for (const id of identifiers) {
    try {
      const hits = await index.ftsSearch(id, { limit: FTS_LIMIT });
      if (Array.isArray(hits)) out.push(...hits);
    } catch {
      // 单个查询失败跳过
    }
  }
  return out;
}

/** 取 chunk 文本的第 2-3 行（signature/doc）作单行预览。 */
function chunkPreview(content: string): string | undefined {
  const lines = content.split("\n").slice(1, 3).filter((l) => l.trim());
  if (lines.length === 0) return undefined;
  const one = lines.join(" ").trim();
  return one ? `: ${one.slice(0, PREVIEW_CHARS)}` : undefined;
}

/**
 * hybrid 导航查询：语义路优先、关键词路补充，按文件聚合。
 * 返回 undefined = 双路皆空（调用方跳过注入，行为与现状逐字一致）。
 */
export async function queryIndexNavigation(
  index: IndexClient | undefined,
  query: string,
): Promise<NavigationFileHit[] | undefined> {
  if (!index) return undefined;
  const queryKey = query.trim().slice(0, RECALL_QUERY_MAX_CHARS);
  const now = Date.now();
  let memo = navigationMemo.get(index);
  if (!memo) {
    memo = new Map();
    navigationMemo.set(index, memo);
  }
  const cached = memo.get(queryKey);
  if (cached && cached.expiresAt > now) return cached.hits;
  const [semantic, keyword] = await Promise.all([
    semanticHits(index, query),
    keywordHits(index, query),
  ]);

  const byPath = new Map<string, NavigationFileHit>();
  const pushSymbol = (entry: NavigationFileHit, sym: NavigationSymbolHit): void => {
    if (entry.symbols.length >= MAX_SYMBOLS_PER_FILE) return;
    if (entry.symbols.some((s) => s.name === sym.name)) return;
    entry.symbols.push(sym);
  };

  // 语义路先入组：RagHit 无 kind 列，名称取 qualified_name。
  for (const hit of semantic) {
    if (!hit?.filePath) continue;
    let entry = byPath.get(hit.filePath);
    if (!entry) {
      entry = { path: hit.filePath, symbols: [], semantic: true };
      byPath.set(hit.filePath, entry);
    }
    pushSymbol(entry, {
      name: hit.symbol || hit.filePath,
      line: hit.startLine,
      endLine: hit.endLine,
      preview: chunkPreview(hit.content),
    });
  }

  // 关键词路补充：语义已覆盖的文件填行号（preview 带签名），其余新文件排后。
  for (const r of keyword) {
    if (!r?.path || !r.name) continue;
    let entry = byPath.get(r.path);
    if (!entry) {
      entry = { path: r.path, symbols: [] };
      byPath.set(r.path, entry);
    }
    pushSymbol(entry, {
      name: r.name,
      kind: r.kind,
      line: r.line,
      endLine: r.endLine,
      preview: r.signature ? `: ${r.signature.slice(0, PREVIEW_CHARS)}` : undefined,
    });
  }

  const hits = byPath.size === 0
    ? undefined
    : [...byPath.values()]
      .sort(
        (a, b) =>
          Number(b.semantic === true) - Number(a.semantic === true) ||
          b.symbols.length - a.symbols.length,
      )
      .slice(0, MAX_FILES);
  memo.set(queryKey, { expiresAt: now + NAVIGATION_MEMO_TTL_MS, hits });
  while (memo.size > 64) memo.delete(memo.keys().next().value!);
  return hits;
}

/**
 * 从任务分解结果构造召回查询（Cursor 式 auto-context 的查询面）。
 *
 * 分解结果本身就是 LLM 对用户意图的一次结构化理解（intent + 各任务
 * description/prompt），语义路直接吃这层自然语言；同时保留用户原文，
 * 兜住分解丢掉的措辞细节。纯提取、无额外 LLM 调用——分解已经付过
 * "理解"这一次成本，二次调用只加延迟不加信息。
 */
export function buildTaskRecallQuery(
  task: { description?: string; prompt?: string; title?: string },
  userMessage = "",
): string {
  const taskText = (task.prompt ?? task.description ?? task.title ?? "").trim();
  if (!taskText) return "";
  // Keep the task as the dominant signal. Only carry identifiers that occur in
  // both the task and the original request; never import sibling-task terms.
  const taskIdentifiers = new Set(extractNavigationIdentifiers(taskText));
  const supplemental = extractNavigationIdentifiers(userMessage)
    .filter((identifier) => taskIdentifiers.has(identifier))
    .join(" ");
  return `${taskText}${supplemental ? `\n${supplemental}` : ""}`.slice(0, RECALL_QUERY_MAX_CHARS);
}

export function buildDecompositionRecallQuery(
  rawDecompose: {
    intent: string;
    tasks?: Array<{ id?: string; description?: string; prompt?: string; title?: string }>;
  } | undefined,
  userMessage: string,
): string {
  const parts: string[] = [];
  const intent = rawDecompose?.intent?.trim();
  if (intent) parts.push(intent);
  for (const t of rawDecompose?.tasks ?? []) {
    const desc = (t.description ?? "").trim();
    const prompt = (t.prompt ?? "").trim();
    const title = (t.title ?? "").trim();
    // prompt 是分解器给任务的完整执行指令，信息密度最高；description 次之。
    const text = prompt || desc || title;
    if (text) parts.push(text);
  }
  const raw = userMessage.trim();
  if (raw) parts.push(raw);
  if (parts.length === 0) return "";
  return parts.join("\n").slice(0, RECALL_QUERY_MAX_CHARS);
}

/**
 * 分解驱动的代码召回：从分解结果提取查询 → hybrid 检索 → 渲染为
 * 每步注入的召回块。返回 undefined = 无可用索引/双路皆空（调用方跳过）。
 *
 * 消费方：execute_tools 阶段（分解完成后一次召回，块注入 react 循环
 * 每一步与任务图节点 prompt——否则召回结果只在回合起点出现一次，
 * 随对话轮推进被挤到尾部，失去"每步可见"的意义）。
 */
export async function buildTaskRecallBlock(
  index: IndexClient | undefined,
  task: { description?: string; prompt?: string; title?: string },
  userMessage: string,
): Promise<string | undefined> {
  if (!index) return undefined;
  const query = buildTaskRecallQuery(task, userMessage);
  if (!query) return undefined;
  const hits = await queryIndexNavigation(index, query);
  if (!hits || hits.length === 0) return undefined;
  return renderNavigationBlock(RECALL_HEADING, hits.slice(0, 3));
}

export async function buildRecallBlock(
  index: IndexClient | undefined,
  rawDecompose: {
    intent: string;
    tasks?: Array<{ id?: string; description?: string; prompt?: string; title?: string }>;
  } | undefined,
  userMessage: string,
): Promise<string | undefined> {
  // A request-level recall is retained only for callers without task scopes.
  // Task graph callers should use buildTaskRecallBlock for scope isolation.
  if (!index) return undefined;
  const query = buildDecompositionRecallQuery(rawDecompose, userMessage);
  if (!query) return undefined;
  const hits = await queryIndexNavigation(index, query);
  if (!hits || hits.length === 0) return undefined;
  return renderNavigationBlock(RECALL_HEADING, hits.slice(0, 3));
}

function formatSymbolLine(hit: NavigationFileHit, sym: NavigationSymbolHit): string {
  const range = sym.endLine && sym.endLine > sym.line ? `${sym.line}-${sym.endLine}` : `${sym.line}`;
  const kind = sym.kind ? ` ${sym.kind}` : "";
  return `- \`${hit.path}:${range}\`${kind} ${sym.name}${sym.preview ?? ""}`;
}

/**
 * 渲染导航块（两个消费者共用）：`- \`path:line\` kind name : 摘录`。
 * 总长硬上限 MAX_BLOCK_CHARS，超限截断（保留已渲染行）。
 */
export function renderNavigationBlock(heading: string, hits: NavigationFileHit[]): string {
  const lines: string[] = [heading];
  let total = heading.length;
  for (const hit of hits) {
    for (const sym of hit.symbols) {
      const line = formatSymbolLine(hit, sym);
      if (total + line.length + 1 > MAX_BLOCK_CHARS) return lines.join("\n");
      lines.push(line);
      total += line.length + 1;
    }
  }
  return lines.join("\n");
}
