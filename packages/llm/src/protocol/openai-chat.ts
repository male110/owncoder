import type { ChatChoiceMessage, ChatResponse, ToolCall } from "../types.js";
import type { ThinkingEffort } from "../thinking.js";
import type {
  ListedModel,
  ProtocolCodec,
  ProtocolEncodeInput,
  StreamHandlers,
  StreamParser,
} from "./types.js";
import { normalizeApiBaseUrl } from "./url.js";

/**
 * 根据模型名构建思考参数
 *
 * 策略：
 * 1. 用户未设置 (effort=undefined) → 返回 null，不传任何参数
 * 2. 用户设置 + 已知模型 → 按厂商适配参数格式
 * 3. 关闭思考 + 未知/Claude 模型 → 不传参数（避免 reasoning_effort 触发 400）
 * 4. 启用思考 + 未知模型 → 尝试 OpenAI 标准 reasoning_effort
 *
 * 支持的模型：
 * - OpenAI: GPT-5, o1, o3
 * - Anthropic: Claude (Opus / Sonnet / Haiku)
 * - DeepSeek: DeepSeek-V3/V4/R1
 * - Qwen: Qwen3.x, QwQ
 * - GLM: GLM-5.x
 * - 豆包: Doubao
 * - 腾讯混元: Hunyuan
 * - Kimi: Kimi-K2.x/K3
 * - MiniMax: MiniMax-M2/M3
 * - Stepfun: Step
 *
 * 注意：这里按模型名识别 Claude 并省略 reasoning_effort，是 OpenAI 兼容路径上的
 * 厂商参数适配，不是协议选择。Claude 走 OpenAI 网关时必须保留此行为。
 */
