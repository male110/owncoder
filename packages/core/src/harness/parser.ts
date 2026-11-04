import { jsonrepair } from "jsonrepair";
import type { ToolCall } from "@owncoder/llm";

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
}

/**
 * Forgiving tool-call parser for weaker models:
 * - valid OpenAI tool_calls JSON
 * - JSON object / array embedded in text
 * - XML-ish <tool_call> blocks
 * - name({...}) plain patterns
 */
export function parseToolCallsFromAssistant(opts: {
  content?: string | null;
  toolCalls?: ToolCall[];
}): ParsedToolCall[] {
  const out: ParsedToolCall[] = [];

  if (opts.toolCalls?.length) {
    for (const tc of opts.toolCalls) {
      out.push({
        id: tc.id || `call_${out.length + 1}`,
        name: tc.function.name,
        arguments: softParseArgs(tc.function.arguments),
        rawArguments: tc.function.arguments ?? "",
      });
    }
    if (out.length) return out;
  }

  const text = opts.content ?? "";
  if (!text.trim()) return out;

  // ```json tool call blocks
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    const parsed = tryParseToolPayload(m[1] ?? "");
    for (const p of parsed) out.push(p);
  }
  if (out.length) return dedupe(out);

  // <tool_call name="x">{"a":1}</tool_call>
  const xml =
    /<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/gi;
  while ((m = xml.exec(text))) {
    out.push({
      id: `call_${out.length + 1}`,
      name: m[1]!,
      arguments: softParseArgs(m[2] ?? "{}"),
      rawArguments: (m[2] ?? "").trim(),
    });
  }
  if (out.length) return dedupe(out);

  // tool_name({ ... })
  const callRe = /\b([a-zA-Z_][\w]*)\s*\(\s*(\{[\s\S]*?\})\s*\)/g;
  while ((m = callRe.exec(text))) {
    const name = m[1]!;
    if (["if", "for", "while", "switch", "function", "return"].includes(name)) continue;
    out.push({
      id: `call_${out.length + 1}`,
      name,
      arguments: softParseArgs(m[2] ?? "{}"),
      rawArguments: m[2] ?? "{}",
    });
  }

  return dedupe(out);
}

function tryParseToolPayload(raw: string): ParsedToolCall[] {
  const trimmed = raw.trim();
  try {
    const data = JSON.parse(trimmed) as unknown;
    return normalizePayload(data);
  } catch {
    try {
      return normalizePayload(JSON.parse(jsonrepair(trimmed)));
    } catch {
      return [];
    }
  }
}

function normalizePayload(data: unknown): ParsedToolCall[] {
  const items = Array.isArray(data) ? data : [data];
  const out: ParsedToolCall[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = extractName(obj);
    if (!name) continue;
    let args: unknown =
      obj.arguments ??
      obj.args ??
      obj.parameters ??
      (obj.function && typeof obj.function === "object"
        ? (obj.function as { arguments?: unknown }).arguments
        : undefined) ??
      {};
    if (typeof args === "string") args = softParseArgs(args);
    const argsObj: Record<string, unknown> =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    out.push({
      id: typeof obj.id === "string" ? obj.id : `call_${out.length + 1}`,
      name,
      arguments: argsObj,
      rawArguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    });
  }
  return out;
}

function extractName(obj: Record<string, unknown>): string {
  if (typeof obj.name === "string" && obj.name) return obj.name;
  if (typeof obj.tool === "string" && obj.tool) return obj.tool;
  if (obj.function && typeof obj.function === "object") {
    const n = (obj.function as { name?: unknown }).name;
    if (typeof n === "string" && n) return n;
  }
  return "";
}

