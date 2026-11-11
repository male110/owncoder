import { afterEach, describe, expect, it, vi } from "vitest";

import { chatCompletion, chatCompletionStream, type ModelRef } from "./index.ts";
import type { ChatMessage } from "./types.ts";

const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

const ref: ModelRef = {
  baseUrl: "https://gateway.example.com/v1",
  model: "ling-3.1-flash",
  apiKey: "sk-test",
};

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

const okBody = {
  choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
};

/** 首次挂起直到不活跃超时触发，其后立即成功——与 timeout.test.ts 的模拟一致。 */
function hangThenOk(okResponse: Response): ReturnType<typeof vi.fn> {
  let calls = 0;
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    const signal = init?.signal as AbortSignal | undefined;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
    if (calls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
          once: true,
        });
      });
    }
    return Promise.resolve(okResponse);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("chatCompletion onRetry", () => {
  it("不活跃超时重试前上报倒计时（attempt/delayMs/reason=timeout）", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangThenOk(jsonResponse(okBody)));
    const onRetry = vi.fn();

    const promise = chatCompletion(ref, messages, { timeout: 20_000, onRetry });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      maxRetries: 3,
      delayMs: 3_000,
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(3_000);

    const result = await promise;
    expect(result.choices[0]?.message.content).toBe("ok");
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("网络错误按 3/6 秒递增退避，每次都通知界面", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return jsonResponse(okBody);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();

    const promise = chatCompletion(ref, messages, { onRetry });
    await vi.advanceTimersByTimeAsync(1);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      maxRetries: 3,
      delayMs: 3_000,
      reason: "network",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 2,
      maxRetries: 3,
      delayMs: 6_000,
      reason: "network",
    });
    await vi.advanceTimersByTimeAsync(6_000);

    await promise;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("可重试 HTTP 状态携带状态码，用户取消则完全不通知", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return calls === 1 ? jsonResponse({ error: "overloaded" }, { status: 503 }) : jsonResponse(okBody);
      }),
    );
    const onRetry = vi.fn();

    const promise = chatCompletion(ref, messages, { onRetry });
    await vi.advanceTimersByTimeAsync(1);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      maxRetries: 3,
      delayMs: 3_000,
      reason: "http_503",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await promise;

    const ac = new AbortController();
    const retryAfterCancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
            once: true,
          });
        });
      }),
    );
    const cancelled = chatCompletion(ref, messages, { signal: ac.signal, onRetry: retryAfterCancel });
    await vi.advanceTimersByTimeAsync(1);
    ac.abort(new Error("user cancelled"));
    await expect(cancelled).rejects.toThrow(/user cancelled|aborted/i);
    expect(retryAfterCancel).not.toHaveBeenCalled();
  });
});

describe("chatCompletionStream onRetry", () => {
  it("流式可重试 HTTP 与读取超时都上报倒计时", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return calls === 1
          ? new Response("overloaded", { status: 503, headers: { "content-type": "text/plain" } })
          : new Response(
              'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
      }),
    );
    const onRetry = vi.fn();

    const promise = chatCompletionStream(ref, messages, { onRetry });
    await vi.advanceTimersByTimeAsync(1);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      maxRetries: 3,
      delayMs: 3_000,
      reason: "http_503",
    });
    await vi.advanceTimersByTimeAsync(3_000);

    const result = await promise;
    expect(result.choices[0]?.message.content).toBe("ok");
  });

  it("流式挂起触发不活跃超时后通知重试并最终成功", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      hangThenOk(
        new Response(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );
    const onRetry = vi.fn();

    const promise = chatCompletionStream(ref, messages, { timeout: 20_000, onRetry });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      maxRetries: 3,
      delayMs: 3_000,
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(3_000);

    const result = await promise;
    expect(result.choices[0]?.message.content).toBe("ok");
  });
});
