/**
 * Task Classification & Retry Utilities
 *
 * Provides:
 * 1. Task Classification — categorize a user request (type + complexity)
 * 2. Fallback/Retry — exponential backoff for transient LLM failures
 *
 * Note: multi-model routing (ModelCoordinator / routeModel) and speculative
 * execution were removed — they were effectively no-ops (always configured with
 * a single identical model and their results discarded).
 */

// ── Types ──────────────────────────────────────────────────

export interface TaskClassification {
  taskType: "simple_query" | "code_generation" | "code_explanation" | "debugging" | "refactoring" | "planning" | "verification" | "summarization";
  complexity: "low" | "medium" | "high";
  estimatedTokens: number;
  requiresTools: boolean;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  retryableStatuses: number[];
  /** Cancels pending attempts and retry backoff. */
  signal?: AbortSignal;
}

// ── Task Classifier ────────────────────────────────────────

/**
 * Classify a user request. Used for observability/trace metadata.
 */
export function classifyTask(
  userMessage: string,
  historyLength: number,
): TaskClassification {
  const lower = userMessage.toLowerCase();
  const length = userMessage.length;

  // Detect task type
  let taskType: TaskClassification["taskType"] = "simple_query";

  if (/^(what|how|why|explain|解释|说明|什么是)/i.test(lower)) {
    taskType = "code_explanation";
  } else if (/^(fix|debug|repair|解决|修复|bug|error)/i.test(lower)) {
    taskType = "debugging";
  } else if (/^(refactor|重构|rename|extract)/i.test(lower)) {
    taskType = "refactoring";
  } else if (/^(plan|design|架构|设计|规划|方案)/i.test(lower)) {
    taskType = "planning";
  } else if (/^(create|add|implement|write|generate|创建|添加|实现|写|生成)/i.test(lower)) {
    taskType = "code_generation";
  } else if (/^(check|verify|test|检查|验证|测试|review)/i.test(lower)) {
    taskType = "verification";
  } else if (/^(summarize|summary|总结|概括)/i.test(lower)) {
    taskType = "summarization";
  }

  // Detect complexity
  let complexity: TaskClassification["complexity"] = "medium";
  if (length < 50 && historyLength < 2) {
    complexity = "low";
  } else if (length > 500 || historyLength > 10) {
    complexity = "high";
  }

  if (
    taskType === "debugging" ||
    taskType === "refactoring" ||
    taskType === "planning"
  ) {
    complexity = "high";
  }

  // Estimate tokens
  const estimatedTokens = Math.ceil(length * 0.3) + historyLength * 200;

  // Determine if tools are needed
  const requiresTools =
    taskType !== "simple_query" &&
    taskType !== "summarization" &&
    taskType !== "code_explanation";

  return {
    taskType,
    complexity,
    estimatedTokens,
    requiresTools,
  };
}

// ── Retry Manager ──────────────────────────────────────────

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  retryableStatuses: [429, 500, 502, 503, 504],
};

function signalAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("LLM request aborted");
}

function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delay));
  if (signal.aborted) return Promise.reject(signalAbortError(signal));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signalAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Execute a function with retry logic and exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: Partial<RetryPolicy> = {},
  onRetry?: (attempt: number, error: Error, delay: number) => void,
): Promise<{ result: T; retries: number }> {
  const p = { ...DEFAULT_RETRY_POLICY, ...policy };
  let lastError: Error | undefined;
  let retries = 0;

  for (let attempt = 0; attempt <= p.maxRetries; attempt++) {
    if (p.signal?.aborted) throw signalAbortError(p.signal);

    try {
      const result = await fn();
      return { result, retries };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      retries = attempt;

      // Never retry a caller cancellation or an AbortError.
      if (p.signal?.aborted || lastError.name === "AbortError") throw lastError;
      if (attempt === p.maxRetries) break;

      // Check if retryable based on HTTP status.
      const statusMatch = lastError.message.match(/HTTP (\d+)/);
      const status = statusMatch ? Number(statusMatch[1]) : null;
      if (status && !p.retryableStatuses.includes(status)) {
        break; // Non-retryable error
      }

      const delay = Math.min(
        p.baseDelay * Math.pow(p.backoffMultiplier, attempt),
        p.maxDelay,
      );

      onRetry?.(attempt + 1, lastError, delay);
      await waitForRetry(delay, p.signal);
    }
  }

  throw lastError ?? new Error("Unknown error after retries");
}