export function softParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  const text = raw.trim();

  // 1. Standard JSON parse (fast path)
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { value: v };
  } catch {
    // fall through
  }

  // 1.5. Truncation detection — MUST run before jsonrepair.
  //      jsonrepair's whole job is closing unterminated strings and brackets, so
  //      a payload cut off mid-`content` gets "repaired" into a perfectly valid
  //      object holding only the first N% of the file body — with no trace that
  //      anything is missing. write_file would then overwrite the whole file
  //      with that fragment and report success. Capture the evidence here, while
  //      the raw text still has it, and carry the flag onto whatever we recover.
  const truncated = looksTruncatedJson(text);

  // 2. jsonrepair: handles unquoted keys, raw newlines in strings, trailing
  //    commas, missing brackets, code-fenced content, etc. — covers all the
  //    malformed patterns produced by weaker LLMs.
  try {
    const v = JSON.parse(jsonrepair(text)) as unknown;
    const obj =
      v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : { value: v };
    return truncated ? { ...obj, _truncated: true } : obj;
  } catch {
    // fall through
  }

  // 2.5. Truncated-JSON rescue: when content/patch is very long the JSON gets
  //      cut off mid-string. jsonrepair may then mangle or drop the leading
  //      `path` field. Extract it directly from the raw prefix before giving up.
  // We tag the result with `_truncated: true` so callers (toolWrite/toolPatch)
  // can surface a truncation-specific error instead of a generic "empty content" one.
  const pathRescue = rescuePathField(text);
  if (pathRescue) return { ...pathRescue, _truncated: true };

  // 3. Last-resort: rescue at least single-line fields like `path` / `name`
  //    so callers always get something actionable.
  const recovered = extractSingleLineStringFields(text);
  if (recovered) return truncated ? { ...recovered, _truncated: true } : recovered;

  return { raw: text };
}

/**
 * True when a tool-call argument payload was cut off mid-flight (the model hit
 * its output-token limit part-way through a long `content` / `patch` field).
 *
 * Scans the raw text tracking string and escape state plus bracket depth;
 * anything still open when the text ends means the payload is incomplete. Only
 * meaningful on text that already failed a strict `JSON.parse`, and only
 * meaningful BEFORE jsonrepair runs — repair closes exactly these holes.
 */
function looksTruncatedJson(text: string): boolean {
  const issue = scanUnterminatedString(text);
  return issue !== null;
}

/**
 * 轻量级语法预检：扫描原始文本，检测未闭合的字符串引号与括号不匹配。
 *
 * 与 looksTruncatedJson 的区别：后者只回答"是否截断"（布尔值），本函数
 * 返回结构化的诊断信息——问题类型、位置（行/列）、问题点附近的原文片段，
 * 供调用方生成"包含具体位置和修复建议"的错误提示。
 *
 * 扫描规则（与 JSON/JS 公共子集一致）：
 * - 双引号字符串：跟踪转义（\ 跳过下一字符）
 * - 单引号字符串：同样跟踪转义（JS 允许，弱模型常混用）
 * - 模板字符串：`...`，同样跟踪转义
 * - 正则字面量：/.../，跟踪转义；前一个非空白字符不是 ) ] } 或
 *   标识符/数字时，/ 视为正则开始而非除法（避免把 /^\.\// 结尾的
 *   // 误判为行注释——那会吞掉整行剩余字符，导致括号栈残留并误报
 *   后续合法的闭括号）
 * - 括号深度：{ } [ ] ( ) 配对；深度为负说明有多余的闭括号
 * - 行注释（双斜杠）与块注释（斜杠星号…星号斜杠）内的引号/括号不计
 *
 * 返回 null 表示未发现结构性问题；否则返回诊断对象。
 * 注意：这是启发式预检，不替代真正的解析器——只用于在把载荷交给
 * jsonrepair / vm.Script 之前拦截明显的截断与引号错乱。
 */