export function buildThinkingFields(
  model: string,
  effort?: ThinkingEffort,
): {
  body: Record<string, unknown>;
  extraBody?: Record<string, unknown>;
} | null {
  // 用户未设置 → 不传参数，使用模型默认行为
  if (!effort) {
    return null;
  }

  const modelLower = model.toLowerCase();

  // 识别模型厂商
  const isOpenAI = /^(gpt-|o1-|o3-|chatgpt)/i.test(modelLower);
  const isClaude = /claude|anthropic|^opus-|^sonnet-|^haiku-/.test(modelLower);
  const isDeepSeek = /deepseek/i.test(modelLower);
  const isQwen = /qwen|qwq/i.test(modelLower);
  const isGLM = /^glm-/i.test(modelLower);
  const isDoubao = /doubao/i.test(modelLower);
  const isHunyuan = /hunyuan|^hy\d/i.test(modelLower);
  const isKimi = /kimi/i.test(modelLower);
  const isMiniMax = /minimax/i.test(modelLower);
  const isStepfun = /step/i.test(modelLower);

  // ===== 关闭思考 =====
  if (effort === "none" || effort === "off" || effort === "disabled") {
    // Claude / 未知网关不认 OpenAI 的 reasoning_effort。关思考时省略该字段，
    // 否则会变成 HTTP 400（Upstream error: invalid_request_error）。
    if (isClaude) {
      return null;
    }
    if (isOpenAI) {
      return { body: { reasoning_effort: "none" } };
    }
    if (isDeepSeek) {
      return { body: {}, extraBody: { thinking: { type: "disabled" } } };
    }
    if (isQwen) {
      return { body: {}, extraBody: { enable_thinking: false } };
    }
    if (isGLM) {
      // GLM-5.3 不支持关闭
      if (/glm-5\.3/i.test(modelLower)) {
        console.warn("[llm] GLM-5.3 系列不支持关闭思考模式，将使用模型默认行为");
        return null;
      }
      return { body: { reasoning_effort: "none" } };
    }
    if (isDoubao) {
      return { body: {}, extraBody: { thinking: { type: "disabled" } } };
    }
    if (isHunyuan) {
      return { body: {}, extraBody: { thinking: { type: "disabled" } } };
    }
    if (isKimi) {
      // Kimi K3/K2.7 不支持关闭
      if (/k3|k2\.7/i.test(modelLower)) {
        console.warn("[llm] Kimi K3/K2.7 系列不支持关闭思考模式，将使用模型默认行为");
        return null;
      }
      return { body: {}, extraBody: { enable_thinking: false } };
    }
    if (isMiniMax) {
      // MiniMax M2.x 不支持关闭
      if (/m2\./i.test(modelLower)) {
        console.warn("[llm] MiniMax M2.x 系列不支持关闭思考模式，将使用模型默认行为");
        return null;
      }
      return { body: {}, extraBody: { thinking: "disabled" } };
    }
    if (isStepfun) {
      return { body: {}, extraBody: { enable_thinking: false } };
    }
    // 未知模型 + 要求关闭 → 不传思考字段。
    // 乱塞 OpenAI 的 reasoning_effort 会被 Claude 等网关直接 400。
    return null;
  }

  // ===== 启用思考 + 强度映射 =====
  const effortMap: Record<string, string> = {
    low: "low",
    minimal: "low",
    medium: "medium",
    high: "high",
    max: "max",
  };
  const mappedEffort = effortMap[effort] || "high";

  if (isClaude) {
    // Claude 思考走 Anthropic thinking 块，不是 reasoning_effort；省略以免 400。
    return null;
  }
  if (isOpenAI) {
    return { body: { reasoning_effort: mappedEffort } };
  }
  if (isDeepSeek) {
    return {
      body: { reasoning_effort: mappedEffort },
      extraBody: { thinking: { type: "enabled" } },
    };
  }
  if (isQwen) {
    return {
      body: {},
      extraBody: { enable_thinking: true },
    };
  }
  if (isGLM) {
    return { body: { reasoning_effort: mappedEffort } };
  }
  if (isDoubao) {
    return { body: {}, extraBody: { thinking: { type: "enabled" } } };
  }
  if (isHunyuan) {
    return {
      body: { reasoning_effort: mappedEffort },
      extraBody: { thinking: { type: "enabled" } },
    };
  }
  if (isKimi) {
    return { body: {}, extraBody: { enable_thinking: true } };
  }
  if (isMiniMax) {
    // MiniMax M3 支持 adaptive
    if (/m3/i.test(modelLower)) {
      return { body: {}, extraBody: { thinking: "adaptive" } };
    }
    // M2.x 强制启用，不传参数
    return null;
  }
  if (isStepfun) {
    return { body: {}, extraBody: { enable_thinking: true } };
  }

  // 未知模型 + 启用思考 → 尝试 OpenAI 标准
  console.warn(
    `[llm] 未识别的模型 "${model}"，尝试使用 OpenAI 标准参数 reasoning_effort="${mappedEffort}"`,
  );
  return { body: { reasoning_effort: mappedEffort } };
}

function decodeOpenAiResponse(json: unknown): ChatResponse {
  const parsed = json as ChatResponse;
  if (!parsed?.choices?.length) {
    throw new Error("LLM returned no choices");
  }
  return parsed;
}

class OpenAiStreamParser implements StreamParser {
  private content = "";
  private contentRaw = "";
  private reasoningContent = "";
  private hasReasoningField = false;
  private inThinkTag = false;
  private lastParsedPos = 0;
  private lastEmittedThinkLen = 0;
  private lastEmittedContentLen = 0;
  private readonly OPEN_TAGS = ["<think>", "<thinking>"];
  private readonly CLOSE_TAGS = ["</think>", "</thinking>"];
  private readonly toolAcc = new Map<number, { id?: string; name?: string; arguments: string }>();
  private finishReason: string | null = null;
  private usage: ChatResponse["usage"];

  constructor(private readonly handlers: StreamHandlers) {}

