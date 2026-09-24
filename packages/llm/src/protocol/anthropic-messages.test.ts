import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolDef } from "../types.ts";
import {
  anthropicMessagesCodec,
  decodeAnthropicResponse,
  encodeAnthropicMessages,
} from "./anthropic-messages.ts";

const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

describe("anthropicMessagesCodec encode", () => {
  it("posts to /messages with x-api-key and anthropic-version", () => {
    expect(anthropicMessagesCodec.buildUrl("https://api.anthropic.com/v1")).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(anthropicMessagesCodec.buildHeaders("sk-ant-test")).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "sk-ant-test",
    });
    expect(anthropicMessagesCodec.buildHeaders(undefined)["authorization"]).toBeUndefined();
    expect(anthropicMessagesCodec.buildHeaders(undefined).Authorization).toBeUndefined();
  });

  it("joins /messages and /models onto a custom base URL without rewriting the host", () => {
    expect(anthropicMessagesCodec.buildUrl("https://llm.internal.example/v1")).toBe(
      "https://llm.internal.example/v1/messages",
    );
    expect(anthropicMessagesCodec.listModelsUrl("https://llm.internal.example/v1")).toBe(
      "https://llm.internal.example/v1/models",
    );
    // 无版本后缀时自动补 /v1，避免打到 .../anthropic/messages
    expect(anthropicMessagesCodec.buildUrl("http://127.0.0.1:8080/anthropic")).toBe(
      "http://127.0.0.1:8080/anthropic/v1/messages",
    );
    expect(anthropicMessagesCodec.listModelsUrl("http://127.0.0.1:8080/anthropic")).toBe(
      "http://127.0.0.1:8080/anthropic/v1/models",
    );
    // 已以 /v1 结尾则不重复追加
    expect(anthropicMessagesCodec.buildUrl("http://127.0.0.1:8080/anthropic/v1")).toBe(
      "http://127.0.0.1:8080/anthropic/v1/messages",
    );
    expect(anthropicMessagesCodec.buildUrl("https://api.anthropic.com/v1/")).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("lifts system messages and maps tools / tool_calls / tool results", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Be careful." },
      { role: "system", content: "Use tools." },
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: "ok",
        tool_calls: [
          {
            id: "call/1!",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call/1!", content: "file body" },
    ];
    const body = encodeAnthropicMessages({
      model: "claude-sonnet-4",
      messages,
      tools,
      stream: false,
      temperature: 0.2,
      maxTokens: 16384,
    }) as Record<string, unknown> & ReturnType<typeof encodeAnthropicMessages>;

    expect(body.system).toBe("Be careful.\n\nUse tools.");
    expect(body.model).toBe("claude-sonnet-4");
    expect(body.max_tokens).toBe(16384);
    expect(body.stream).toBe(false);
    expect(body.stream_options).toBeUndefined();
    expect(body.tools).toEqual([
      {
        name: "read_file",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "read it" }],
    });
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "call_1_", name: "read_file", input: { path: "a.ts" } },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1_", content: "file body" }],
    });
    expect(body.messages.at(-1)?.role).toBe("user");
  });

  it("encodes multi-image attachments as source.url blocks and non-images as plain text", () => {
    const body = encodeAnthropicMessages({
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: "look",
          attachments: [
            { name: "a.png", mimeType: "image/png", url: "https://cdn.example/a.png" },
            { name: "b.jpg", mimeType: "image/jpeg", url: "https://cdn.example/b.jpg" },
            { name: "notes.pdf", mimeType: "application/pdf", url: "https://cdn.example/notes.pdf" },
          ],
        },
      ],
      stream: false,
    });

    expect(body.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "image",
          source: { type: "url", media_type: "image/png", url: "https://cdn.example/a.png" },
        },
        {
          type: "image",
          source: { type: "url", media_type: "image/jpeg", url: "https://cdn.example/b.jpg" },
        },
        {
          type: "text",
          text: "[文件附件] notes.pdf (application/pdf): https://cdn.example/notes.pdf",
        },
      ],
    });
  });

  it("keeps plain text user messages as a single text block", () => {
    const body = encodeAnthropicMessages({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi only" }],
      stream: false,
    });
    expect(body.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi only" }],
    });
  });

  it("merges consecutive same-role messages and prepends a user turn when needed", () => {
    const body = encodeAnthropicMessages({
      model: "claude-sonnet-4",
      messages: [
        { role: "assistant", content: "already talking" },
        { role: "assistant", content: "more" },
      ],
      stream: false,
    });
    expect(body.messages[0]?.role).toBe("user");
    expect((body.messages[0]?.content[0] as { text: string }).text).toBe("(continue)");
    expect(body.messages[1]?.role).toBe("assistant");
    expect(body.messages[1]?.content).toEqual([
      { type: "text", text: "already talking" },
      { type: "text", text: "more" },
    ]);
    expect(body.messages.at(-1)?.role).toBe("user");
  });

  it("keeps invalid tool arguments as _raw instead of failing the request", () => {
    const body = encodeAnthropicMessages({
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "read_file", arguments: "{not-json" } },
          ],
        },
      ],
      stream: false,
    });
    const toolUse = body.messages[1]?.content.find((b) => b.type === "tool_use") as {
      input: unknown;
    };
    expect(toolUse.input).toEqual({ _raw: "{not-json" });
  });

  it("enables thinking with budget_tokens and raises max_tokens above the budget", () => {
    const body = encodeAnthropicMessages({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "think" }],
      stream: false,
      maxTokens: 1000,
      thinking: { effort: "high" },
    });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(body.max_tokens).toBe(16384 + 4096);
    expect(body.temperature).toBeUndefined();
  });

  it("omits thinking when effort is unset or disabled", () => {
    const unset = encodeAnthropicMessages({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(unset.thinking).toBeUndefined();
    expect(unset.temperature).toBe(0.2);

    const off = encodeAnthropicMessages({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      thinking: { effort: "none" },
    });
    expect(off.thinking).toBeUndefined();
  });
});

