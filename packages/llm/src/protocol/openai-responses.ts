import type { ChatChoiceMessage, ChatMessage, ChatResponse, ToolCall } from "../types.js";
import type { ListedModel, ProtocolCodec, ProtocolEncodeInput, StreamHandlers, StreamParser } from "./types.js";
import { normalizeApiBaseUrl } from "./url.js";

function messageContent(message: ChatMessage): unknown {
  if (!message.attachments?.length || message.role !== "user") return message.content ?? "";
  const content: Array<Record<string, unknown>> = [];
  if (message.content) content.push({ type: "input_text", text: message.content });
  for (const attachment of message.attachments) {
    if (attachment.mimeType.toLowerCase().startsWith("image/") && /^https?:\/\//i.test(attachment.url)) {
      content.push({ type: "input_image", image_url: attachment.url, detail: "auto" });
    } else {
      content.push({
        type: "input_text",
        text: `[文件附件] ${attachment.name} (${attachment.mimeType || "application/octet-stream"}): ${attachment.url}`,
      });
    }
  }
  return content;
}

function encodeInputMessages(messages: ChatMessage[]): unknown[] {
  const result: unknown[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (message.tool_call_id) {
        result.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content ?? "" });
      }
      continue;
    }
    if (message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        result.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    result.push({ role: message.role, content: messageContent(message) });
  }
  return result;
}

function responseToChat(json: unknown): ChatResponse {
  const value = json as {
    id?: string;
    output?: Array<{ type?: string; role?: string; content?: Array<{ type?: string; text?: string }>; call_id?: string; name?: string; arguments?: string }>;
    output_text?: string;
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; [key: string]: unknown };
  };
  const output = value.output ?? [];
  const text = value.output_text ?? output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  const toolCalls: ToolCall[] = output
    .filter((item) => item.type === "function_call")
    .map((item, index) => ({
      id: item.call_id || `call_response_${index}`,
      type: "function" as const,
      function: { name: item.name || "unknown", arguments: item.arguments || "{}" },
    }));
  if (!text && !toolCalls.length) throw new Error("LLM returned no output");
  const message: ChatChoiceMessage = { role: "assistant", content: text || null, tool_calls: toolCalls.length ? toolCalls : undefined };
  return {
    id: value.id,
    choices: [{ message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: value.usage
      ? { prompt_tokens: value.usage.input_tokens, completion_tokens: value.usage.output_tokens, total_tokens: value.usage.total_tokens, ...value.usage }
      : undefined,
  };
}

class OpenAiResponsesStreamParser implements StreamParser {
  private content = "";
  private reasoning = "";
  private readonly calls = new Map<string, { name: string; arguments: string }>();
  private readonly itemCallIds = new Map<string, string>();
  private usage: ChatResponse["usage"];
  private completed = false;

  constructor(private readonly handlers: StreamHandlers) {}

  feed(event: { event?: string; data: string }): boolean {
    if (!event.data || event.data === "[DONE]") return false;
    let value: {
      type?: string;
      delta?: string;
      arguments?: string;
      item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
      response?: { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; [key: string]: unknown } };
      item_id?: string;
      call_id?: string;
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; [key: string]: unknown };
    };
    try { value = JSON.parse(event.data) as typeof value; } catch { return false; }
    const type = value.type || event.event;
    if (type === "response.output_text.delta" && typeof value.delta === "string") {
      this.content += value.delta;
      this.handlers.onDelta?.(this.content);
      return true;
    }
    if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && typeof value.delta === "string") {
      this.reasoning += value.delta;
      this.handlers.onThinkingDelta?.(this.reasoning);
      return true;
    }
    if ((type === "response.output_item.added" || type === "response.output_item.done") && value.item?.type === "function_call") {
      const callId = value.item.call_id || value.item.id;
      if (callId) {
        if (value.item.id) this.itemCallIds.set(value.item.id, callId);
        const existing = this.calls.get(callId);
        // 只在 item.arguments 非空时更新，避免空字符串覆盖已累积的 delta 参数
        const newArgs = (value.item.arguments && value.item.arguments.trim()) ? value.item.arguments : (existing?.arguments ?? "");
        this.calls.set(callId, {
          name: value.item.name || existing?.name || "unknown",
          arguments: newArgs,
        });
        return true;
      }
    }
    if (type === "response.function_call_arguments.done" && typeof value.arguments === "string") {
      const callId = value.call_id || (value.item_id && (this.itemCallIds.get(value.item_id) || value.item_id));
      if (callId) {
        const call = this.calls.get(callId) || { name: "unknown", arguments: "" };
        // 只在 done 事件参数非空且比已有参数更完整时才更新，避免覆盖已累积的增量
        if (value.arguments && value.arguments.trim() && value.arguments !== "{}") {
          call.arguments = value.arguments;
        }
        this.calls.set(callId, call);
      }
      return true;
    }
    if (type === "response.function_call_arguments.delta" && typeof value.delta === "string") {
      const callId = value.call_id || (value.item_id && (this.itemCallIds.get(value.item_id) || value.item_id));
      if (callId) {
        const call = this.calls.get(callId) || { name: "unknown", arguments: "" };
        call.arguments += value.delta;
        this.calls.set(callId, call);
      }
      return true;
    }
    const usage = value.usage || value.response?.usage;
    if (usage) this.usage = { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens, ...usage };
    if (type === "response.completed" || type === "response.done") { this.completed = true; return true; }
    return Boolean(usage);
  }

  finish(): ChatResponse {
    const tool_calls: ToolCall[] | undefined = this.calls.size
      ? [...this.calls.entries()].map(([id, call]) => ({ id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } }))
      : undefined;
    if (!this.content && !tool_calls?.length && !this.completed) throw new Error("empty stream");
    return {
      choices: [{ message: { role: "assistant", content: this.content || null, reasoning_content: this.reasoning || null, tool_calls }, finish_reason: tool_calls?.length ? "tool_calls" : "stop" }],
      usage: this.usage,
    };
  }
}

export const openaiResponsesCodec: ProtocolCodec = {
  format: "openai-responses",
  buildUrl(baseUrl: string): string { return new URL("responses", normalizeApiBaseUrl(baseUrl)).toString(); },
  buildHeaders(apiKey: string | undefined): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  },
  encodeRequest(input: ProtocolEncodeInput): unknown {
    const body: Record<string, unknown> = {
      model: input.model,
      input: encodeInputMessages(input.messages),
      stream: input.stream,
      temperature: input.temperature ?? 0.2,
      max_output_tokens: input.maxTokens ?? 16384,
    };
    if (input.tools?.length) {
      body.tools = input.tools.map((tool) => ({ type: "function", name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }));
    }
    if (input.thinking?.effort && input.thinking.effort !== "none") body.reasoning = { effort: input.thinking.effort };
    return body;
  },
  decodeResponse: responseToChat,
  createStreamParser(handlers: StreamHandlers): StreamParser { return new OpenAiResponsesStreamParser(handlers); },
  shouldFallbackToNonStream(status: number): boolean { return status === 400 || status === 404 || status === 422; },
  listModelsUrl(baseUrl: string): string { return new URL("models", normalizeApiBaseUrl(baseUrl)).toString(); },
  listModelsHeaders(apiKey: string | undefined): Record<string, string> { return this.buildHeaders(apiKey); },
  parseModelList(json: unknown): ListedModel[] {
    const data = json as { data?: Array<{ id: string; name?: string }>; models?: Array<{ id: string; name?: string }> };
    return (data.data ?? data.models ?? []).map((model) => ({ id: model.id, name: model.name || model.id }));
  },
};
