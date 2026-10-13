import type { ChatChoiceMessage, ChatResponse, ToolCall, ToolDef } from "../types.js";
import type { ThinkingEffort } from "../thinking.js";
import type {
  ListedModel,
  ProtocolCodec,
  ProtocolEncodeInput,
  StreamHandlers,
  StreamParser,
} from "./types.js";
import { normalizeApiBaseUrl } from "./url.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 16384;
const CONTINUE_PLACEHOLDER = "(continue)";

const THINKING_BUDGET: Record<string, number> = {
  low: 2048,
  minimal: 2048,
  medium: 8192,
  high: 16384,
  max: 32768,
};

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "thinking"; thinking: string };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
};

type AnthropicRequest = {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: "auto" | "none" };
  temperature?: number;
  stream?: boolean;
  thinking?: { type: "enabled"; budget_tokens: number };
};

function sanitizeToolUseId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "tool_use";
}

function parseToolArguments(raw: string | undefined): unknown {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

function textBlock(text: string): AnthropicContentBlock {
  return { type: "text", text };
}

function mergeSameRole(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    const last = out[out.length - 1];
    if (last && last.role === msg.role) {
      last.content.push(...msg.content);
    } else {
      out.push({ role: msg.role, content: [...msg.content] });
    }
  }
  return out;
}

function ensureUserBookends(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out = [...messages];
  if (out.length === 0 || out[0]!.role !== "user") {
    out.unshift({ role: "user", content: [textBlock(CONTINUE_PLACEHOLDER)] });
  }
  if (out[out.length - 1]!.role !== "user") {
    out.push({ role: "user", content: [textBlock(CONTINUE_PLACEHOLDER)] });
  }
  return out;
}

export function encodeAnthropicMessages(input: ProtocolEncodeInput): AnthropicRequest {
  const systemParts: string[] = [];
  const pendingToolResults: AnthropicContentBlock[] = [];
  const rawMessages: AnthropicMessage[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    rawMessages.push({ role: "user", content: [...pendingToolResults] });
    pendingToolResults.length = 0;
  };

  for (const msg of input.messages) {
    if (msg.role === "system") {
      const text = (msg.content ?? "").trim();
      if (text) systemParts.push(text);
      continue;
    }
    if (msg.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: sanitizeToolUseId(msg.tool_call_id || msg.name || "tool_use"),
        content: msg.content ?? "",
        ...(msg.is_error === undefined ? {} : { is_error: msg.is_error }),
      });
      continue;
    }
    flushToolResults();
    if (msg.role === "user") {
      const blocks: AnthropicContentBlock[] = [];
      if (msg.content) blocks.push(textBlock(msg.content));
      for (const attachment of msg.attachments ?? []) {
        if (attachment.mimeType.toLowerCase().startsWith("image/")) {
          // 检查是否为 data URI (data:image/png;base64,...)
          const dataUriMatch = /^data:([^;]+);base64,(.+)$/.exec(attachment.url);
          if (dataUriMatch) {
            // 提取 base64 数据
            const base64Data = dataUriMatch[2];
            blocks.push({ 
              type: "image", 
              source: { type: "base64", media_type: attachment.mimeType, data: base64Data } 
            });
          } else if (/^https?:\/\//i.test(attachment.url)) {
            // HTTP URL：Anthropic API 不支持，提示需要预处理
            blocks.push(textBlock(`[图片需要预处理] ${attachment.name} (${attachment.mimeType}): Anthropic API 要求 base64 格式，请先将图片转换为 data URI。URL: ${attachment.url}`));
          } else {
            // 其他情况（如本地文件路径）
            blocks.push(textBlock(`[图片附件] ${attachment.name} (${attachment.mimeType}): ${attachment.url}`));
          }
        } else {
          blocks.push(textBlock(`[文件附件] ${attachment.name} (${attachment.mimeType || "application/octet-stream"}): ${attachment.url}`));
        }
      }
      if (blocks.length === 0) blocks.push(textBlock(""));
      rawMessages.push({ role: "user", content: blocks });
      continue;
    }
    // assistant
    const blocks: AnthropicContentBlock[] = [];
    if (msg.content) blocks.push(textBlock(msg.content));
    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: sanitizeToolUseId(tc.id),
          name: tc.function.name,
          input: parseToolArguments(tc.function.arguments),
        });
      }
    }
    if (blocks.length === 0) blocks.push(textBlock(""));
    rawMessages.push({ role: "assistant", content: blocks });
  }
  flushToolResults();

  const messages = ensureUserBookends(mergeSameRole(rawMessages));

  let maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const thinking = encodeThinking(input.thinking?.effort);
  if (thinking && maxTokens <= thinking.budget_tokens) {
    maxTokens = thinking.budget_tokens + 4096;
  }

  const body: AnthropicRequest = {
    model: input.model,
    max_tokens: maxTokens,
    messages,
    stream: input.stream,
  };

  if (systemParts.length > 0) {
    body.system = systemParts.join("\n\n");
  }

  if (input.tools?.length) {
    body.tools = input.tools.map(encodeToolDef);
    body.tool_choice = { type: "auto" };
  }

  // Official API rejects temperature when extended thinking is enabled.
  if (thinking) {
    body.thinking = thinking;
  } else if (input.temperature !== undefined) {
    body.temperature = input.temperature;
  } else {
    body.temperature = 0.2;
  }

  return body;
}

