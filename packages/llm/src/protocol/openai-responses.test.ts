import { describe, expect, it } from "vitest";
import { openaiResponsesCodec } from "./openai-responses.ts";

const input = {
  model: "gpt-4.1",
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [{ type: "function" as const, function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } }],
  stream: true,
};

describe("openaiResponsesCodec", () => {
  it("encodes Responses input and keeps the existing model settings shape", () => {
    expect(openaiResponsesCodec.buildUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/responses");
    const body = openaiResponsesCodec.encodeRequest(input) as Record<string, any>;
    expect(body.model).toBe("gpt-4.1");
    expect(body.input).toEqual([{ role: "user", content: "hello" }]);
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBe(16384);
    expect(body.tools).toEqual([{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object" } }]);
  });

  it("decodes text and function calls from a non-stream response", () => {
    const result = openaiResponsesCodec.decodeResponse({
      id: "resp_1",
      output_text: "done",
      output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" }],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });
    expect(result.choices[0]?.message.content).toBe("done");
    expect(result.choices[0]?.message.tool_calls?.[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
    });
  });

  it("parses Responses SSE text and function call events", () => {
    const deltas: string[] = [];
    const parser = openaiResponsesCodec.createStreamParser({ onDelta: (text) => deltas.push(text) });
    parser.feed({ event: "response.output_text.delta", data: JSON.stringify({ type: "response.output_text.delta", delta: "Hi" }) });
    parser.feed({ event: "response.output_item.added", data: JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "call_1", name: "read_file" } }) });
    parser.feed({ event: "response.function_call_arguments.delta", data: JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "call_1", delta: "{}" }) });
    parser.feed({ event: "response.completed", data: JSON.stringify({ type: "response.completed" }) });
    const result = parser.finish();
    expect(deltas).toEqual(["Hi"]);
    expect(result.choices[0]?.message.content).toBe("Hi");
    expect(result.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("read_file");
  });
});
