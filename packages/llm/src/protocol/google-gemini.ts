import type { ChatChoiceMessage, ChatMessage, ChatResponse, ToolCall } from "../types.js";
import type { ListedModel, ProtocolCodec, ProtocolEncodeInput, StreamHandlers, StreamParser } from "./types.js";
import { normalizeApiBaseUrl } from "./url.js";

type GeminiPart = Record<string, unknown>;
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

function attachmentPart(attachment: NonNullable<ChatMessage["attachments"]>[number]): GeminiPart {
  if (/^data:/i.test(attachment.url)) {
    const match = attachment.url.match(/^data:([^;,]+);base64,(.*)$/i);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
  }
  return { fileData: { mimeType: attachment.mimeType || "application/octet-stream", fileUri: attachment.url } };
}

function messageParts(message: ChatMessage): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (message.content) parts.push({ text: message.content });
  for (const attachment of message.attachments ?? []) parts.push(attachmentPart(attachment));
  if (message.tool_calls?.length) {
    for (const call of message.tool_calls) {
      let args: unknown = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      parts.push({ functionCall: { name: call.function.name, args } });
    }
  }
  return parts.length ? parts : [{ text: "" }];
}

function encodeMessages(messages: ChatMessage[]): { systemInstruction?: { parts: GeminiPart[] }; contents: GeminiContent[] } {
  const systemParts: GeminiPart[] = [];
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) systemParts.push({ text: message.content });
      continue;
    }
    if (message.role === "tool") {
      let response: unknown = message.content ?? "";
      try { response = JSON.parse(String(response)); } catch { /* preserve plain tool output */ }
      contents.push({ role: "user", parts: [{ functionResponse: { name: message.name || message.tool_call_id || "tool", response: { result: response } } }] });
      continue;
    }
    contents.push({ role: message.role === "assistant" ? "model" : "user", parts: messageParts(message) });
  }
  return { systemInstruction: systemParts.length ? { parts: systemParts } : undefined, contents };
}

function usageResponse(usage?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; thoughtsTokenCount?: number }): ChatResponse["usage"] {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.promptTokenCount,
    completion_tokens: usage.candidatesTokenCount,
    total_tokens: usage.totalTokenCount,
    thoughts_tokens: usage.thoughtsTokenCount,
  };
}

function candidateParts(json: unknown): { text: string; reasoning: string; calls: ToolCall[]; finish?: string } {
  const value = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown } }> }; finishReason?: string }> };
  const candidate = value.candidates?.[0];
  let text = "";
  let reasoning = "";
  const calls: ToolCall[] = [];
  for (const part of candidate?.content?.parts ?? []) {
    if (typeof part.text === "string") {
      if (part.thought) reasoning += part.text;
      else text += part.text;
    }
    if (part.functionCall) {
      calls.push({ id: `call_${calls.length}`, type: "function", function: { name: part.functionCall.name || "unknown", arguments: JSON.stringify(part.functionCall.args ?? {}) } });
    }
  }
  return { text, reasoning, calls, finish: candidate?.finishReason };
}

function decodeGeminiResponse(json: unknown): ChatResponse {
  const value = json as { responseId?: string; usageMetadata?: Parameters<typeof usageResponse>[0] };
  const parsed = candidateParts(json);
  if (!parsed.text && !parsed.calls.length) throw new Error("LLM returned no output");
  const message: ChatChoiceMessage = { role: "assistant", content: parsed.text || null, reasoning_content: parsed.reasoning || null, tool_calls: parsed.calls.length ? parsed.calls : undefined };
  return { id: value.responseId, choices: [{ message, finish_reason: parsed.calls.length ? "tool_calls" : parsed.finish || "stop" }], usage: usageResponse(value.usageMetadata) };
}

class GeminiStreamParser implements StreamParser {
  private content = "";
  private reasoning = "";
  private calls: ToolCall[] = [];
  private usage: ChatResponse["usage"];
  private finishReason: string | undefined;

