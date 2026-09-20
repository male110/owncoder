import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCompletion, chatCompletionStream, type ModelRef } from "../index.ts";
import type { ChatMessage } from "../types.ts";

const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

function jsonResponse(body: unknown, init?: { status?: number; contentType?: string }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": init?.contentType ?? "application/json" },
  });
}

function sseResponse(chunks: string[]): Response {
  return new Response(chunks.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("chatCompletion protocol dispatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends OpenAI chat/completions for configs without apiFormat", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer sk-test");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("claude-sonnet-4");
      expect(body.messages).toEqual(messages);
      expect(body.stream).toBe(false);
      return jsonResponse({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ref: ModelRef = {
      baseUrl: "https://openrouter.ai/api/v1",
      model: "claude-sonnet-4",
      apiKey: "sk-test",
    };
    const result = await chatCompletion(ref, messages);
    expect(result.choices[0]?.message.content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends Anthropic /messages and x-api-key for explicit anthropic-messages on a custom URL", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://gateway.example.com/claude/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("sk-ant");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(headers.get("Authorization")).toBeNull();
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].role).toBe("user");
      expect(body.max_tokens).toBe(16384);
      return jsonResponse({
        id: "msg_custom",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "via-proxy" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ref: ModelRef = {
      baseUrl: "https://gateway.example.com/claude/v1",
      model: "claude-sonnet-4",
      apiKey: "sk-ant",
      apiFormat: "anthropic-messages",
    };
    const result = await chatCompletion(ref, messages);
    expect(result.choices[0]?.message.content).toBe("via-proxy");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends Anthropic /messages when apiFormat is anthropic-messages", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.anthropic.com/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("sk-ant");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(headers.get("Authorization")).toBeNull();
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].role).toBe("user");
      expect(body.max_tokens).toBe(16384);
      return jsonResponse({
        id: "msg_1",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 2, output_tokens: 1 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ref: ModelRef = {
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4",
      apiKey: "sk-ant",
      apiFormat: "anthropic-messages",
    };
    const result = await chatCompletion(ref, messages);
    expect(result.choices[0]?.message.content).toBe("hello");
    expect(result.choices[0]?.finish_reason).toBe("stop");
  });

  it("infers Anthropic from official host when apiFormat is omitted", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://api.anthropic.com/v1/messages");
      return jsonResponse({
        content: [{ type: "text", text: "inferred" }],
        stop_reason: "end_turn",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await chatCompletion(
      { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4", apiKey: "sk-ant" },
      messages,
    );
  });

  it("fails non-stream empty JSON instead of treating it as a successful empty reply", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      chatCompletion(
        {
          baseUrl: "https://gateway.example.com/claude/v1",
          model: "claude-sonnet-4",
          apiKey: "sk-ant",
          apiFormat: "anthropic-messages",
        },
        messages,
      ),
    ).rejects.toThrow(/missing content/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails non-stream Anthropic error JSON instead of succeeding", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      chatCompletion(
        {
          baseUrl: "https://gateway.example.com/claude/v1",
          model: "claude-sonnet-4",
          apiKey: "sk-ant",
          apiFormat: "anthropic-messages",
        },
        messages,
      ),
    ).rejects.toThrow(/overloaded/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("streams Anthropic SSE events through onDelta", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];
    const result = await chatCompletionStream(
      {
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-sonnet-4",
        apiKey: "sk-ant",
        apiFormat: "anthropic-messages",
      },
      messages,
      { onDelta: (t) => deltas.push(t) },
    );
    expect(deltas.at(-1)).toBe("Hi");
    expect(result.choices[0]?.message.content).toBe("Hi");
    expect(result.choices[0]?.finish_reason).toBe("stop");
  });

  it("fails immediately on Anthropic SSE event:error without falling back", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      chatCompletionStream(
        {
          baseUrl: "https://gateway.example.com/claude/v1",
          model: "claude-sonnet-4",
          apiKey: "sk-ant",
          apiFormat: "anthropic-messages",
        },
        messages,
        { onDelta: () => undefined },
      ),
    ).rejects.toThrow(/Overloaded/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