function encodeToolDef(tool: ToolDef): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
} {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters ?? { type: "object", properties: {} },
  };
}

function encodeThinking(
  effort: ThinkingEffort | undefined,
): { type: "enabled"; budget_tokens: number } | undefined {
  if (!effort) return undefined;
  if (effort === "none" || effort === "off" || effort === "disabled") return undefined;
  const budget = THINKING_BUDGET[effort] ?? THINKING_BUDGET.high!;
  return { type: "enabled", budget_tokens: budget };
}

function mapStopReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "end_turn" || reason === "stop_sequence" || reason === "pause_turn") return "stop";
  return reason;
}

function mapUsage(usage: unknown): ChatResponse["usage"] | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as { input_tokens?: number; output_tokens?: number };
  const prompt = u.input_tokens;
  const completion = u.output_tokens;
  if (prompt === undefined && completion === undefined) return undefined;
  const total =
    typeof prompt === "number" && typeof completion === "number" ? prompt + completion : undefined;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
}

function anthropicErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (!trimmed || trimmed === "[DONE]") return fallback;
    try {
      return anthropicErrorMessage(JSON.parse(trimmed), trimmed);
    } catch {
      return trimmed;
    }
  }
  if (data && typeof data === "object") {
    const raw = data as { error?: unknown; message?: unknown };
    const err = raw.error;
    if (typeof err === "string" && err.trim()) return err;
    if (err && typeof err === "object") {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === "string" && msg.trim()) return msg;
    }
    if (typeof raw.message === "string" && raw.message.trim()) return raw.message;
  }
  return fallback;
}