  constructor(private readonly handlers: StreamHandlers) {}

  feed(event: { event?: string; data: string }): boolean {
    if (!event.data || event.data === "[DONE]") return false;
    let value: unknown;
    try { value = JSON.parse(event.data); } catch { return false; }
    const parsed = candidateParts(value);
    let progressed = false;
    if (parsed.text) { this.content += parsed.text; this.handlers.onDelta?.(this.content); progressed = true; }
    if (parsed.reasoning) { this.reasoning += parsed.reasoning; this.handlers.onThinkingDelta?.(this.reasoning); progressed = true; }
    if (parsed.calls.length) { this.calls.push(...parsed.calls.map((call, index) => ({ ...call, id: `call_${this.calls.length + index}` }))); progressed = true; }
    if (parsed.finish) { this.finishReason = parsed.finish; progressed = true; }
    this.usage = usageResponse((value as { usageMetadata?: Parameters<typeof usageResponse>[0] }).usageMetadata) || this.usage;
    return progressed || Boolean(this.usage);
  }

  finish(): ChatResponse {
    if (!this.content && !this.reasoning && !this.calls.length && !this.finishReason) throw new Error("empty stream");
    return {
      choices: [{ message: { role: "assistant", content: this.content || null, reasoning_content: this.reasoning || null, tool_calls: this.calls.length ? this.calls : undefined }, finish_reason: this.calls.length ? "tool_calls" : this.finishReason || "stop" }],
      usage: this.usage,
    };
  }
}

function modelPath(model: string): string {
  return `models/${encodeURIComponent(model.replace(/^models\//, ""))}`;
}

export const googleGeminiCodec: ProtocolCodec = {
  format: "google-gemini",
  buildUrl(baseUrl: string, model = ""): string { return new URL(`${modelPath(model)}:generateContent`, normalizeApiBaseUrl(baseUrl)).toString(); },
  buildStreamUrl(baseUrl: string, model = ""): string { return new URL(`${modelPath(model)}:streamGenerateContent?alt=sse`, normalizeApiBaseUrl(baseUrl)).toString(); },
  buildHeaders(apiKey: string | undefined): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["x-goog-api-key"] = apiKey;
    return headers;
  },
  encodeRequest(input: ProtocolEncodeInput): unknown {
    const encoded = encodeMessages(input.messages);
    const body: Record<string, unknown> = {
      contents: encoded.contents,
      generationConfig: { temperature: input.temperature ?? 0.2, maxOutputTokens: input.maxTokens ?? 16384 },
    };
    if (encoded.systemInstruction) body.systemInstruction = encoded.systemInstruction;
    if (input.tools?.length) body.tools = [{ functionDeclarations: input.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) }];
    if (input.thinking?.effort && input.thinking.effort !== "none") {
      (body.generationConfig as Record<string, unknown>).thinkingConfig = { thinkingBudget: input.thinking.effort === "low" ? 1024 : input.thinking.effort === "medium" ? 4096 : 8192 };
    }
    return body;
  },
  decodeResponse: decodeGeminiResponse,
  createStreamParser(handlers: StreamHandlers): StreamParser { return new GeminiStreamParser(handlers); },
  shouldFallbackToNonStream(status: number): boolean { return status === 400 || status === 404 || status === 422; },
  listModelsUrl(baseUrl: string): string { return new URL("models", normalizeApiBaseUrl(baseUrl)).toString(); },
  listModelsHeaders(apiKey: string | undefined): Record<string, string> { return this.buildHeaders(apiKey); },
  parseModelList(json: unknown): ListedModel[] {
    const models = (json as { models?: Array<{ name?: string; displayName?: string }> }).models ?? [];
    return models.filter((model) => model.name).map((model) => ({ id: model.name!.replace(/^models\//, ""), name: model.displayName || model.name!.replace(/^models\//, "") }));
  },
};
