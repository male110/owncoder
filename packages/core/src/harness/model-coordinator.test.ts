import { describe, expect, it, vi } from "vitest";
import { LlmTimeoutError } from "@owncoder/llm";

import { withRetry } from "./model-coordinator.ts";

describe("withRetry", () => {
  it("retries LlmTimeoutError with backoff and eventually succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new LlmTimeoutError(120_000);
      return "ok";
    });
    const { result, retries } = await withRetry(fn, { maxRetries: 3, baseDelay: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    // retries 语义：最后一次失败尝试的序号（既有约定，成功后不再更新）
    expect(retries).toBe(1);
  });

  it("exhausts retries on persistent LlmTimeoutError and rethrows it", async () => {
    const fn = vi.fn(async () => {
      throw new LlmTimeoutError(120_000);
    });
    await expect(
      withRetry(fn, { maxRetries: 2, baseDelay: 1 }),
    ).rejects.toThrow(/LLM request timed out after 120s without activity/);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a genuine AbortError (caller cancellation)", async () => {
    const fn = vi.fn(async () => {
      throw new DOMException("The user aborted a request", "AbortError");
    });
    await expect(withRetry(fn, { maxRetries: 3, baseDelay: 1 })).rejects.toThrow(/aborted/i);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries an AbortError carrying our timeout message (wrapped abort reason)", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 2) {
        // 某些 Node 版本把我方超时 reason 包装成 AbortError
        const e = new Error("LLM request timed out after 120s without activity");
        e.name = "AbortError";
        throw e;
      }
      return "ok";
    });
    const { result } = await withRetry(fn, { maxRetries: 3, baseDelay: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the caller signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn(async () => "ok");
    await expect(
      withRetry(fn, { maxRetries: 3, baseDelay: 1, signal: ac.signal }),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(0);
  });
});