export function decodeAnthropicResponse(json: unknown): ChatResponse {
  if (json == null || typeof json !== "object") {
    throw new Error("Anthropic response is empty or not JSON");
  }
  const raw = json as {
    type?: string;
    error?: unknown;
    message?: unknown;
    id?: string;
    content?: Array<{
      type?: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
    stop_reason?: string | null;
    usage?: unknown;
  };
  if (raw.type === "error" || raw.error) {
    throw new Error(anthropicErrorMessage(raw, "Anthropic API error"));
  }
  if (!Array.isArray(raw.content)) {
    throw new Error("Anthropic response is missing content");
  }
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const tool_calls: ToolCall[] = [];

  for (const block of raw.content) {
    if (block.type === "text" && typeof block.text === "string") {
      contentParts.push(block.text);
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      reasoningParts.push(block.thinking);
    } else if (block.type === "tool_use") {
      tool_calls.push({
        id: block.id || `call_${tool_calls.length}`,
        type: "function",
        function: {
          name: block.name || "unknown",
          arguments: stringifyToolInput(block.input),
        },
      });
    }
  }

  const message: ChatChoiceMessage = {
    role: "assistant",
    content: contentParts.length > 0 ? contentParts.join("") : null,
    reasoning_content: reasoningParts.length > 0 ? reasoningParts.join("") : null,
    tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
  };

  return {
    id: raw.id,
    usage: mapUsage(raw.usage),
    choices: [{ message, finish_reason: mapStopReason(raw.stop_reason) }],
  };
}

class AnthropicStreamParser implements StreamParser {
  private content = "";
  private reasoningContent = "";
  private readonly toolAcc = new Map<number, { id?: string; name?: string; arguments: string }>();
  private finishReason: string | null = null;
  private usage: ChatResponse["usage"];
  private id: string | undefined;
  private currentIndex = -1;
  private currentType: string | null = null;

  constructor(private readonly handlers: StreamHandlers) {}

  feed(event: { event?: string; data: string }): boolean {
    const data = event.data;
    if (event.event === "error") {
      throw new Error(anthropicErrorMessage(data, "Anthropic stream error"));
    }
    if (!data || data === "[DONE]") return false;
    let payload: {
      type?: string;
      error?: unknown;
      message?:
        | string
        | {
            id?: string;
            usage?: unknown;
            content?: unknown[];
            stop_reason?: string | null;
          };
      index?: number;
      content_block?: {
        type?: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: unknown;
      };
      delta?: {
        type?: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
        stop_reason?: string | null;
        usage?: unknown;
      };
      usage?: unknown;
    };
    try {
      payload = JSON.parse(data) as typeof payload;
    } catch {
      return false;
    }

    const type = event.event || payload.type;
    if (type === "error" || payload.error) {
      throw new Error(anthropicErrorMessage(payload, "Anthropic stream error"));
    }
    if (!type || type === "ping") return false;

    if (type === "message_start") {
      const message = typeof payload.message === "object" && payload.message ? payload.message : undefined;
      this.id = message?.id;
      const usage = mapUsage(message?.usage);
      if (usage) this.usage = usage;
      return true;
    }

    if (type === "content_block_start") {
      this.currentIndex = payload.index ?? this.currentIndex + 1;
      this.currentType = payload.content_block?.type ?? null;
      if (this.currentType === "tool_use") {
        this.toolAcc.set(this.currentIndex, {
          id: payload.content_block?.id,
          name: payload.content_block?.name,
          arguments:
            payload.content_block?.input && Object.keys(payload.content_block.input as object).length > 0
              ? stringifyToolInput(payload.content_block.input)
              : "",
        });
      }
      return true;
    }

    if (type === "content_block_delta") {
      const delta = payload.delta;
      if (!delta) return false;
      let progressed = false;
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        this.content += delta.text;
        this.handlers.onDelta?.(this.content);
        progressed = true;
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
        this.reasoningContent += delta.thinking;
        this.handlers.onThinkingDelta?.(this.reasoningContent);
        progressed = true;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const idx = payload.index ?? this.currentIndex;
        let acc = this.toolAcc.get(idx);
        if (!acc) {
          acc = { arguments: "" };
          this.toolAcc.set(idx, acc);
        }
        acc.arguments += delta.partial_json;
        progressed = true;
      }
      return progressed;
    }

    if (type === "content_block_stop") {
      this.currentType = null;
      return false;
    }

    if (type === "message_delta") {
      if (payload.delta?.stop_reason) {
        this.finishReason = mapStopReason(payload.delta.stop_reason);
      }
      const usage = mapUsage(payload.usage ?? payload.delta?.usage);
      if (usage) {
        this.usage = {
          ...this.usage,
          ...Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined)),
        };
      }
      return Boolean(payload.delta?.stop_reason || usage);
    }

    if (type === "message_stop") {
      return true;
    }
    return false;
  }

  finish(): ChatResponse {
    const tool_calls: ToolCall[] | undefined =
      this.toolAcc.size > 0
        ? [...this.toolAcc.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([i, t], n) => ({
              id: t.id || `call_stream_${i}_${n}`,
              type: "function" as const,
              function: {
                name: t.name || "unknown",
                arguments: t.arguments || "{}",
              },
            }))
        : undefined;

    if (!this.content && !this.reasoningContent && !tool_calls && !this.finishReason) {
      throw new Error("empty stream");
    }

    const message: ChatChoiceMessage = {
      role: "assistant",
      content: this.content || null,
      reasoning_content: this.reasoningContent || null,
      tool_calls,
    };

    return {
      id: this.id,
      choices: [{ message, finish_reason: this.finishReason }],
      usage: this.usage,
    };
  }
}

function looksLikeStreamUnsupported(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("streaming is not supported") ||
    lower.includes("stream is not supported") ||
    lower.includes('"stream" is not allowed') ||
    (lower.includes("stream") && lower.includes("not supported"))
  );
}

export const anthropicMessagesCodec: ProtocolCodec = {
  format: "anthropic-messages",

  buildUrl(baseUrl: string): string {
    return new URL("messages", normalizeApiBaseUrl(baseUrl)).toString();
  },

  buildHeaders(apiKey: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    return headers;
  },

  async encodeRequest(input: ProtocolEncodeInput): Promise<unknown> {
    return await encodeAnthropicMessages(input);
  },

  decodeResponse(json: unknown): ChatResponse {
    return decodeAnthropicResponse(json);
  },

  createStreamParser(handlers: StreamHandlers): StreamParser {
    return new AnthropicStreamParser(handlers);
  },

  shouldFallbackToNonStream(_status: number, body: string): boolean {
    return looksLikeStreamUnsupported(body);
  },

  listModelsUrl(baseUrl: string): string {
    return new URL("models", normalizeApiBaseUrl(baseUrl)).toString();
  },

  listModelsHeaders(apiKey: string | undefined): Record<string, string> {
    return anthropicMessagesCodec.buildHeaders(apiKey);
  },

  parseModelList(json: unknown): ListedModel[] {
    const data = json as {
      data?: Array<{ id: string; display_name?: string; name?: string }>;
    };
    return (data.data ?? []).map((m) => ({
      id: m.id,
      name: m.display_name || m.name || m.id,
    }));
  },
};

export { AnthropicStreamParser };
export type { AnthropicRequest, AnthropicMessage };
