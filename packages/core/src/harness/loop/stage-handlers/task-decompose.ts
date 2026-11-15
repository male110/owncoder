/**
 * Task decomposition stage handler and related utilities.
 *
 * This module handles the task_decompose pipeline node, which analyzes the user's
 * request and breaks it down into tasks with execution guidance and dependencies.
 * The decomposition result feeds the subsequent ReAct task driver.
 *
 * 拆分说明：会话历史解析（decompose-history.ts）、分解上下文装配（decompose-context.ts）、
 * 答案解析与兜底分解（decompose-answer.ts）、历史相关度召回（decompose-relevance.ts）
 * 已分别移入同目录簇模块；本文件保留 stage 入口核心逻辑并原样转供全部历史导出，
 * 消费方导入路径不变。
 */

import {
  assertLlmAuth,
  chatCompletionStream,
  writeEventLog,
  type ChatMessage,
} from "@owncoder/llm";
import {
  BUILTIN_TASK_DECOMPOSE_PROMPT,
  type ModelRef,
} from "@owncoder/settings";
import { contextBudgets } from "../../budget.ts";
import { normalizeUsage } from "../../observability.ts";
import type { Tracer } from "../../observability.ts";
import {
  logReasoningStep,
  type AgentPlan,
  type ReasoningTrace,
} from "../../agent-reasoning.ts";
import { MemoryManager } from "../../memory.ts";
import { withRetry } from "../../model-coordinator.ts";
import { emitStage, resolveStageModel } from "../stages.ts";
import type { AgentLoopOpts } from "../types.ts";
import type { TaskItem } from "../../../plans.ts";
import type { StageHandler } from "./types.ts";
import { DISPATCH_AGENT_TOOL_DEF } from "../../enhanced-tools/subagent.ts";
import { PLANNER_SUBAGENT_TYPE } from "../../subagent/planner-subagent.ts";
import { runAgentPlanner } from "./planner.ts";
import type { ToolCall } from "@owncoder/llm";
import {
  collectToolCallsFromTurns,
  persistDecomposeRound,
  type PersistedDecompose,
} from "../../../turn-rounds.ts";
import { buildDecomposeContext } from "./decompose-context.ts";
import {
  buildFallbackRawDecompose,
  recoverEmptyDecomposeTasks,
  parseDecomposeAnswer,
  collapsePseudoLinearTasks,
  containsParsableJson,
} from "./decompose-answer.ts";
import { boundRelevantHistory, packFallbackRelevantHistory } from "./decompose-relevance.ts";

export {
  isCurrentCodeBehaviorInquiry,
  isPreciseLocatedRequest,
  extractStructuredHistory,
} from "./decompose-history.ts";
export {
  type BuildDecomposeContextOptions,
  buildDecomposeContext,
} from "./decompose-context.ts";
export {
  buildFallbackRawDecompose,
  recoverEmptyDecomposeTasks,
  parseDecomposeAnswer,
  collapsePseudoLinearTasks,
} from "./decompose-answer.ts";
export {
  RELEVANT_HISTORY_SCORE_THRESHOLD,
  rankAndFilterByRelevance,
  estimateTextRelevance,
  packFallbackRelevantHistory,
} from "./decompose-relevance.ts";

/** 兼容旧返回结构；当前分解不再生成独立的 turnInformationTask。 */
function buildTurnInformationTask(): TaskItem | null {
  return null;
}

// ── Main Task Decompose Function ───────────────────────────────────

