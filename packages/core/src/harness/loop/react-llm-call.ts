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
import { formatCurrentTaskContext, formatIterationBudgetHint } from "./react-prompt.ts";
import { applyStreamSnapshot } from "./streaming-snapshot.ts";
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
    ? {
        role: "system",
        content: tagCurrentTask(
          formatCurrentTaskContext(
            ctx.currentTask,
            ctx.opts.singleSpecTask,
            ctx.upstreamRelays?.get(ctx.currentTask.id),
            // 正在执行已批准的计划（activePlan 仅由 planner 批准分支赋值）：
            // 分解阶段遗留的只读类约束与计划正文不得再注入执行上下文，
            // 否则执行 agent 只朗读计划而不实施。
            Boolean(ctx.opts.activePlan),
          ),
        ),
      }
    : null;
  // Keep the initial system/context block contiguous for prefix caching. The
  // current task stays a system message before the user and tool conversation;
  // never move it past a non-system message or retain a previous task's turns.
  const systemPrefixLen = currentTaskMsg
    ? ctx.messages.findIndex((message) => message.role !== "system")
    : 0;
  const insertionIndex = systemPrefixLen === -1 ? ctx.messages.length : systemPrefixLen;
  const baseMessages = currentTaskMsg
    ? [...ctx.messages.slice(0, insertionIndex), currentTaskMsg, ...ctx.messages.slice(insertionIndex)]
    : ctx.messages;

  // 每轮把迭代预算告诉模型，让它自己安排剩余工具调用。
  // 计数取 termination 同源的 ctx.loopState.iteration（每个任务独立计数、
  // 任务切换时归零），与真正触发上限的判定一致；current 用 1 基展示。
  // 剩余 0（最后一轮）时 formatIterationBudgetHint 会输出强制性收尾指令
  // （本轮不得再调用工具、必须直接给出最终计划/结论），由这里原样送达，
  // 不需要额外分支。提示只拼进本次调用的 messages（追加在末尾以保住前缀
  // 缓存），不写入 ctx.messages / ctx.history，避免逐轮累加。
  const iterationHintMsg: ChatMessage = {
    role: "system",
    content: formatIterationBudgetHint(
      ctx.loopState.iteration + 1,
      ctx.terminationConfig.maxIterations,
      ctx.opts.singleSpecTask
        ? "single_spec_task"
        : ctx.opts.plannerLoop === true
        ? "planner"
        : ctx.opts.exploreLoop === true
          ? "explore"
          : "executor",
    ),
  };
  const messagesForCall = [...baseMessages, iterationHintMsg];

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
      // LLM 调用失败不是用户中止，但沿用 interrupted 终态。必须带上
      // blocked + blockedReason：子代理调度方（run-subagent）依赖这两个
      // 字段把真实原因（如 LLM HTTP 429 配额耗尽）透传给父级，否则
      // 父级只能看到"未产出报告"的误导性占位，用户无从排查。
      result: finalizeTerminal(ctx, {
        lastAssistant: ctx.lastAssistant,
        aborted: true,
        blocked: true,
        blockedReason: `LLM 调用失败：${msg}`,
        correctionCount: ctx.correctionCount,
      }, "interrupted"),
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
