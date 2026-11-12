import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolDef } from "../types.ts";
import { buildThinkingFields, openaiChatCodec } from "./openai-chat.ts";

const messages: ChatMessage[] = [
  { role: "system", content: "You are a coding agent." },
  { role: "user", content: "hi" },
];

const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { file_path: { type: "string" } } },
    },
  },
];

describe("openaiChatCodec", () => {
  it("keeps the existing URL, auth, body fields and stream_options", () => {
    expect(openaiChatCodec.buildUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    // baseUrl 原样拼接协议路径：版本段由配置提供，不自动补 /v1
    expect(openaiChatCodec.buildUrl("https://api.openai.com")).toBe(
      "https://api.openai.com/chat/completions",
    );
    expect(openaiChatCodec.buildUrl("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(openaiChatCodec.listModelsUrl("https://api.openai.com")).toBe(
      "https://api.openai.com/models",
    );
    expect(openaiChatCodec.listModelsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(openaiChatCodec.buildHeaders("sk-test")).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
    });
    expect(openaiChatCodec.buildHeaders(undefined)).toEqual({
      "Content-Type": "application/json",
    });

    const body = openaiChatCodec.encodeRequest({
      model: "gpt-4o",
      messages,
      tools,
      temperature: 0.2,
      maxTokens: 16384,
      stream: true,
    }) as Record<string, unknown>;

    expect(body.model).toBe("gpt-4o");
    expect(body.messages).toEqual(messages);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(16384);
    expect(body.tools).toBe(tools);
    expect(body.tool_choice).toBe("auto");
  });

  it("OpenAI 兼容中转保留错误正文但不发送 Anthropic 专用错误字段", () => {
    const output = "Error: Whole-file reads are limited. Use read_outline.";
    const body = openaiChatCodec.encodeRequest({
      model: "claude-sonnet-4",
      stream: false,
      messages: [{ role: "tool", tool_call_id: "call-large", content: output, is_error: true }],
    }) as { messages: unknown[] };
    expect(body.messages).toEqual([{ role: "tool", tool_call_id: "call-large", content: output }]);
  });

  it("omits stream_options on non-stream requests", () => {
    const body = openaiChatCodec.encodeRequest({
      model: "gpt-4o",
      messages,
      stream: false,
    }) as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.stream_options).toBeUndefined();
  });

  it("falls back to non-stream on 400/404/422", () => {
    expect(openaiChatCodec.shouldFallbackToNonStream(400, "bad")).toBe(true);
    expect(openaiChatCodec.shouldFallbackToNonStream(404, "missing")).toBe(true);
    expect(openaiChatCodec.shouldFallbackToNonStream(422, "unprocessable")).toBe(true);
    expect(openaiChatCodec.shouldFallbackToNonStream(401, "nope")).toBe(false);
    expect(openaiChatCodec.shouldFallbackToNonStream(500, "boom")).toBe(false);
  });

  it("does not send reasoning_effort for Claude model names on the OpenAI path", () => {
    expect(buildThinkingFields("claude-sonnet-4", "high")).toBeNull();
    expect(buildThinkingFields("claude-3-5-sonnet", "none")).toBeNull();
    const body = openaiChatCodec.encodeRequest({
      model: "claude-sonnet-4",
      messages,
      stream: false,
      thinking: { effort: "high" },
    }) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it("still maps OpenAI thinking fields for GPT models", () => {
    expect(buildThinkingFields("gpt-5", "high")).toEqual({ body: { reasoning_effort: "high" } });
    expect(buildThinkingFields("gpt-5", "none")).toEqual({ body: { reasoning_effort: "none" } });
  });

  it("recognizes Bailing Ling flash models and sends no thinking fields", () => {
    // Ling flash/tiny 是非思考线：任何 effort 都不发参数（乱塞 reasoning_effort
    // 会被网关拒绝或引发异常行为）
    expect(buildThinkingFields("ling-3.1-flash", "high")).toBeNull();
    expect(buildThinkingFields("Ling-3.0-flash", "low")).toBeNull();
    expect(buildThinkingFields("ling-3.0-tiny", "none")).toBeNull();
    expect(buildThinkingFields("lingdt-decision-1.0", "medium")).toBeNull();
    const body = openaiChatCodec.encodeRequest({
      model: "ling-3.1-flash",
      messages,
      stream: false,
      thinking: { effort: "high" },
    }) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });

  it("recognizes Bailing Ring reasoning line and maps reasoning_effort", () => {
    expect(buildThinkingFields("Ring-2.6-1T", "high")).toEqual({ body: { reasoning_effort: "high" } });
    expect(buildThinkingFields("ring-3-flash", "low")).toEqual({ body: { reasoning_effort: "low" } });
    // 关闭思考时省略参数
    expect(buildThinkingFields("Ring-2.6-1T", "none")).toBeNull();
  });

  it("parses OpenAI SSE deltas into the internal ChatResponse", () => {
    const deltas: string[] = [];
    const thoughts: string[] = [];
    const parser = openaiChatCodec.createStreamParser({
      onDelta: (t) => deltas.push(t),
      onThinkingDelta: (t) => thoughts.push(t),
    });
    parser.feed({
      data: JSON.stringify({
        choices: [{ delta: { content: "Hello" } }],
      }),
    });
    parser.feed({
      data: JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "{\"" } }] } }],
      }),
    });
    parser.feed({
      data: JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "file_path\":\"a.ts\"}" } }] }, finish_reason: "tool_calls" }],
      }),
    });
    const result = parser.finish();
    expect(deltas.at(-1)).toBe("Hello");
    expect(result.choices[0]?.message.content).toBe("Hello");
    expect(result.choices[0]?.finish_reason).toBe("tool_calls");
    expect(result.choices[0]?.message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: '{"file_path":"a.ts"}' },
      },
    ]);
  });

  it("encodes multi-image attachments as image_url blocks and non-images as plain text", () => {
    const body = openaiChatCodec.encodeRequest({
      model: "gpt-4o",
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
    }) as { messages: Array<{ content: unknown }> };

    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "https://cdn.example/a.png" } },
      { type: "image_url", image_url: { url: "https://cdn.example/b.jpg" } },
      {
        type: "text",
        text: "[文件附件] notes.pdf (application/pdf): https://cdn.example/notes.pdf",
      },
    ]);
  });

  it("keeps plain text messages unchanged when there are no attachments", () => {
    const body = openaiChatCodec.encodeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi only" }],
      stream: false,
    }) as { messages: ChatMessage[] };
    expect(body.messages[0]).toEqual({ role: "user", content: "hi only" });
  });

  it("lists models with Bearer auth and OpenAI data[] shape", () => {
    expect(openaiChatCodec.listModelsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(openaiChatCodec.listModelsHeaders("sk-test")).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
    });
    expect(
      openaiChatCodec.parseModelList({
        data: [{ id: "gpt-4o", name: "GPT-4o" }],
      }),
    ).toEqual([{ id: "gpt-4o", name: "GPT-4o" }]);
    expect(
      openaiChatCodec.parseModelList({
        models: [{ id: "llama3" }],
      }),
    ).toEqual([{ id: "llama3", name: "llama3" }]);
    // display_name 可选：存在时透传，缺失时不产生该字段（不破坏 toEqual 断言）
    expect(
      openaiChatCodec.parseModelList({
        data: [{ id: "deepseek-chat", name: "deepseek-chat", display_name: "DeepSeek V4 Flash" }],
      }),
    ).toEqual([{ id: "deepseek-chat", name: "deepseek-chat", display_name: "DeepSeek V4 Flash" }]);
    expect(
      openaiChatCodec.parseModelList({
        data: [{ id: "m" }],
      }),
    ).toEqual([{ id: "m", name: "m" }]);
  });

  it("drops model entries without a usable id (Ollama /api/tags shape)", () => {
    // 只有 name 没有 id 的条目必须被过滤，否则 undefined id 会写入设置存储并触发 zod 失败
    expect(
      openaiChatCodec.parseModelList({
        models: [{ name: "llama3:latest" }, { id: "qwen2.5", name: "Qwen 2.5" }, { id: "   " }],
      }),
    ).toEqual([{ id: "qwen2.5", name: "Qwen 2.5" }]);
    // 非对象 / 数组形状异常时返回空列表而不是抛错
    expect(openaiChatCodec.parseModelList(null)).toEqual([]);
    expect(openaiChatCodec.parseModelList("nope")).toEqual([]);
    expect(openaiChatCodec.parseModelList({ data: "not-an-array" })).toEqual([]);
  });
});
