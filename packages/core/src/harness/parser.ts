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
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  // An unterminated string or an unclosed object/array means the tail is gone.
  // Extra closers (depth < 0) are malformed but complete — jsonrepair's job.
  return inString || depth > 0;
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
 * Rescue the `path` field from a truncated JSON tool-call argument string.
 *
 * When `write_file` or `apply_patch` is called with a very long `content` /
 * `patch` the LLM output is cut mid-string. jsonrepair often fails or drops
 * the `path` key in that case. This function reads the first few hundred
 * characters of the raw argument string (where `path` always appears first)
 * and extracts it with a focused regex — producing at minimum `{ path }` so
 * `resolvePathFromReadSet` never has to guess.
 */
function rescuePathField(text: string): Record<string, unknown> | null {
  // Only look at the first 500 chars — path is always the first field.
  const head = text.slice(0, 500);
  // Match: "path" : "value" — value may contain forward-slashes and dots.
  const m = head.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    const path = JSON.parse(`"${m[1]!}"`);
    return typeof path === "string" && path.trim() ? { path } : null;
  } catch {
    return m[1] ? { path: m[1] } : null;
  }
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
    case "list":
    case "ls":
      return "list_dir";
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
    case "git":
      return "git_status";
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
    case "grep":
    case "find":
      return "grep";
    case "codemap":
      return "codemap_search";
    case "impact":
      return "codemap_impact";
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
    case "lsp":
      return "lsp_hover";
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
