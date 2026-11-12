import { afterEach, describe, expect, it, vi } from "vitest";

import { chatCompletionStream, isLlmDecodeError, type ModelRef } from "./index.ts";
import type { ChatMessage } from "./types.ts";

// 用一个可切换 finish() 行为的 codec 替换注册表：现有四个协议的 finish()
// 只会抛 "empty stream"，无法覆盖"非空流解码失败"这条分支。
vi.mock("./protocol/registry.js", () => {
  const codec = {
    format: "openai-chat",
    buildUrl: (baseUrl: string) => `${baseUrl}/chat/completions`,
    buildHeaders: () => ({ "Content-Type": "application/json" }),
    encodeRequest: () => ({ model: "m", messages: [], stream: true }),
    decodeResponse: () => {
      throw new Error("unused");
    },
    createStreamParser: () => {
      let fed = false;
      return {
        feed: (event: { data: string }) => {
          // 与真实 parser 一致：[DONE] 哨兵不算模型产出
          if (event.data && event.data !== "[DONE]") fed = true;
          return true;
        },
        finish: () => {
          if (!fed) throw new Error("empty stream");
          throw new Error("LLM returned no choices");
        },
      };
    },
    shouldFallbackToNonStream: () => false,
    listModelsUrl: (baseUrl: string) => `${baseUrl}/models`,
    listModelsHeaders: () => ({}),
    parseModelList: () => [],
  };
  return { getCodec: () => codec, listCodecs: () => [codec] };
});

const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

const ref: ModelRef = {
  baseUrl: "https://gateway.example.com/v1",
  model: "ling-3.1-flash",
  apiKey: "sk-test",
};

function sseResponse(chunks: string[]): Response {
  return new Response(chunks.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("chatCompletionStream 解码失败", () => {
  it("parser.finish() 的解码错误包成 LlmDecodeError（不可重试语义）", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(sseResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n'])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await chatCompletionStream(ref, messages).catch((e: unknown) => e);
    expect(isLlmDecodeError(error)).toBe(true);
    expect((error as Error).message).toBe("LLM returned no choices");
    // 解码失败由服务端返回内容决定，LLM 层自身也不应重试
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("空流仍保留普通 Error，不被误判为解码失败", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(sseResponse(["data: [DONE]\n\n"])));
    vi.stubGlobal("fetch", fetchMock);

    const promise = chatCompletionStream(ref, messages);
    const assertion = expect(promise).rejects.toThrow(/empty stream/i);
    // 空流按既有语义在 LLM 层内部退避重试（3s/6s/9s）后抛出普通 Error
    await vi.advanceTimersByTimeAsync(3_000 + 6_000 + 9_000 + 1_000);

    const error = await promise.catch((e: unknown) => e);
    await assertion;
    expect(isLlmDecodeError(error)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