  feed(event: { event?: string; data: string }): boolean {
    const data = event.data;
    if (!data || data === "[DONE]") return false;
    let chunk: {
      choices?: Array<{
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          thinking?: string | null;
          thought?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: ChatResponse["usage"];
    };
    try {
      chunk = JSON.parse(data) as typeof chunk;
    } catch {
      return false;
    }
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return false;
    let progressed = false;
    if (choice.finish_reason) {
      this.finishReason = choice.finish_reason;
      progressed = true;
    }
    const delta = choice.delta;
    if (!delta) {
      return progressed;
    }
    if (typeof delta.content === "string" && delta.content) {
      progressed = true;
      if (this.hasReasoningField) {
        this.content += delta.content;
      } else {
        this.contentRaw += delta.content;
      }
      this.flushDelta();
    }
    const reasoningDelta =
      (typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
      (typeof delta.reasoning === "string" && delta.reasoning) ||
      (typeof delta.thinking === "string" && delta.thinking) ||
      (typeof delta.thought === "string" && delta.thought);
    if (reasoningDelta) {
      progressed = true;
      this.hasReasoningField = true;
      this.reasoningContent += reasoningDelta;
      this.handlers.onThinkingDelta?.(this.reasoningContent);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let acc = this.toolAcc.get(idx);
        if (!acc) {
          acc = { arguments: "" };
          this.toolAcc.set(idx, acc);
        }
        if (tc.id) {
          acc.id = tc.id;
          progressed = true;
        }
        if (tc.function?.name) {
          acc.name = tc.function.name;
          progressed = true;
        }
        if (tc.function?.arguments) {
          acc.arguments += tc.function.arguments;
          progressed = true;
        }
      }
    }
    return progressed;
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

    // If no visible content was produced (e.g. only thinking text), fall back
    // to the raw stream so callers still get the assistant message.
    if (!this.hasReasoningField && !this.content && this.contentRaw) {
      this.content = this.contentRaw;
    }

    // ── 空响应校验 ──
    // 某些网关/模型（如京东云 DeepSeek-V4-Pro）可能建立连接但返回空流：
    // 无 content、无 reasoning、无 tool_calls、无 finish_reason。
    // 此时应抛出异常，而非静默返回空响应被误判为"完成"。
    if (
      !this.content &&
      !this.contentRaw &&
      !this.reasoningContent &&
      !tool_calls &&
      !this.finishReason
    ) {
      throw new Error("empty stream");
    }

    const message: ChatChoiceMessage = {
      role: "assistant",
      content: this.content || null,
      reasoning_content: this.reasoningContent || null,
      tool_calls,
    };

    return {
      choices: [{ message, finish_reason: this.finishReason }],
      usage: this.usage,
    };
  }

  private flushDelta(): void {
    // Always strip <think>...</think> tags from the visible stream. The
    // detection still runs in two cases:
    //   1) the model put thinking prose inside the content field (no
    //      structured reasoning_* deltas), so we redirect it to the
    //      reasoning channel via `inThinkTag`;
    //   2) the model used a structured reasoning_* field (so
    //      `hasReasoningField === true`) but ALSO emitted the literal
    //      `<think>/</think>` tokens as part of `content` — those must
    //      never reach the user-visible content stream.
    const raw = this.contentRaw;
    while (this.lastParsedPos < raw.length) {
      if (this.inThinkTag) {
        let closed = false;
        for (const tag of this.CLOSE_TAGS) {
          if (raw.startsWith(tag, this.lastParsedPos)) {
            this.lastParsedPos += tag.length;
            this.inThinkTag = false;
            closed = true;
            break;
          }
        }
        if (closed) continue;
        this.reasoningContent += raw[this.lastParsedPos]!;
        this.lastParsedPos++;
      } else {
        let opened = false;
        for (const tag of this.OPEN_TAGS) {
          if (raw.startsWith(tag, this.lastParsedPos)) {
            this.lastParsedPos += tag.length;
            this.inThinkTag = true;
            opened = true;
            break;
          }
        }
        if (opened) continue;
        this.content += raw[this.lastParsedPos]!;
        this.lastParsedPos++;
      }
    }
    // Drain any leftover inline `<think>/</think>` tokens that the model
    // appended to `content` directly (i.e. by-path that bypassed
    // `contentRaw` because the chunk did not include the tag itself, or
    // because the structured reasoning_channel was active).
    const stripped = this.stripInlineThinkTagsFromContent();
    if (this.reasoningContent.length > this.lastEmittedThinkLen) {
      this.handlers.onThinkingDelta?.(this.reasoningContent);
      this.lastEmittedThinkLen = this.reasoningContent.length;
    }
    // Emit on either grow OR shrink so a tag-stripped shorter string still
    // reaches the renderer (otherwise the literal `</think>` would remain
    // pinned to the bubble).
    if (this.content.length !== this.lastEmittedContentLen || stripped) {
      this.handlers.onDelta?.(this.content);
      this.lastEmittedContentLen = this.content.length;
    }
  }

  // Some streams deliver a literal `</think>` (or stray `<think>`) at the
  // tail of the final `content` chunk without having also opened a tag.
  // Strip those tokens from the end of `content` so they don't leak into
  // the visible assistant bubble. Returns true when the content was
  // actually shrunk.
  private stripInlineThinkTagsFromContent(): boolean {
    if (!this.content) return false;
    let trimmed = this.content;
    let changed = false;
    // Trim from the tail repeatedly to handle `<think>...</think>` left
    // over at the end of the visible stream.
    for (;;) {
      const before = trimmed;
      for (const tag of [...this.OPEN_TAGS, ...this.CLOSE_TAGS]) {
        if (trimmed.endsWith(tag)) {
          trimmed = trimmed.slice(0, -tag.length).replace(/[\s\u00a0]+$/, "");
          changed = true;
          break;
        }
      }
      if (trimmed === before) break;
    }
    if (changed) this.content = trimmed;
    return changed;
  }
}

export const openaiChatCodec: ProtocolCodec = {
  format: "openai-chat",

  buildUrl(baseUrl: string): string {
    return new URL("chat/completions", normalizeApiBaseUrl(baseUrl)).toString();
  },

  buildHeaders(apiKey: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  },

  encodeRequest(input: ProtocolEncodeInput): unknown {
    const messages = input.messages.map(({ is_error: _isError, ...message }) => {
      if (!message.attachments?.length || message.role !== "user") return message;
      const content: Array<Record<string, unknown>> = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const attachment of message.attachments) {
        if (attachment.mimeType.toLowerCase().startsWith("image/") && /^https?:\/\//i.test(attachment.url)) {
          content.push({ type: "image_url", image_url: { url: attachment.url } });
        } else {
          content.push({ type: "text", text: `[文件附件] ${attachment.name} (${attachment.mimeType || "application/octet-stream"}): ${attachment.url}` });
        }
      }
      const { attachments: _attachments, ...rest } = message;
      return { ...rest, content };
    });
    const body: Record<string, unknown> = {
      model: input.model,
      messages,
      stream: input.stream,
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? 16384,
    };
    if (input.stream) {
      body.stream_options = { include_usage: true };
    }
    const thinkingFields = buildThinkingFields(input.model, input.thinking?.effort);
    if (thinkingFields) {
      Object.assign(body, thinkingFields.body);
      if (thinkingFields.extraBody) {
        Object.assign(body, thinkingFields.extraBody);
      }
    }
    if (input.tools?.length) {
      body.tools = input.tools;
      body.tool_choice = "auto";
    }
    return body;
  },

  decodeResponse(json: unknown): ChatResponse {
    return decodeOpenAiResponse(json);
  },

  createStreamParser(handlers: StreamHandlers): StreamParser {
    return new OpenAiStreamParser(handlers);
  },

  shouldFallbackToNonStream(status: number, _body: string): boolean {
    return status === 400 || status === 404 || status === 422;
  },

  listModelsUrl(baseUrl: string): string {
    return new URL("models", normalizeApiBaseUrl(baseUrl)).toString();
  },

  listModelsHeaders(apiKey: string | undefined): Record<string, string> {
    return openaiChatCodec.buildHeaders(apiKey);
  },

  parseModelList(json: unknown): ListedModel[] {
    const data = json as {
      data?: Array<{ id: string; name?: string }>;
      models?: Array<{ id: string; name?: string }>;
    };
    return (data.data ?? data.models ?? []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
    }));
  },
};

export { OpenAiStreamParser };