export async function runTaskDecompose(
  opts: AgentLoopOpts,
  model: ModelRef,
  tracer: Tracer,
  memory: MemoryManager,
  reasoningTrace: ReasoningTrace,
  budgets: ReturnType<typeof contextBudgets>,
  prompt?: string,
  messages?: ChatMessage[],
  allowPlanner = true,
): Promise<{ 
  task: TaskItem | null; 
  decomposeTokens: number;
  planToolCall?: ToolCall;
  invalidToolCall?: boolean;
  rawDecompose?: {
    intent: string;
    userConstraints?: string[];
    /** 任务相关历史：与 tasks 同级，简单任务无分解时仍有历史可复用。 */
    relevantHistory?: string;
    tasks: Array<{
      id: string;
      title?: string;
      /** 执行指引：指导下属如何完成该任务。 */
      executionGuidance: string;
      dependsOn?: string[];
      kind?: "implementation" | "verification";
    }>;
  };
  fallback?: boolean;
}> {
  // Track how many tokens the decomposition pushes into messages so the
  // downstream ReAct loop can deduct them from the dynamic-segment budget.
  let decomposeTokens = 0;

  const planSpanId = tracer.startSpan("task_decomposition", "internal");
  // Runtime always uses the English decompose prompt. When the pipeline node
  // explicitly supplies `prompt`, that override wins.
  const systemPrompt = prompt?.trim() || BUILTIN_TASK_DECOMPOSE_PROMPT;
  try {
    assertLlmAuth(model, opts.llmApiKey);
    const { tagUserInput } = await import("../../message-tags.js");
    const currentAttachments = (opts.attachments ?? [])
      .filter((attachment, index, all) => all.findIndex((item) => item.url === attachment.url) === index);
    const plannerAvailable = allowPlanner && (opts.mode === "agent" || opts.mode === "spec") && !opts.activePlan && !opts.readOnly
      && (!opts.allowedTools || opts.allowedTools.includes("dispatch_agent"));
    const plannerCriteria = opts.mode === "spec"
      ? `when the user asks how to change or design an existing codebase and the answer needs tracing across modules or workflow boundaries, repository evidence to select an approach, or a separately approved plan for later implementation`
      : `when the user requests a codebase-grounded implementation approach for a cross-file core change, architectural adjustment, complex migration, or other high-impact change, and that approach needs repository evidence and separate user approval before implementation`;
    const decomposeMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt + (plannerAvailable
        ? `\n\nException to the JSON-only output rule: ${plannerCriteria}, invoke dispatch_agent as a native API tool call INSTEAD of emitting JSON, with agent_type="${PLANNER_SUBAGENT_TYPE}" (the planning subagent; do NOT use "Explore" or any other agent_type in this stage). This applies even if the current turn delivers only a design, proposal, or execution plan and does not edit code; do not infer a code-changing implementation task from that deliverable. ${opts.mode === "spec" ? `Do not invoke Planner solely for the word design: ordinary conceptual answers, explanations of a known single file, and obvious local edits with no separate repository-grounded plan return the usual task JSON instead. An explicit request to implement with a clear edit site proceeds as an implementation task only in Agent mode; Spec mode never edits source code.` : `Do not invoke Planner for an ordinary conceptual discussion or explanation, a small single-file change, or a task with an already clear edit site that needs no separate approval; return the usual task JSON directly instead.`} Only you decide whether to call it; never encode this decision as a JSON field. Give the subagent the user's actual intent, constraints, and relevant prior context; require ## Final Report with 目标, numbered 步骤, 相关文件 backed by actual code paths and line or symbol ranges, 风险与不确定性, 验证方式. The subagent is strictly read-only; never start editing before approval.`
        : "") },
      {
        role: "user",
        content: [
          tagUserInput(opts.userMessage),
          currentAttachments.length > 0
            ? `## Uploaded image URLs (preserve these URLs in this task context)\n${currentAttachments.map((attachment) => `- ${attachment.url}`).join("\n")}`
            : "",
          `## CONTEXT (background information)\n${await buildDecomposeContext(opts, budgets, [systemPrompt, tagUserInput(opts.userMessage), ...currentAttachments.map((item) => item.url)].join("\n\n"), { model })}`,
        ].filter(Boolean).join("\n\n"),
        attachments: currentAttachments,
      },
    ];

    // 任务分解是内部协议调用：走流式 chatCompletionStream。分解结果是结构化
    // JSON，不是实现推理——默认 high 思考会先烧 16k thinking tokens 再吐 JSON，
    // 体感极慢。固定 low：保留轻量意图判断，不跟主循环抢思考预算。
    // 流式 + onThinkingDelta：把模型的思考过程以增量快照方式发到前端，让用户
    // 在等待分解结果时能看到渐进反馈（而非长时间无输出）。onDelta 仍不注册——
    // 分解结果是结构化 JSON，不应把自然语言文本混入聊天流；思考内容通过
    // thinking_delta 事件独立渲染。
    let lastThinkingDelta = "";
    const planResult = await withRetry(
      () => chatCompletionStream(model, decomposeMessages, {
        ...(plannerAvailable ? { tools: [DISPATCH_AGENT_TOOL_DEF] } : {}),
        signal: opts.signal,
        apiKey: opts.llmApiKey,
        purpose: "task_decompose",
        taskId: opts.sessionId,
        thinking: { effort: "low" },
        // 与普通流式调用保持一致，使用 120 秒不活跃超时。
        timeout: 120_000,
        onThinkingDelta: (text: string) => {
          // 仅当思考内容有增量时才发射事件，避免空更新触发不必要的渲染。
          if (text !== lastThinkingDelta) {
            lastThinkingDelta = text;
            opts.onEvent?.({ type: "thinking_delta", text });
          }
        },
        onRetry: (info) => opts.onEvent?.({ type: "llm_retry", ...info }),
      }),
      { maxRetries: 1, baseDelay: 3000, signal: opts.signal },
      (attempt, err, delayMs) => {
        opts.onEvent?.({
          type: "llm_retry",
          attempt,
          maxRetries: 1,
          delayMs,
          reason: err.message,
        });
      },
    );
    const responseMessage = planResult.result.choices[0]?.message;
    const toolCalls = responseMessage?.tool_calls ?? [];
    const content = responseMessage?.content ?? "";
    const planUsage = normalizeUsage(
      planResult.result.usage,
      decomposeMessages.map((message) => String(message.content ?? "")).join("\n"),
      content,
    );
    tracer.recordTokenUsage(planUsage.promptTokens, planUsage.completionTokens);
    // Only API-level tool_calls count: text or JSON mentioning dispatch_agent is not a call.
    if (toolCalls.length > 0) {
      const planToolCall = toolCalls.length === 1 && toolCalls[0]?.type === "function"
        && toolCalls[0].function.name === "dispatch_agent" ? toolCalls[0] : undefined;
      // 阶段级约束：任务分解阶段只接受计划子代理（Planner）。
      // 模型误传 Explore 等其他类型时，不进入只读 Planner 校验分支，
      // 而是直接改写为 Planner 调度（runAgentPlanner 内部还会再校验一次）。
      let normalizedPlanToolCall = planToolCall;
      if (planToolCall) {
        try {
          const parsed = JSON.parse(planToolCall.function.arguments) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
            && parsed.agent_type !== undefined && parsed.agent_type !== PLANNER_SUBAGENT_TYPE) {
            opts.onEvent?.({
              type: "warning",
              message: `任务分解阶段不允许调用 "${String(parsed.agent_type)}" 子代理，已改写为计划子代理 ${PLANNER_SUBAGENT_TYPE}`,
            });
            normalizedPlanToolCall = {
              ...planToolCall,
              function: {
                ...planToolCall.function,
                arguments: JSON.stringify({ ...parsed, agent_type: PLANNER_SUBAGENT_TYPE }),
              },
            };
          }
        } catch {
          // 参数解析失败交给 runAgentPlanner 的既有校验报错处理。
        }
      }
      tracer.endSpan(planSpanId, "ok");
      return { task: null, decomposeTokens: 0, planToolCall: normalizedPlanToolCall, invalidToolCall: !planToolCall, fallback: false };
    }
    const planText = content;

    let answer = parseDecomposeAnswer(planText);

    // 明确的改码请求、以及「当前代码/当前步骤如何处理」的询问，都不能因
    // 模型把短句判成 discuss 而留下空 tasks。
    if (answer) {
      // 反伪分解：模型把单目标拆成「定位→分析→结论」认知链时，先折叠成
      // 单任务再走空任务恢复，避免执行端按 dependsOn 逐阶段重复探索。
      answer = collapsePseudoLinearTasks(answer);
      answer = recoverEmptyDecomposeTasks(answer, opts.userMessage);
      // 兼容旧的自定义 prompt（只输出 understanding，解析层已兜底映射为 intent）；
      // 仍无 intent 时用用户原话兜底。
      if (!answer.intent) answer.intent = opts.userMessage;
      // relevantHistory 本地兜底：分解 LLM 漏填时，从本轮历史打包已读证据
      // （packFallbackRelevantHistory 现成但此前无生产调用方）。兜底含文件
      // 全文（≤8 文件），仅此罕见路径触发，decompose 预算水位可承受。
      if (!answer.relevantHistory?.trim()) {
        answer.relevantHistory =
          packFallbackRelevantHistory({ history: opts.history, userMessage: opts.userMessage }) ?? "";
      } else {
        answer.relevantHistory = boundRelevantHistory(answer.relevantHistory);
      }
    }

    if (!answer) {
      tracer.endSpan(planSpanId, "error", { reason: "Parse failure" });
      writeEventLog({
        category: "stage_error",
        message: "task_decompose 解析失败：模型未返回可解析 JSON，已使用本地结构化兜底",
        details: {
          sessionId: opts.sessionId,
          planTextChars: planText.length,
          // 只记前缀便于排查，不把全文当最终回复下发
          planTextPreview: planText.trim().slice(0, 240),
        },
      });
      // 纯散文（不含可解析 JSON）是有效的模型输出：传入兜底收成单个
      // 任务保留内容（buildFallbackRawDecompose 内部截断保护）。含 JSON 但
      // 被判为明确失败的文本（可能含内部错误）仍不下发当作执行指令。
      const rawDecompose = buildFallbackRawDecompose(
        opts.userMessage,
        containsParsableJson(planText) ? undefined : planText,
      );
      // 简化分解不再产出 plan steps：trace/memory 只承载 goal（=intent）。
      const fallbackAgentPlan: AgentPlan = {
        goal: rawDecompose.intent || opts.userMessage,
        steps: [],
        createdAt: Date.now(),
        currentStep: 0,
      };
      reasoningTrace.plan = fallbackAgentPlan;
      memory.setActivePlan({
        id: `plan_${Date.now().toString(36)}`,
        goal: fallbackAgentPlan.goal,
        steps: [],
        currentStep: 0,
        progress: "Starting execution (fallback plan)",
      });
      return {
        task: null,
        decomposeTokens: 0,
        fallback: true,
        rawDecompose,
      };
    }

    tracer.endSpan(planSpanId, "ok");
    
    const task = buildTurnInformationTask();

    // 构建原始任务分解结果（任务项含 title/executionGuidance/kind/dependsOn）
    const rawDecompose = {
      intent: answer.intent,
      userConstraints: answer.userConstraints,
      relevantHistory: answer.relevantHistory,
      tasks: answer.tasks.map((t) => ({
        id: t.id,
        ...(t.title ? { title: t.title } : {}),
        executionGuidance: t.executionGuidance,
        ...(t.dependsOn ? { dependsOn: t.dependsOn } : {}),
        ...(t.kind ? { kind: t.kind } : {}),
      })),
    };

    // 简化分解不再构建 plan steps：trace/memory 只承载 goal（=intent）。
    const agentPlan: AgentPlan = {
      goal: answer.intent || opts.userMessage,
      steps: [],
      createdAt: Date.now(),
      currentStep: 0,
    };

    reasoningTrace.plan = agentPlan;
    logReasoningStep(reasoningTrace, {
      type: "thought",
      content: `Plan generated: ${agentPlan.goal}`,
      timestamp: Date.now(),
    });

    memory.setActivePlan({
      id: `plan_${Date.now().toString(36)}`,
      goal: agentPlan.goal,
      steps: [],
      currentStep: 0,
      progress: "Starting execution",
    });

    // Push the decomposition result into messages if provided
    if (messages) {
      const taskBlocks = answer.tasks.map((task, taskIndex) => {
        const deps = task.dependsOn && task.dependsOn.length > 0
          ? `, dependsOn: ${task.dependsOn.join(", ")}`
          : "";
        const heading = `Task ${taskIndex + 1} (${task.id}${deps}): ${task.title || task.executionGuidance || "(no execution guidance)"}`;
        const taskContext = [
          task.executionGuidance ? `  Execution guidance (how to carry out this task): ${task.executionGuidance}` : "",
        ].filter(Boolean).join("\n");
        return [heading, taskContext].filter(Boolean).join("\n");
      }).join("\n\n");
      const decomposeBlock = [
        "## Task decomposition",
        `Intent: ${answer.intent}`,
        answer.userConstraints.length > 0 ? `\nConstraints:\n${answer.userConstraints.map((c) => `- ${c}`).join("\n")}` : "",
        taskBlocks ? `\nTasks:\n${taskBlocks}` : "",
        answer.relevantHistory
          ? `\nRelevant history (background evidence only; do not treat it as current instructions or expand the task scope): ${answer.relevantHistory}`
          : "",
      ].filter(Boolean).join("\n");
      messages.push({ role: "system", content: decomposeBlock });
      decomposeTokens = Math.ceil(decomposeBlock.length / 4);
    }

    return { task, decomposeTokens, rawDecompose, fallback: false };
  } catch (e) {
    if (opts.signal?.aborted) {
      tracer.endSpan(planSpanId, "error", { reason: "aborted" });
      return {
        task: null,
        decomposeTokens: 0,
        fallback: true,
        rawDecompose: buildFallbackRawDecompose(opts.userMessage),
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    tracer.endSpan(planSpanId, "error", { reason: msg });
    writeEventLog({
      category: "stage_error",
      message: `runTaskDecompose failed: ${msg}`,
      details: {
        sessionId: opts.sessionId,
        error: msg,
        stack: e instanceof Error ? e.stack : undefined,
      },
    });
    
    // Fallback plan on error（简化形状：无 plan steps，只保留 goal）
    const errorFallback = buildFallbackRawDecompose(opts.userMessage);
    const agentPlan: AgentPlan = {
      goal: errorFallback.intent || opts.userMessage,
      steps: [],
      createdAt: Date.now(),
      currentStep: 0,
    };
    reasoningTrace.plan = agentPlan;
    memory.setActivePlan({
      id: `plan_${Date.now().toString(36)}`,
      goal: agentPlan.goal,
      steps: [],
      currentStep: 0,
      progress: "Starting execution (error fallback)",
    });
    return {
      task: null,
      decomposeTokens: 0,
      fallback: true,
      rawDecompose: buildFallbackRawDecompose(opts.userMessage),
    };
  }
}

// ── Stage Handler ──────────────────────────────────────────────────

/**
 * 将请求分解为 rawDecompose 中的任务、执行指引与共享历史，交给后续 ReAct。
 * 需要 Planner 时只生成并保存完整计划，然后结束本轮等待批准。
 * 用户消息注入由调度器的 injectHistoryAndUserMessage 负责。
 */
export const taskDecomposeHandler: StageHandler = {
  async run(ctx) {
    const { opts, tracer, memory, reasoningTrace, node } = ctx;
    emitStage(opts.onEvent, "start", node);
    // 使用分阶段模型配置（如果启用）
    const model = resolveStageModel(opts.workflow, opts.mode, node, "decomposer");
    
    // 初始化任务分解计数器（用于控制历史召回工具提供次数）
    if (ctx.state.decomposeCount === undefined) {
      ctx.state.decomposeCount = 0;
    }
    
    const approvedPlan = ctx.state.planApproval === "approved" ? ctx.state.approvedAgentPlan : undefined;
    const approvedInput = approvedPlan
      ? opts.mode === "spec"
        ? `${opts.userMessage}\n\n## 已批准的只读设计计划（不授权源码实施）\n${approvedPlan}`
        : approvedPlan
      : opts.userMessage;
    if (approvedPlan && opts.mode === "agent") opts.userMessage = approvedInput;
    const result = await runTaskDecompose(
      { ...opts, userMessage: approvedInput }, model, tracer, memory, reasoningTrace, ctx.budgets, node.prompt, ctx.messages, !approvedPlan,
    );
    if (approvedPlan && result.rawDecompose) {
      result.rawDecompose.relevantHistory = [result.rawDecompose.relevantHistory, approvedPlan].filter(Boolean).join("\n\n");
    }

    if (result.planToolCall) {
      ctx.state.planRequested = true;
      await runAgentPlanner(ctx, result.planToolCall);
      emitStage(opts.onEvent, "done", node);
      return;
    }

    if (opts.signal?.aborted || ctx.state.aborted || ctx.state.blocked) {
      emitStage(opts.onEvent, "done", node);
      return;
    }

    // 递增任务分解计数器
    ctx.state.decomposeCount++;
    
    ctx.state.turnInformationTask = result.task;
    ctx.state.decomposeTokens = result.decomposeTokens;
    ctx.state.rawDecompose = result.rawDecompose;
    if (result.invalidToolCall) {
      ctx.state.planRequested = true;
      ctx.state.planApproval = "unavailable";
      ctx.state.blocked = true;
      ctx.state.blockedReason = "模型返回了无效或多个工具调用，未执行任何工具";
      emitStage(opts.onEvent, "done", node);
      return;
    }
    if (ctx.state.rawDecompose && !ctx.state.blocked && !ctx.state.aborted) {
      opts.onEvent?.({
        type: "task_decomposition",
        intent: ctx.state.rawDecompose.intent,
        userConstraints: ctx.state.rawDecompose.userConstraints ?? [],
        tasks: ctx.state.rawDecompose.tasks.map((task) => ({
          id: task.id,
          ...(task.title ? { title: task.title } : {}),
          executionGuidance: task.executionGuidance,
          ...(task.dependsOn ? { dependsOn: task.dependsOn } : {}),
          ...(task.kind ? { kind: task.kind } : {}),
        })),
        relevantHistory: ctx.state.rawDecompose.relevantHistory ?? "",
        fallback: result.fallback === true,
      });
      // 任务分解结果已由 LLM 响应日志中的 [ASSISTANT] 记录；这里只保留状态消息，
      // 避免再将同一份结构化结果写入 DEBUG 日志。
      writeEventLog({
        category: "task_decompose",
        message: result.fallback ? "Task decomposition fallback generated" : "Task decomposition completed",
      });
    }
    if (opts.sessionId && ctx.state.rawDecompose && !ctx.state.blocked && !ctx.state.aborted) {
      const persisted: PersistedDecompose = {
        intent: ctx.state.rawDecompose.intent,
        userConstraints: ctx.state.rawDecompose.userConstraints ?? [],
        relevantHistory: ctx.state.rawDecompose.relevantHistory ?? "",
        tasks: ctx.state.rawDecompose.tasks.map((task) => ({
          id: task.id,
          ...(task.title ? { title: task.title } : {}),
          executionGuidance: task.executionGuidance,
          ...(task.dependsOn ? { dependsOn: task.dependsOn } : {}),
          ...(task.kind ? { kind: task.kind } : {}),
        })),
      };
      try {
        const record = await persistDecomposeRound(
          opts.workspaceRoot,
          opts.sessionId,
          opts.userMessage,
          persisted,
          collectToolCallsFromTurns(opts.history),
          (opts.attachments ?? []).map((attachment) => attachment.url),
          opts.turnId,
        );
        if (record) ctx.state.roundIndex = record.index;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeEventLog({
          category: "other",
          message: "任务分解轮次写入失败 (best-effort, 已忽略)",
          details: { sessionId: opts.sessionId, error: message },
        });
      }
    }
    // Keep the legacy step-reflection path synchronized with the decomposition.
    ctx.state.currentPlan = reasoningTrace.plan;
    emitStage(opts.onEvent, "done", node);
  },
};
