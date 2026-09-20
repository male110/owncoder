// ── Structured Error Codes ────────────────────────────────────────────────────
//
// Every error that crosses the IPC bridge carries one of these codes so the
// renderer can make routing decisions (show settings, show retry, etc.) without
// string-matching on localised messages.

export const ErrorCode = {
  // Auth / configuration
  AUTH_MISSING_KEY:       "AUTH_MISSING_KEY",
  AUTH_INVALID_KEY:       "AUTH_INVALID_KEY",
  AUTH_RATE_LIMITED:      "AUTH_RATE_LIMITED",

  // Network
  NET_UNREACHABLE:        "NET_UNREACHABLE",
  NET_TIMEOUT:            "NET_TIMEOUT",

  // Workspace
  WS_NOT_OPEN:            "WS_NOT_OPEN",
  WS_PATH_ESCAPE:         "WS_PATH_ESCAPE",
  WS_WRITE_DENIED:        "WS_WRITE_DENIED",

  // Session / plan
  SESSION_NO_MESSAGE:     "SESSION_NO_MESSAGE",
  PLAN_NOT_FOUND:         "PLAN_NOT_FOUND",
  PLAN_ALREADY_APPROVED:  "PLAN_ALREADY_APPROVED",

  // LLM / agent
  LLM_CONTEXT_OVERFLOW:   "LLM_CONTEXT_OVERFLOW",
  LLM_INVALID_RESPONSE:   "LLM_INVALID_RESPONSE",

  // Generic fallback
  UNKNOWN:                "UNKNOWN",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Structured error envelope used across the IPC boundary. */
export interface AppError {
  code: ErrorCode;
  /** Human-readable message (may be in Chinese for display). */
  message: string;
  /** Raw technical detail, if any (English stack / provider message). */
  detail?: string;
}

/** Classify a raw error string/object into a structured AppError. */
export function classifyError(raw: unknown): AppError {
  const text = raw instanceof Error ? raw.message : String(raw ?? "Unknown error");
  const lower = text.toLowerCase();

  if (lower.includes("401") || lower.includes("invalid_api_key") || lower.includes("unauthorized")) {
    return { code: ErrorCode.AUTH_INVALID_KEY, message: "API Key 无效或已过期，请在设置中更新。", detail: text };
  }
  if (lower.includes("api key") || lower.includes("未配置 llm") || lower.includes("未提供令牌") || lower.includes("no api key")) {
    return { code: ErrorCode.AUTH_MISSING_KEY, message: "模型 API Key 未配置，请在「设置 → 模型」中填写。", detail: text };
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { code: ErrorCode.AUTH_RATE_LIMITED, message: "请求过于频繁，已触发限速，请稍后再试。", detail: text };
  }
  if (lower.includes("fetch failed") || lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("network")) {
    return { code: ErrorCode.NET_UNREACHABLE, message: "无法连接模型服务，请检查 Base URL 和网络连接。", detail: text };
  }
  if (lower.includes("timeout") || lower.includes("etimedout") || lower.includes("abort")) {
    return { code: ErrorCode.NET_TIMEOUT, message: "请求超时，模型服务响应过慢。", detail: text };
  }
  if (lower.includes("请先打开项目") || lower.includes("no workspace")) {
    return { code: ErrorCode.WS_NOT_OPEN, message: "请先打开一个项目文件夹。", detail: text };
  }
  if (lower.includes("path escapes workspace") || lower.includes("write denied") || lower.includes("write policy")) {
    return { code: ErrorCode.WS_WRITE_DENIED, message: "写入被拒绝：目标路径超出工作区范围或违反写入策略。", detail: text };
  }
  if (lower.includes("context length") || lower.includes("maximum context") || lower.includes("too long")) {
    return { code: ErrorCode.LLM_CONTEXT_OVERFLOW, message: "上下文超出模型限制，请使用 /compact 压缩历史后再试。", detail: text };
  }

  return { code: ErrorCode.UNKNOWN, message: text.length > 200 ? `${text.slice(0, 200)}…` : text, detail: text.length > 200 ? text : undefined };
}

/** Serialize an AppError to a string for transport over IPC (plain JSON). */
export function serializeError(err: AppError): string {
  return JSON.stringify(err);
}

/** Deserialize: if the string is a valid AppError JSON, return it; otherwise classify the raw string. */
export function deserializeError(raw: string): AppError {
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === "string" && typeof parsed.message === "string") {
      return parsed as AppError;
    }
  } catch {
    // not JSON – fall through
  }
  return classifyError(raw);
}

// ─────────────────────────────────────────────────────────────────────────────

export type AgentMode = "plan" | "agent";

export type WritePolicy = "balanced" | "strict" | "loose";

export type IndexStatusKind = "idle" | "building" | "ready" | "error";

export interface IndexStatus {
  kind: IndexStatusKind;
  root?: string;
  percent?: number;
  message?: string;
  fileCount?: number;
  tagCount?: number;
}

export interface Tag {
  path: string;
  name: string;
  kind: string;
  line: number;
  endLine?: number;
}

export interface MapOpts {
  mapTokens: number;
  mentionedPaths?: string[];
  writablePaths?: string[];
}

export interface WorkspaceInfo {
  root: string;
  name: string;
}
