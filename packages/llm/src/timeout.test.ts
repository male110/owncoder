import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chatCompletion,
  chatCompletionStream,
  isLlmTimeoutError,
  LlmTimeoutError,
  type ModelRef,
} from "./index.ts";
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

function sseResponse(chunks: string[]): Response {
  return new Response(chunks.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const okBody = {
  choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
};

const okSse = sseResponse([
  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
]);

/**
 * 模拟真实 fetch：
 * - 调用时 signal 已 aborted → 立即以 reason 拒绝（真实 fetch 语义）
 * - 挂起的调用在 signal 触发时以 reason 拒绝
 * - hang="first" 仅第一次挂起；hang="all" 每次都挂起
 */
function abortableFetch(
  okResponse: Response,
  hang: "first" | "all" = "first",
): ReturnType<typeof vi.fn> {
  let calls = 0;
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    const signal = init?.signal as AbortSignal | undefined;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
    const shouldHang = hang === "all" || (hang === "first" && calls === 1);
    if (!shouldHang) return Promise.resolve(okResponse);
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  });
}

describe("LlmTimeoutError", () => {
  it("carries the historical timeout message", () => {
    const e = new LlmTimeoutError(120_000);
    expect(e.name).toBe("LlmTimeoutError");
    expect(e.message).toBe("LLM request timed out after 120s without activity");
  });

  it("isLlmTimeoutError recognizes instances, names and wrapped messages", () => {
    expect(isLlmTimeoutError(new LlmTimeoutError(1000))).toBe(true);
    const byName = new Error("LLM request timed out after 120s without activity");
    byName.name = "LlmTimeoutError";
    expect(isLlmTimeoutError(byName)).toBe(true);
    // 某些 Node 版本把 abort reason 的 message 复制到新 Error 上
    expect(isLlmTimeoutError(new Error("LLM request timed out after 120s without activity"))).toBe(true);
    // AbortError + 超时文案（reason 落在 message 或 cause 上）
    const wrapped = new Error("LLM request timed out after 120s without activity");
    wrapped.name = "AbortError";
    expect(isLlmTimeoutError(wrapped)).toBe(true);
    // 无关错误与用户取消不误判
    expect(isLlmTimeoutError(new Error("boom"))).toBe(false);
    expect(isLlmTimeoutError(new TypeError("fetch failed"))).toBe(false);
    const userAbort = new Error("user cancelled");
    userAbort.name = "AbortError";
    expect(isLlmTimeoutError(userAbort)).toBe(false);
  });
});

describe("chatCompletion timeout handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries on inactivity timeout with a fresh signal and succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = abortableFetch(jsonResponse(okBody));
    vi.stubGlobal("fetch", fetchMock);

    const promise = chatCompletion(ref, messages, { timeout: 20_000 });
    // 第一次尝试：20s 不活跃超时触发，fetch 以 LlmTimeoutError 拒绝
    await vi.advanceTimersByTimeAsync(20_000);
    // 3s 退避后第二次尝试：signal 必须是全新的（未 aborted），fetch 成功
    await vi.advanceTimersByTimeAsync(3_000);

    const result = await promise;
    expect(result.choices[0]?.message.content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 第二次调用拿到的 signal 不能带着第一次的 aborted 状态
    const secondSignal = fetchMock.mock.calls[1]![0] instanceof Request
      ? undefined
      : (fetchMock.mock.calls[1]![1] as RequestInit | undefined)?.signal as AbortSignal | undefined;
    expect(secondSignal?.aborted).toBe(false);
  });

  it("throws LlmTimeoutError after exhausting internal retries", async () => {
    vi.useFakeTimers();
    const fetchMock = abortableFetch(jsonResponse(okBody), "all");
    vi.stubGlobal("fetch", fetchMock);

    const promise = chatCompletion(ref, messages, { timeout: 20_000 });
    // 4 次尝试（20s 各）+ 3/6/9s 退避
    await vi.advanceTimersByTimeAsync(4 * 20_000 + 3_000 + 6_000 + 9_000 + 1_000);

    await expect(promise).rejects.toThrow(/LLM request timed out after 20s without activity/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("chatCompletionStream timeout handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries on inactivity timeout and succeeds on the next attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = abortableFetch(okSse);
    vi.stubGlobal("fetch", fetchMock);

    const promise = chatCompletionStream(ref, messages, { timeout: 20_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(3_000);

    const result = await promise;
    expect(result.choices[0]?.message.content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the caller aborts", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const fetchMock = abortableFetch(okSse, "all");
    vi.stubGlobal("fetch", fetchMock);

    const promise = chatCompletionStream(ref, messages, { signal: ac.signal, timeout: 20_000 });
    // 先让请求挂出去，再由用户取消
    await vi.advanceTimersByTimeAsync(5_000);
    ac.abort(new Error("user cancelled"));

    await expect(promise).rejects.toThrow(/user cancelled|aborted/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
