/**
 * LLM 层错误类型与判定函数。
 *
 * 独立成模块（而不是放在 index.ts）是因为 protocol/* 的 codec 也要抛出这些
 * 错误，而 index.ts 依赖 protocol/registry.ts → codec，直接反向 import 会形成
 * 循环依赖。
 */

/**
 * LLM 请求不活跃超时（我方定时器触发，区别于用户取消）。
 * harness 层的 withRetry 据此把超时当作可重试的临时故障，按指数退避
 * 重试，而不是像用户取消一样立即终止。
 */
export class LlmTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s without activity`);
    this.name = "LlmTimeoutError";
  }
}

/**
 * 响应体解析/解码失败（JSON 语法错误、协议字段缺失、网关把错误塞进 200 响应体，
 * 含 SSE 流内的 event:error 服务端错误事件）。
 * 这类失败由服务端返回内容决定，重试同一请求只会得到同样的结果，
 * 因此必须立即抛出，不能走网络错误的退避重试路径。
 */
export class LlmDecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmDecodeError";
  }
}

/** 判断错误是否为响应体解码失败（不可重试）。 */
export function isLlmDecodeError(e: unknown): boolean {
  return e instanceof LlmDecodeError || (e instanceof Error && e.name === "LlmDecodeError");
}

/** 判断错误是否为我方不活跃超时（含被 AbortError/普通 Error 包装的情况）。 */
export function isLlmTimeoutError(e: unknown): boolean {
  if (e instanceof LlmTimeoutError) return true;
  if (e instanceof Error) {
    if (e.name === "LlmTimeoutError") return true;
    // 某些 Node 版本/流读取路径会把 abort reason 的 message 复制到新错误上，
    // 用消息特征兜底识别（该文案为 LLM 层独有，网关错误不会包含）。
    if (/timed out after \d+s without activity/.test(e.message)) return true;
    const cause = (e as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && /timed out after \d+s without activity/.test(cause.message)) {
      return true;
    }
  }
  return false;
}
