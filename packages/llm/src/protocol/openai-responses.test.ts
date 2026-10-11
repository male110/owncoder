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

  it("将不同的 item_id 与 call_id 关联到同一次调用", () => {
    const parser = openaiResponsesCodec.createStreamParser({});
    parser.feed({ data: JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file" } }) });
    parser.feed({ data: JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' }) });
    parser.feed({ data: JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"a.ts"}' }) });
    expect(parser.finish().choices[0]?.message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
    ]);
  });

  it("从完成事件恢复完整参数，且不重复拼接增量", () => {
    const parser = openaiResponsesCodec.createStreamParser({});
    parser.feed({ data: JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file" } }) });
    parser.feed({ data: JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' }) });
    parser.feed({ data: JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"path":"a.ts"}' }) });
    parser.feed({ data: JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' } }) });
    expect(parser.finish().choices[0]?.message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
    ]);
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

  it("不会让空的 done 事件覆盖已累积的参数", () => {
    const parser = openaiResponsesCodec.createStreamParser({});
    // 1. 创建调用
    parser.feed({ data: JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file" } }) });
    // 2. 通过 delta 累积完整参数
    parser.feed({ data: JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"test.ts"}' }) });
    // 3. done 事件携带空对象，不应覆盖
    parser.feed({ data: JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{}" }) });
    // 4. output_item.done 携带空 arguments 字段
    parser.feed({ data: JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" } }) });
    const result = parser.finish();
    expect(result.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe('{"path":"test.ts"}');
  });

  it("处理服务器直接发送 done 事件而无 delta 的情况", () => {
    const parser = openaiResponsesCodec.createStreamParser({});
    // 直接发送包含完整参数的 done 事件
    parser.feed({ data: JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "call_1", name: "git_status" } }) });
    parser.feed({ data: JSON.stringify({ type: "response.function_call_arguments.done", call_id: "call_1", arguments: '{"detailed":true}' }) });
    const result = parser.finish();
    expect(result.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe('{"detailed":true}');
  });
});
