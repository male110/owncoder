import type { ChatMessage, ChatResponse, ToolDef } from "../types.js";
import type { ThinkingConfig } from "../thinking.js";

/** Wire format identifier. Named after the protocol, not the vendor. */
export type ApiFormat = "openai-chat" | "openai-responses" | "anthropic-messages" | "google-gemini";

export const API_FORMATS: readonly ApiFormat[] = ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"] as const;

export function isApiFormat(value: unknown): value is ApiFormat {
  return value === "openai-chat" || value === "openai-responses" || value === "anthropic-messages" || value === "google-gemini";
}

export interface ProtocolEncodeInput {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  stream: boolean;
  thinking?: ThinkingConfig;
}

export interface StreamHandlers {
  onDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
}

export interface StreamParser {
  /** Feed one already-framed SSE event (event name may be empty; OpenAI only has data:).
   *  Returns true when the event contained meaningful model progress. */
  feed(event: { event?: string; data: string }): boolean;
  finish(): ChatResponse;
}

export interface ListedModel {
  id: string;
  name: string;
  /** 展示名（部分接口返回 display_name / displayName）；缺省时回退 name。 */
  display_name?: string;
}

/**
 * `GET /v1/models` 的分页响应体（OpenAI / Anthropic 风格的游标分页）。
 * `data` 与 `models` 二者取其一承载模型数组；游标字段用于循环拉取全部页：
 * 以 `last_id` 作为下一页的 `after` 游标，直到 `has_more === false`。
 */
export interface ModelListPage {
  data?: ListedModel[];
  models?: ListedModel[];
  /** 本页首个模型 id。 */
  first_id?: string;
  /** 本页末个模型 id，作为下一页 `after` 游标。 */
  last_id?: string;
  /** 是否还有下一页。 */
  has_more?: boolean;
}

export interface ProtocolCodec {
  readonly format: ApiFormat;
  buildUrl(baseUrl: string, model?: string): string;
  buildStreamUrl?(baseUrl: string, model?: string): string;
  buildHeaders(apiKey: string | undefined): Record<string, string>;
  encodeRequest(input: ProtocolEncodeInput): unknown | Promise<unknown>;
  decodeResponse(json: unknown): ChatResponse;
  createStreamParser(handlers: StreamHandlers): StreamParser;
  shouldFallbackToNonStream(status: number, body: string): boolean;
  listModelsUrl(baseUrl: string): string;
  listModelsHeaders(apiKey: string | undefined): Record<string, string>;
  parseModelList(json: unknown): ListedModel[];
}
