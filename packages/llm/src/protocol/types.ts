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