export function scanUnterminatedString(text: string): {
  kind: "unterminated_string" | "unclosed_bracket" | "extra_closer";
  /** 问题点在原文中的字符偏移（0-based）。 */
  index: number;
  /** 问题点所在行（1-based）。 */
  line: number;
  /** 问题点所在列（1-based）。 */
  column: number;
  /** 问题点附近的原文片段（含前后上下文，便于定位）。 */
  snippet: string;
  /** 人类可读的问题描述。 */
  detail: string;
} | null {
  let inString: '"' | "'" | "`" | null = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let inRegex = false;
  const stack: Array<{ ch: string; line: number; column: number; index: number }> = [];
  let line = 1;
  let lineStart = 0;

  const snippetAround = (idx: number): string => {
    const start = Math.max(0, idx - 30);
    const end = Math.min(text.length, idx + 30);
    return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  };

  // 判断位置 i 的 "/" 是正则开始还是除号：前一个非空白字符若是
  // ) ] } 或标识符/数字，则为除法；否则（行首、运算符后、( [ , = : 等
  // 之后）为正则开始。
  const slashStartsRegex = (i: number): boolean => {
    for (let j = i - 1; j >= 0; j--) {
      const p = text[j]!;
      if (p === " " || p === "\t" || p === "\n" || p === "\r") continue;
      return !/[)\]\}\w$]/.test(p);
    }
    return true;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") {
      line++;
      lineStart = i + 1;
      if (inLineComment) inLineComment = false;
      continue;
    }
    if (inLineComment) continue;
    if (inBlockComment) {
      if (ch === "*" && text[i + 1] === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inRegex) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "/") {
        inRegex = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    // 非字符串、非注释状态
    if (ch === "/" && text[i + 1] === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "/" && slashStartsRegex(i)) {
      inRegex = true;
      escaped = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      stack.push({ ch, line, column: i - lineStart + 1, index: i });
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      const expected = ch === "}" ? "{" : ch === "]" ? "[" : "(";
      const top = stack[stack.length - 1];
      if (top && top.ch === expected) {
        stack.pop();
      } else {
        return {
          kind: "extra_closer",
          index: i,
          line,
          column: i - lineStart + 1,
          snippet: snippetAround(i),
          detail: `多余的闭括号 \`${ch}\`（第 ${line} 行第 ${i - lineStart + 1} 列）没有与之配对的开括号`,
        };
      }
    }
  }

  if (inString) {
    return {
      kind: "unterminated_string",
      index: text.length,
      line,
      column: text.length - lineStart + 1,
      snippet: snippetAround(text.length),
      detail: `字符串以 ${inString} 开头但从未闭合——载荷在字符串中间被截断，或字符串内含有未转义的 ${inString}`,
    };
  }
  if (stack.length) {
    const top = stack[stack.length - 1]!;
    return {
      kind: "unclosed_bracket",
      index: top.index,
      line: top.line,
      column: top.column,
      snippet: snippetAround(top.index),
      detail: `开括号 \`${top.ch}\`（第 ${top.line} 行第 ${top.column} 列）没有闭合——载荷在括号配对完成前被截断`,
    };
  }
  return null;
}

/**
 * Last-resort recovery of single-line `"key":"value"` string fields from a
 * string that even jsonrepair cannot fix (extremely rare).  Only used as a
 * final fallback so short fields like `path`/`name` are never silently lost.
 */
function extractSingleLineStringFields(text: string): Record<string, unknown> | null {
  const obj: Record<string, unknown> = {};
  // 先给无引号的键加引号（弱模型常见错误），仅此一项轻量修复；
  // 不做单引号→双引号全局替换，以免破坏含单引号的多行大字段值。
  const normalized = text.replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":');
  // 双引号值（允许转义；未转义反斜杠由 \\. 兜住，覆盖 Windows 路径如 src\foo\bar.ts）
  const reDouble = /"([A-Za-z_][\w]*)"\s*:\s*"((?:[^"\\\n\r]|\\.)*)"/g;
  // 单引号值（仅单行、值内无单引号；救 path:'src/foo.ts' 这类）
  const reSingle = /"([A-Za-z_][\w]*)"\s*:\s*'([^'\n\r]*)'/g;
  for (const re of [reDouble, reSingle]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalized))) {
      const key = m[1]!;
      if (key in obj) continue;
      try {
        obj[key] = JSON.parse(`"${m[2]!}"`);
      } catch {
        obj[key] = m[2]!;
      }
    }
  }
  return Object.keys(obj).length ? obj : null;
}

