import { describe, expect, it } from "vitest";
import { googleGeminiCodec } from "./google-gemini.ts";

describe("googleGeminiCodec", () => {
  it("encodes Gemini requests and uses the model action URL", () => {
    expect(googleGeminiCodec.buildUrl("https://generativelanguage.googleapis.com/v1beta", "gemini-2.0-flash")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    );
    expect(googleGeminiCodec.buildStreamUrl?.("https://generativelanguage.googleapis.com/v1beta", "gemini-2.0-flash")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    );
    const body = googleGeminiCodec.encodeRequest({
      model: "gemini-2.0-flash",
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "hello" },
      ],
      tools: [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } }],
      stream: true,
    }) as Record<string, any>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: "Be concise" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
    expect(body.tools[0].functionDeclarations[0].name).toBe("read_file");
  });

  it("decodes text and function calls", () => {
    const result = googleGeminiCodec.decodeResponse({
      responseId: "resp_1",
      candidates: [{ content: { parts: [{ text: "done" }, { functionCall: { name: "read_file", args: { path: "a.ts" } } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    });
    expect(result.choices[0]?.message.content).toBe("done");
    expect(result.choices[0]?.message.tool_calls?.[0]?.function).toEqual({ name: "read_file", arguments: '{"path":"a.ts"}' });
  });

  it("parses Gemini SSE chunks", () => {
    const deltas: string[] = [];
    const parser = googleGeminiCodec.createStreamParser({ onDelta: (text) => deltas.push(text) });
    parser.feed({ data: JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] }) });
    parser.feed({ data: JSON.stringify({ candidates: [{ finishReason: "STOP" }] }) });
    expect(parser.finish().choices[0]?.message.content).toBe("Hi");
    expect(deltas).toEqual(["Hi"]);
  });
});
