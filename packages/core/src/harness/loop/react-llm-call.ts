/**
 * ReAct 循环的单轮 LLM 调用。
 *
 * 从 react.ts 拆分：原 runReActLoop 内的 withRetry + chatCompletionStream 调用，
 * 含 currentTask 语义消息注入、空白响应兜底抛错（复用既有重试逻辑）、
 * 中止时保留已生成文本、失败/中止的终态封装。
 * 调用结果以显式 outcome 返回：ok 携带本轮响应与用量，exit 携带终态结果。
 */
import { chatCompletionStream, writeEventLog, type ChatMessage } from "@owncoder/llm";
import { withRetry } from "../model-coordinator.ts";
import { normalizeUsage, type NormalizedUsage } from "../observability.ts";
import { formatCurrentTaskContext } from "./react-prompt.ts";
import { applyStreamSnapshot } from "./streaming-snapshot";
import { applyRunEvent, finalizeTerminal } from "./react-finalize.ts";
import type { ReActLoopContext, ReActReturn } from "./react-loop-context.ts";

export interface CallModelOk {
  kind: "ok";
  response: Awaited<ReturnType<typeof chatCompletionStream>>;
  content: string;
  finishReason: string | null;
  responseUsage: NormalizedUsage;
}

export interface CallModelExit {
  kind: "exit";
  result: ReActReturn;
}

export type CallModelOutcome = CallModelOk | CallModelExit;