describe("anthropicMessagesCodec decode", () => {
  it("maps text, thinking, tool_use and usage back to ChatResponse", () => {
    const decoded = decodeAnthropicResponse({
      id: "msg_1",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 4 },
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "calling" },
        { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
      ],
    });
    expect(decoded.id).toBe("msg_1");
    expect(decoded.choices[0]?.finish_reason).toBe("tool_calls");
    expect(decoded.choices[0]?.message.content).toBe("calling");
    expect(decoded.choices[0]?.message.reasoning_content).toBe("plan");
    expect(decoded.choices[0]?.message.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.ts"}' },
      },
    ]);
    expect(decoded.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
    });
  });

  it("maps stop reasons", () => {
    expect(decodeAnthropicResponse({ content: [{ type: "text", text: "a" }], stop_reason: "end_turn" }).choices[0]?.finish_reason).toBe("stop");
    expect(decodeAnthropicResponse({ content: [{ type: "text", text: "a" }], stop_reason: "max_tokens" }).choices[0]?.finish_reason).toBe("length");
  });

  it("fails on empty or error JSON instead of treating them as a successful empty reply", () => {
    expect(() => decodeAnthropicResponse(null)).toThrow(/empty or not JSON/i);
    expect(() => decodeAnthropicResponse(undefined)).toThrow(/empty or not JSON/i);
    expect(() => decodeAnthropicResponse("")).toThrow(/empty or not JSON/i);
    expect(() => decodeAnthropicResponse({})).toThrow(/missing content/i);
    expect(() =>
      decodeAnthropicResponse({
        type: "error",
        error: { type: "invalid_request_error", message: "bad request" },
      }),
    ).toThrow(/bad request/);
    expect(() =>
      decodeAnthropicResponse({ error: { message: "overloaded" } }),
    ).toThrow(/overloaded/);
  });
});

describe("anthropicMessagesCodec stream", () => {
  it("accumulates text, thinking and tool_use JSON deltas", () => {
    const deltas: string[] = [];
    const thoughts: string[] = [];
    const parser = anthropicMessagesCodec.createStreamParser({
      onDelta: (t) => deltas.push(t),
      onThinkingDelta: (t) => thoughts.push(t),
    });

    parser.feed({
      event: "message_start",
      data: JSON.stringify({ type: "message_start", message: { id: "msg_s", usage: { input_tokens: 3, output_tokens: 0 } } }),
    });
    parser.feed({
      event: "content_block_start",
      data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
    });
    parser.feed({
      event: "content_block_delta",
      data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
    });
    parser.feed({
      event: "content_block_start",
      data: JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
    });
    parser.feed({
      event: "content_block_delta",
      data: JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } }),
    });
    parser.feed({
      event: "content_block_start",
      data: JSON.stringify({
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
      }),
    });
    parser.feed({
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      }),
    });
    parser.feed({
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '"a.ts"}' },
      }),
    });
    parser.feed({
      event: "message_delta",
      data: JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 8 },
      }),
    });
    parser.feed({ event: "ping", data: JSON.stringify({ type: "ping" }) });

    const result = parser.finish();
    expect(deltas.at(-1)).toBe("Hi");
    expect(thoughts.at(-1)).toBe("hmm");
    expect(result.id).toBe("msg_s");
    expect(result.choices[0]?.message.content).toBe("Hi");
    expect(result.choices[0]?.message.reasoning_content).toBe("hmm");
    expect(result.choices[0]?.finish_reason).toBe("tool_calls");
    expect(result.choices[0]?.message.tool_calls?.[0]).toEqual({
      id: "toolu_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"a.ts"}' },
    });
    expect(result.usage?.prompt_tokens).toBe(3);
    expect(result.usage?.completion_tokens).toBe(8);
  });

  it("does not fallback on generic 400s, only when stream is explicitly unsupported", () => {
    expect(anthropicMessagesCodec.shouldFallbackToNonStream(400, "invalid_request_error")).toBe(false);
    expect(anthropicMessagesCodec.shouldFallbackToNonStream(400, "Streaming is not supported")).toBe(true);
  });

  it("throws immediately on SSE event:error", () => {
    const parser = anthropicMessagesCodec.createStreamParser({});
    expect(() =>
      parser.feed({
        event: "error",
        data: JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        }),
      }),
    ).toThrow(/Overloaded/);
  });

  it("throws when the payload type is error even without event:error", () => {
    const parser = anthropicMessagesCodec.createStreamParser({});
    expect(() =>
      parser.feed({
        data: JSON.stringify({ type: "error", error: { message: "rate limited" } }),
      }),
    ).toThrow(/rate limited/);
  });
});

describe("anthropicMessagesCodec listModels", () => {
  it("lists models with x-api-key and display_name", () => {
    expect(anthropicMessagesCodec.listModelsUrl("https://api.anthropic.com/v1")).toBe(
      "https://api.anthropic.com/v1/models",
    );
    expect(anthropicMessagesCodec.listModelsHeaders("sk-ant-test")).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "sk-ant-test",
    });
    expect(
      anthropicMessagesCodec.parseModelList({
        data: [{ id: "claude-sonnet-4", display_name: "Claude Sonnet 4" }],
      }),
    ).toEqual([{ id: "claude-sonnet-4", name: "Claude Sonnet 4" }]);
  });
});
