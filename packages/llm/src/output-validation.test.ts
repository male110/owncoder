import { describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  sdkGenerate: vi.fn(),
  sdkStream: vi.fn(),
}));

vi.mock("./sdk-transport.js", () => transport);

import { chatCompletion, chatCompletionStream } from "./index.js";

const model = { baseUrl: "https://example.test/v1", model: "test-model" };
const messages = [{ role: "user" as const, content: "test" }];
const toolCall = {
  id: "call_1",
  type: "function" as const,
  function: { name: "test_tool", arguments: "{}" },
};

function response(content: string, withToolCall = false) {
  return {
    choices: [{
      message: {
        role: "assistant" as const,
        content,
        ...(withToolCall ? { tool_calls: [toolCall] } : {}),
      },
      finish_reason: withToolCall ? "tool_calls" : "stop",
    }],
  };
}

describe("LLM output validation", () => {
  it("accepts a tool-call-only response", async () => {
    transport.sdkGenerate.mockResolvedValue(response("", true));

    await expect(chatCompletion(model, messages)).resolves.toMatchObject({
      choices: [{ message: { tool_calls: [toolCall] } }],
    });
  });

  it("accepts text together with tool calls", async () => {
    transport.sdkGenerate.mockResolvedValue(response("I will use the tool.", true));

    await expect(chatCompletion(model, messages)).resolves.toMatchObject({
      choices: [{ message: { content: "I will use the tool.", tool_calls: [toolCall] } }],
    });
  });

  it("rejects a response with neither text nor tool calls", async () => {
    vi.useFakeTimers();
    transport.sdkGenerate.mockResolvedValue(response(""));

    const result = chatCompletion(model, messages);
    const assertion = expect(result).rejects.toThrow("No output generated");
    await vi.runAllTimersAsync();
    await assertion;

    vi.useRealTimers();
  });

  it("rejects a stream failure after retries", async () => {
    vi.useFakeTimers();
    transport.sdkStream.mockRejectedValue(new Error("stream failed"));

    const result = chatCompletionStream(model, messages);
    const assertion = expect(result).rejects.toThrow("stream failed");
    await vi.runAllTimersAsync();
    await assertion;

    vi.useRealTimers();
  });
});