/**
 * Rescue the `file_path` field from a truncated JSON tool-call argument string.
 *
 * When `write_file` or `apply_patch` is called with a very long `content` /
 * `patch` the LLM output is cut mid-string. jsonrepair often fails or drops
 * the `file_path` key in that case. This function reads the first few hundred
 * characters of the raw argument string (where `file_path` always appears first)
 * and extracts it with a focused regex — producing at minimum `{ file_path }` so
 * `resolvePathFromReadSet` never has to guess.
 * Also supports legacy `path` field for backward compatibility.
 */
function rescuePathField(text: string): Record<string, unknown> | null {
  // Only look at the first 500 chars — file_path is always the first field.
  const head = text.slice(0, 500);
  // Try file_path first (current standard)
  let m = head.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try {
      const filePath = JSON.parse(`"${m[1]!}"`);
      return typeof filePath === "string" && filePath.trim() ? { file_path: filePath } : null;
    } catch {
      return m[1] ? { file_path: m[1] } : null;
    }
  }
  // Fall back to legacy "path" and convert to file_path
  m = head.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try {
      const path = JSON.parse(`"${m[1]!}"`);
      return typeof path === "string" && path.trim() ? { file_path: path } : null;
    } catch {
      return m[1] ? { file_path: m[1] } : null;
    }
  }
  return null;
}

/**
 * Map weaker-LLM alias tool names to canonical names.
 *
 * Some models output PascalCase or shorthand names (e.g. "Read", "Write",
 * "Edit") that don't match any tool definition. This function normalizes them
 * so they route to the correct built-in tools instead of being silently dropped.
 */
export function normalizeToolName(name: string): string {
  const lower = name.toLowerCase().replace(/[\s.-]+/g, "_");
  // Short aliases that weaker LLMs commonly produce
  switch (lower) {
    case "read":
      return "read_file";
    case "write":
      return "write_file";
    case "edit":
      return "apply_patch";
    case "search":
    case "search_code":
      return "search_symbols";
    case "graph":
      return "graph_search";
    case "save":
    case "save_plan":
      return "save_plan";
    case "shell":
    case "run":
    case "terminal":
      return "bash";
    case "patch":
      return "apply_patch";
    case "append":
      return "append_file";
    case "typecheck":
    case "type_check":
      return "type_check";
    case "ask":
      return "ask_user";
    case "web":
      return "web_search";
    case "fetch":
    case "fetch_url":
    case "web_fetch":
      return "web_fetch";
    case "memory":
    case "remember":
      return "save_memory";
    case "forget":
      return "forget_memory";
    case "memories":
      return "list_memories";
    case "outline":
      return "read_outline";
    case "symbol":
      return "read_symbol";
    case "codemap":
    case "impact":
      return "graph_search";
    case "map":
      return "repo_map";
    case "spec":
      return "save_spec";
    case "design":
      return "save_design";
    case "experience":
      return "save_experience";
    case "analyze":
      return "analyze_issue";
    case "sdd":
      return "list_sdd";
    case "diff":
      return "semantic_diff";
    case "block":
    case "blocker":
      return "report_blocker";
    case "diagnostics":
      return "lsp_diagnostics";
    default:
      // If the name is already canonical (snake_case), return as-is
      return name;
  }
}

function dedupe(calls: ParsedToolCall[]): ParsedToolCall[] {
  const seen = new Set<string>();
  const out: ParsedToolCall[] = [];
  for (const c of calls) {
    const key = `${c.name}:${c.rawArguments}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
