import { describe, expect, it } from "vitest";

import { googleGeminiCodec } from "./protocol/google-gemini.js";
import { openaiChatCodec } from "./protocol/openai-chat.js";
import { openaiResponsesCodec } from "./protocol/openai-responses.js";

const toolCall = {
  id: "call_1",
  type: "function" as const,
  function: { name: "test_tool", arguments: "{}" },
};

describe("LLM output validation", () => {
  it("openai-chat accepts a tool-call-only response", () => {
    const decoded = openaiChatCodec.decodeResponse({
      choices: [{ message: { role: "assistant", content: "", tool_calls: [toolCall] }, finish_reason: "tool_calls" }],
    });
    expect(decoded.choices[0]?.message.tool_calls).toEqual([toolCall]);
  });

  it("openai-chat accepts text together with tool calls", () => {
    const decoded = openaiChatCodec.decodeResponse({
      choices: [{
        message: { role: "assistant", content: "I will use the tool.", tool_calls: [toolCall] },
        finish_reason: "tool_calls",
      }],
    });
    expect(decoded.choices[0]?.message.content).toBe("I will use the tool.");
    expect(decoded.choices[0]?.message.tool_calls).toEqual([toolCall]);
  });

  it("openai-chat rejects a response without choices", () => {
    expect(() => openaiChatCodec.decodeResponse({ choices: [] })).toThrow(/no choices/i);
  });

  it("google-gemini rejects a response with neither text nor tool calls", () => {
    expect(() =>
      googleGeminiCodec.decodeResponse({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }),
    ).toThrow(/no output/i);
  });

  it("openai-responses rejects a response with neither text nor tool calls", () => {
    expect(() => openaiResponsesCodec.decodeResponse({ id: "resp_1", output: [] })).toThrow(/no output/i);
  });

  it("openai-chat stream parser rejects a completely empty stream", () => {
    const parser = openaiChatCodec.createStreamParser({});
    expect(() => parser.finish()).toThrow(/empty stream/i);
  });
});