/** 执行第 i 轮 LLM 调用（含重试与空响应兜底）；exit 表示循环应终止。 */
export async function callModelForIteration(
  ctx: ReActLoopContext,
  i: number,
): Promise<CallModelOutcome> {
  const llmSpanId = ctx.tracer.startSpan(`llm_call_${i}`, "llm_call", {
    iteration: i,
    model: ctx.model.model,
  });

  // Import message tagging utilities for semantic wrapping
  const { tagCurrentTask } = await import("../message-tags.js");

  const currentTaskMsg: ChatMessage | null = ctx.currentTask
    ? { role: "system", content: tagCurrentTask(formatCurrentTaskContext(ctx.currentTask)) }
    : null;
  // Keep the initial system/context block contiguous for prefix caching. The
  // current task stays a system message before the user and tool conversation;
  // never move it past a non-system message or retain a previous task's turns.
  const systemPrefixLen = currentTaskMsg
    ? ctx.messages.findIndex((message) => message.role !== "system")
    : 0;
  const insertionIndex = systemPrefixLen === -1 ? ctx.messages.length : systemPrefixLen;
  const messagesForCall = currentTaskMsg
    ? [...ctx.messages.slice(0, insertionIndex), currentTaskMsg, ...ctx.messages.slice(insertionIndex)]
    : ctx.messages;

  if (ctx.opts.budget) {
    const modelCharge = ctx.opts.budget.charge("modelCalls");
    if (!modelCharge.ok) {
      return {
        kind: "exit",
        result: finalizeTerminal(ctx, {
          lastAssistant: ctx.lastAssistant,
          aborted: false,
          blocked: true,
          blockedReason: modelCharge.reason ?? "model-call budget exhausted",
          correctionCount: ctx.correctionCount,
        }, "failed"),
      };
    }
  }

  let response: Awaited<ReturnType<typeof chatCompletionStream>>;
  let currentTurnAccumulated = "";
  try {
    const { result, retries: llmRetries } = await withRetry(
      async () => {
        const r = await chatCompletionStream(ctx.model, messagesForCall, {
          tools: ctx.toolsFinal,
          signal: ctx.opts.signal,
          apiKey: ctx.opts.llmApiKey,
          purpose: `react_loop#${ctx.stageId}#${i}`,
          taskId: ctx.opts.sessionId,
          onDelta: (text: string) => { currentTurnAccumulated = applyStreamSnapshot(currentTurnAccumulated, text); ctx.opts.onEvent?.({ type: "assistant_delta", text }); },
          onThinkingDelta: (text: string) => ctx.opts.onEvent?.({ type: "thinking_delta", text }),
          // LLM 层内部重试（超时/网络/可重试 HTTP）也要让用户看到倒计时
          onRetry: (info) => ctx.opts.onEvent?.({ type: "llm_retry", ...info }),
          thinking: ctx.thinking,
        });
        // 空白响应兜底：模型既没有返回文本内容、也没有返回任何工具调用时，
        // 视为本次调用失败并主动抛错。该异常会被 withRetry 捕获，复用既有的
        // 失败重试逻辑（最多重试 llmMaxRetries 次），而不是把空回复当成正常结束。
        const firstMessage = r.choices[0]?.message;
        const hasTextContent = !!(firstMessage?.content && firstMessage.content.trim());
        const hasToolCalls = !!(firstMessage?.tool_calls && firstMessage.tool_calls.length > 0);
        if (!hasTextContent && !hasToolCalls) {
          throw new Error("LLM 返回空响应（无文本内容且无工具调用）");
        }
        return r;
      },
      { maxRetries: ctx.llmMaxRetries, baseDelay: 2000, signal: ctx.opts.signal },
      (attempt, err, delay) => {
        ctx.tracer.addEvent(llmSpanId, "retry", {
          attempt,
          error: err.message,
          delayMs: delay,
        });
        ctx.opts.onEvent?.({
          type: "llm_retry",
          attempt,
          maxRetries: ctx.llmMaxRetries,
          delayMs: delay,
          reason: err.message,
        });
      },
    );
    response = result as typeof response;
    ctx.tracer.endSpan(llmSpanId, "ok");
    applyRunEvent(ctx, {
      type: "observability",
      taskId: ctx.opts.sessionId,
      modelSamples: 1,
      retries: llmRetries > 0 ? llmRetries : 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.tracer.recordError(llmSpanId, msg);
    if (ctx.opts.signal?.aborted) {
      writeEventLog({
        category: "abort",
        message: `ReAct loop LLM 调用被中止 (iteration ${i})`,
        details: {
          stageId: ctx.stageId,
          iteration: i,
          accumulatedChars: currentTurnAccumulated.length,
          errorMsg: msg,
        },
      });
      // 保留中断前已生成的 assistant 文本，避免 cancel 丢失用户已看到的回复
      if (currentTurnAccumulated.trim()) {
        ctx.history.push({ role: "assistant", content: currentTurnAccumulated });
        ctx.lastAssistant = currentTurnAccumulated;
      }
      return {
        kind: "exit",
        result: finalizeTerminal(ctx, { lastAssistant: ctx.lastAssistant, aborted: true, correctionCount: ctx.correctionCount }, "interrupted"),
      };
    }
    writeEventLog({
      category: "react_loop",
      message: `ReAct loop LLM 调用失败 (iteration ${i}): ${msg}`,
      details: {
        stageId: ctx.stageId,
        iteration: i,
        error: msg,
        messagesCount: ctx.messages.length,
      },
    });
    ctx.opts.onEvent?.({ type: "error", message: msg });
    return {
      kind: "exit",
      result: finalizeTerminal(ctx, { lastAssistant: ctx.lastAssistant, aborted: true, correctionCount: ctx.correctionCount }, "interrupted"),
    };
  }

  const choice = response.choices[0]!.message;
  const finishReason = response.choices[0]?.finish_reason ?? null;
  const content = choice.content ?? "";
  const responseUsage = normalizeUsage(
    response.usage,
    messagesForCall.map((message) => String(message.content ?? "")).join("\n"),
    `${content}${choice.tool_calls ? JSON.stringify(choice.tool_calls) : ""}`,
  );
  ctx.tracer.recordTokenUsage(responseUsage.promptTokens, responseUsage.completionTokens);
  ctx.lastAssistant = content;
  return { kind: "ok", response, content, finishReason, responseUsage };
}
