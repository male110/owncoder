import {
  type ChatMessage,
  type ToolDef,
  writeEventLog,
} from "@owncoder/llm";
import {
  findPipelineNode,
  modePipeline,
  resolvePrompts,
  type PipelineNode,
} from "@owncoder/settings";
import { mcpToolsToOpenAi } from "../mcp/client.ts";
import { contextBudgets } from "./budget.ts";
import type { ToolContext } from "./execute.ts";
import { allEnhancedTools } from "./enhanced-tools.ts";
import { OS_LOCALE } from "./tools/shared.ts";

// ── Language directive: single source of truth for reply-language instruction ──
// All LLM calls within one task (main agent loop AND pre-loop stages such as
// task_decompose) must prepend the same directive so a single turn never drifts
// between languages across stages. Pref comes from settings (harness.locale);
// "system" keeps the historical OS-locale behavior.
export type LocaleSetting = "system" | "zh" | "en";
export type PromptLocale = "zh" | "en";

function replyLocaleLabel(pref: LocaleSetting | undefined): string {
  if (pref === "zh") return "Chinese (zh-CN)";
  if (pref === "en") return "English";
  return OS_LOCALE;
}

export function localeSystemPrompt(pref: LocaleSetting | undefined = "system"): string {
  return `## Language\nAlways reply in ${replyLocaleLabel(pref)}. Use this language for all explanations, comments, and output regardless of what language the user writes in.`;
}

/** 结构化 JSON 协议调用用：只约束 JSON 字符串字段语言，不要求整段用自然语言作答。 */
export function localeJsonValuesPrompt(pref: LocaleSetting | undefined = "system"): string {
  const lang = replyLocaleLabel(pref);
  return [
    "## Language",
    `Write JSON string values (intent, descriptions, questions, progressStatus, relevantHistory, etc.) in ${lang}, regardless of the user's language.`,
    "Do not write a free-form chat reply, explanation, or any text outside the JSON object.",
  ].join("\n");
}

/** @deprecated Prefer localeSystemPrompt(workflow.harness.locale). Kept for callers that still assume OS-only. */
export const OS_LOCALE_SYSTEM_PROMPT = localeSystemPrompt("system");

// ── Locale → prompt variant selector ──
// Single authority that decides which of an "EN + _ZH" pair to feed the model.
// Honors the user language setting when set; otherwise falls back to OS locale
// so a single task never picks mixed-language prompts across stages.
export function resolvePromptLocale(pref: LocaleSetting | undefined = "system"): PromptLocale {
  if (pref === "zh" || pref === "en") return pref;
  return OS_LOCALE.toLowerCase().startsWith("zh") ? "zh" : "en";
}


// New enhanced systems
import {
  createReasoningTrace,
  updateTraceStats,
  formatReasoningTrace,

} from "./agent-reasoning.ts";

import {
  MemoryManager,
} from "./memory.ts";

import {
  Tracer,
  estimateTokens,
} from "./observability.ts";

import {
  classifyTask,
} from "./model-coordinator.ts";

import { AdaptivePromptOptimizer } from "./prompt-optimizer.ts";

import { persistExperiences } from "./experience.ts";
export { classifyRecoveryError } from "./recovery.ts";
import { applyTaskEvent } from "../task-run.ts";
import { persistRoundReport, persistRoundEvidence, persistRoundFileChanges, persistRoundToolCalls, collectReadEvidenceFromTurns, collectToolCallsFromTurns, type PersistedEvidence, type PersistedFileChange } from "../turn-rounds.ts";

// Loop submodules (responsibility split: types / prompts / stages / scheduler)
import { stampTurnEvent, type AgentLoopOpts, type AgentLoopResult, type TurnEvent } from "./loop/types.ts";

import { resolveMidStages, resolveStageModel } from "./loop/stages.ts";
import { runPipelineScheduler, type SchedulerContext, type SchedulerState } from "./loop/pipeline-scheduler.ts";
import { runVerifyReport, mergeVerificationIntoAssistant } from "./loop/react.ts";

export type { TurnEvent, TurnEventInput, ChatTurn, DocumentWorkflowState, AgentLoopOpts, AgentLoopResult, ReactDecisionSummary } from "./loop/types.ts";
export { stampTurnEvent } from "./loop/types.ts";
export type {
  HistoryChunk,
  HistoryChunkInput,
  HistorySearchHit,
  HistoryRoundInput,
  EmbeddingService,
  HistoryVectorStore,
} from "./loop/history-vector.ts";
export {
  archiveTurn,
  computeContentHash,
  comparableHistoryText,
  historyTextSimilarity,
  dedupeSimilarHistoryHits,
  finalizeRecalledHistoryHits,
  HISTORY_MIN_RELEVANCE_SCORE,
  HISTORY_NEAR_DUPLICATE_THRESHOLD,
} from "./loop/history-vector.ts";

// ── Main Entry Point ───────────────────────────────────────

export async function runAgentLoop(opts: AgentLoopOpts): Promise<AgentLoopResult> {
  const sessionId = opts.sessionId;
  if (!sessionId) {
    throw new Error("runAgentLoop requires a non-empty sessionId");
  }
  const innerOnEvent = opts.onEvent;
  if (innerOnEvent) {
    opts = {
      ...opts,
      onEvent: (ev) => innerOnEvent(stampTurnEvent(ev, sessionId)),
    };
  }

  const t0 = Date.now();
  const ts = (label: string) => `[loop +${Date.now() - t0}ms] ${label}`;
  
  // ── 轮次分隔符：标记新一轮对话开始 ──
  writeEventLog({
    category: "turn_separator",
    message: `新一轮对话开始 | mode=${opts.mode} | user: ${opts.userMessage.substring(0, 50)}${opts.userMessage.length > 50 ? "..." : ""}`,
  });
  
  console.log(ts(`enter mode=${opts.mode} userLen=${opts.userMessage.length} historyLen=${opts.history.length}`));
  const tracer = new Tracer();
  const memory = opts.memory ?? new MemoryManager();
  const reasoningTrace = createReasoningTrace();
  const taskClassification = classifyTask(opts.userMessage, opts.history.length);

  const pipeline = modePipeline(opts.workflow, opts.mode);
  const budgets = contextBudgets(opts.workflow);
  const resolved = resolvePrompts(opts.workflow);

  // ── Resolve pipeline nodes ──

  const anchorsNode = findPipelineNode(pipeline, "load_anchors");
  const exploreNodes = pipeline.nodes.filter(
    (n: PipelineNode) => n.type === "explore_tools" && n.enabled !== false,
  );
  const executeNodes = pipeline.nodes.filter(
    (n: PipelineNode) => n.type === "execute_tools" && n.enabled !== false,
  );
  const exploreNode = exploreNodes[0];
  const executeNode = executeNodes[0];
  const hasExplore = !!exploreNode;
  const hasExecute = !!executeNode;
  const hasToolStage = hasExplore || hasExecute;
  const toolNode = hasExecute ? executeNode : exploreNode;
  const draftNode = findPipelineNode(pipeline, "draft_plan");

  const allowPlanFiles =
    opts.workflow.modes.plan.allowPlanFiles !== false;

  const planBashReadonly =
    opts.mode === "plan" && opts.workflow.modes.plan.bash === "readonly";

  // ── Tools: use enhanced tools (backward-compatible: all existing tools still work) ──
  let toolsFinal: ToolDef[] = [
    ...allEnhancedTools({
      mode: opts.mode,
      allowBash: opts.mode === "agent",
      planBashReadonly,
      allowPlanFiles,
      enableLsp: opts.enableLsp !== false,
      enableWebSearch: opts.enableWebSearch !== false,
      enableVerification: opts.enableVerification !== false && opts.mode === "agent",
    }),
    ...(hasToolStage && opts.mode === "agent" && opts.mcp
      ? (mcpToolsToOpenAi(opts.mcp.listTools()) as ToolDef[])
      : []),
  ];

  // ── Permission sandbox: filter tools by role ──
  // When a role declares an explicit allowedTools whitelist, only those tools
  // survive — everything else is denied at the mechanism level. When a role
  // only sets readOnly, fall back to a blacklist of known mutating tools.
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    const allow = new Set(opts.allowedTools);
    toolsFinal = toolsFinal.filter((t) => allow.has(t.function.name));
  } else if (opts.readOnly) {
    const WRITE_TOOLS = new Set([
      "apply_patch", "write_file", "append_file", "bash",
      "save_plan", "save_spec", "save_design", "save_experience",
      "save_memory", "update_memory", "forget_memory",
      "undo_session_change",
    ]);
    toolsFinal = toolsFinal.filter((t) => !WRITE_TOOLS.has(t.function.name));
  }

  // ── System prompt: from pipeline node or legacy config (full backward compat) ──
  // Runtime always uses English prompts. Pipeline node prompts take priority;
  // otherwise fall back to the legacy `config.prompts.{plan,agent}` string.
  const planPrompt = resolved.plan;
  const agentPrompt = resolved.agent;
  const basePrompt =
    hasExplore && !hasExecute
      ? exploreNode?.prompt?.trim() || draftNode?.prompt?.trim() || planPrompt
      : executeNode?.prompt?.trim() || agentPrompt;


  // 系统提示词（用户/项目定制 prompt 或内置 builtin prompt）不允许截断：
  // 用户在设置里写下的提示词是契约、规则、约束；内置 prompt 也是出厂定义的产品行为。
  // 任何裁剪都会让 LLM 丢掉关键指令（典型如大项目禁止全量 build 的约束被砍）。
  // 历史消息可以截断（由 history_compact 控制）。
  const systemPrompt = basePrompt;

  // Authentication is checked at each actual model-call boundary. This lets
  // pre-model local routers answer without requiring an LLM credential.
  const model = resolveStageModel(opts.workflow, opts.mode, toolNode ?? draftNode);

  // Wrap system prompt with semantic tag to clearly mark it as core instructions
  const { tagSystemInstructions } = await import("./message-tags.js");
  const messages: ChatMessage[] = [{ role: "system", content: tagSystemInstructions(systemPrompt) }];

  // ── Language: settings harness.locale (system → OS locale) ──
  messages.push({
    role: "system",
    content: localeSystemPrompt(opts.workflow.harness.locale),
  });

  messages.push({
    role: "system",
    content:
      "## External knowledge\n" +
      "When you do not know a fact, or one local retry failed to fix the same error, call `web_search` before guessing. " +
      "Then `web_fetch` the best official/source URL. Do not keep editing the same failing approach instead of searching.",
  });

  const history = [...opts.history];

  // ── Adaptive Prompt Optimizer: track success/failure for self-improvement ──
  // Owned by the session orchestrator so learned failure patterns persist across
  // turns; falls back to a per-call instance when the caller does not supply one.
  const promptOptimizer = opts.promptOptimizer ?? new AdaptivePromptOptimizer();
  // Ensure downstream stages (buildInitialContext) can access the resolved
  // instance even when the caller did not pass promptOptimizer explicitly
  // (e.g. subagents). Otherwise the deferred injection in
  // buildInitialContext would silently no-op for those call paths.
  opts.promptOptimizer = promptOptimizer;

  // NOTE: promptOptContext injection is deferred to buildInitialContext so it
  // lands AFTER all stable system messages (fewShot, platform info, project
  // rules), keeping the LLM cache prefix byte-stable across turns.

  // ── Few-shot examples: removed (Assistant-style minimal system, no curated examples) ──

  memory.setGoal(opts.userMessage.slice(0, 200));

  const readSet = new Set<string>();
  const readMtTimes = new Map<string, number>();
  const toolCtx: ToolContext = {
    workspaceRoot: opts.workspaceRoot,
    sessionId: opts.sessionId,
    mode: opts.mode,
    workflow: opts.workflow,
    index: opts.index,
    codemap: opts.codemap,
    readSet,
    readMtTimes,
    maxOutputChars: opts.workflow.harness.toolOutputMaxChars,
    bashMaxChars: opts.workflow.harness.bashMaxChars,
    fileSnapshots: opts.fileSnapshots,
    touchedPaths: opts.touchedPaths,
    confirmDangerousBash: opts.confirmDangerousBash,
    askUser: opts.askUser,
    askUserTurnCache: new Map(),
    renderPage: opts.renderPage,
    onTerminal: (entry) => opts.onEvent?.({ type: "terminal", entry }),
    onEvent: (ev) => opts.onEvent?.(ev as TurnEvent),

    mcp: opts.mcp,
    projectRules: opts.projectRules,
    llmApiKey: opts.llmApiKey,
    signal: opts.signal,
    historyVector: opts.historyVector,
    memory, // Pass memory manager so tools can update knowledge graph
    memoryStore: opts.memoryStore,
    projectMemoryStore: opts.projectMemoryStore,
    sessionChanges: opts.sessionChanges,
  };

  // ── Resolve middle stages from pipeline (user-configurable) ──
  // T8-T10: resolveMidStages now includes context_gather so the scheduler
  // dispatches it through its StageHandler instead of hardcoding it before the loop.
  const midStages = resolveMidStages(pipeline);

  const presentNodes = midStages.filter((n: PipelineNode) => n.type === "present_changes");
  const presentNode = presentNodes[presentNodes.length - 1];


  let runError = "";
  let runOutput = "";

  const finish = (assistantText: string): AgentLoopResult => {
    const autoKeep = presentNode?.params?.autoKeepChanges === true;
    updateTraceStats(reasoningTrace, estimateTokens(messages.map((m: ChatMessage) => m.content ?? "").join("")), 0, 0);
    const traceSummary = tracer.formatSummary();
    opts.onEvent?.({ type: "trace_report", summary: traceSummary });

    // Record run stats for adaptive prompt optimization
    const estimatedTokens = estimateTokens(messages.map((m: ChatMessage) => m.content ?? "").join(""));
    promptOptimizer.recordRun(
      opts.mode,
      runError.length === 0,
      runError,
      runOutput.slice(0, 500),
      estimatedTokens,
      reasoningTrace.steps.length,
    );

    // 🆕 历史归档：turn 结束时只归档「本轮新增」的 turns（增量），写入向量库（best-effort）。
    // 归档与任务分解/检索解耦，失败不影响主流程。
    // `history` 是 `[...opts.history]` 的浅拷贝，turn 内所有 push 都追加到 `history`，
    // 而 `opts.history` 保持进入本轮前的快照，因此「本轮新增」= 下标 >= opts.history.length 的部分。
    // turnIndex 由 store 内部按 `MAX(turn_index)+1` 单调分配，与数组下标无关，
    // 彻底避免历史压缩/截断（如 regenerateLastReply 的 slice）导致的下标回退/漂移。
    if (!opts.historyVector?.archiveRound && opts.historyVector?.archive && opts.sessionId) {
      const sid = opts.sessionId;
      const baseIndex = opts.history.length;
      for (let i = baseIndex; i < history.length; i++) {
        const turn = history[i];
        if (!turn.content) continue;
        try {
          void opts.historyVector.archive(turn, sid);
        } catch (archiveError) {
          // 归档失败静默忽略，避免影响 turn 完成。
          console.warn("[history_vector] 归档失败:", archiveError);
        }
      }
    }

    // post_verify 硬失败必须与 successRejected 对齐，避免只挡报告却仍像成功返回。
    if (state.postVerifyFailed) {
      state.successRejected = true;
      state.blocked = true;
      if (!state.blockedReason) {
        state.blockedReason =
          state.taskRunState?.metrics.terminalReason ?? "post_verify 验证未通过";
      }
      if (
        state.taskRunState &&
        state.taskRunState.phase !== "failed" &&
        state.taskRunState.phase !== "blocked" &&
        state.taskRunState.phase !== "interrupted"
      ) {
        state.taskRunState = applyTaskEvent(state.taskRunState, {
          type: "phase_changed",
          taskId: state.taskRunState.taskId,
          phase: "failed",
          reason: state.blockedReason,
        });
      }
    }

    return {
      history,
      assistantText,
      lastPlanPath: toolCtx.lastPlanPath,
      presentChanges:
        opts.mode === "agent" ? presentNodes.length > 0 && !autoKeep : undefined,
      documentWorkflow: state.documentWorkflow,
      reasoningTrace,
      traceSummary,
      taskRunState: state.taskRunState ?? opts.taskRunState ?? null,
      successRejected: state.successRejected === true || state.postVerifyFailed === true,
    };
  };

  const finishWithRoundsPersist = (assistantText: string): AgentLoopResult => {
    const started = performance.now();
    const result = finish(assistantText);

    // Fire-and-forget: persist this turn's report + evidence so the next
    // task_decompose can read user / decompose / report / evidence as
    // structured rounds without relying on heuristic history extraction.
    if (opts.sessionId) {
      const sid = opts.sessionId;
      const newTurns = history.slice(opts.history.length);
      const fileChanges: PersistedFileChange[] = newTurns.flatMap((turn) => {
        if (turn.role !== "tool" || !turn.toolName || !turn.content) return [];
        const writeTools = new Set(["write_file", "append_file", "apply_patch", "save_plan", "save_spec", "save_design", "save_experience"]);
        if (!writeTools.has(turn.toolName) || /\bfailed\b|\berror\b/i.test(turn.content)) return [];
        const path = turn.content.match(/(?:Wrote|Patched|Appended(?: to)?|Saved plan:|Saved spec:|Saved design:|Saved experience:)\s*([^\s(]+)/i)?.[1];
        return [{ toolName: turn.toolName, path, summary: turn.content.slice(0, 500) }];
      });
      const reportPromise = assistantText.trim()
        ? persistRoundReport(
            opts.workspaceRoot,
            sid,
            opts.userMessage,
            assistantText,
            state.roundIndex,
          )
        : Promise.resolve(null);

      const roundEvidence: PersistedEvidence[] = collectReadEvidenceFromTurns(newTurns);
      const roundToolCalls = collectToolCallsFromTurns(newTurns);
      if (opts.historyVector?.archiveRound) {
        void opts.historyVector.archiveRound({
          sessionId: sid,
          roundIndex: state.roundIndex,
          userInput: opts.userMessage,
          taskDecompose: state.rawDecompose
            ? {
                intent: state.rawDecompose.intent,
                userConstraints: state.rawDecompose.userConstraints ?? [],
                tasks: state.rawDecompose.tasks.map((task) => ({
                  id: task.id,
                  description: task.description,
                  userConstraints: task.userConstraints ?? [],
                  relevantHistory: task.relevantHistory ?? "",
                  progressStatus: task.progressStatus ?? "pending",
                  steps: task.steps.map((step) => ({
                    id: step.id,
                    description: step.description,
                    dependsOn: step.dependsOn,
                    relevantHistory: step.relevantHistory ?? "",
                  })),
                })),
              }
            : undefined,
          assistantReport: assistantText,
          // 凭证只归档定位元数据，不写入 excerpt / fileEvidence 全文。
          evidence: roundEvidence.map((item) => ({
            needId: item.needId || undefined,
            summary: item.summary,
            kind: item.kind,
            path: item.path,
            symbol: item.symbol,
            startLine: item.startLine,
            endLine: item.endLine,
          })),
          // 工具调用只记名称与参数，不记返回结果。
          toolCalls: roundToolCalls.map((call) => ({
            toolName: call.toolName,
            arguments: call.arguments,
          })),
        });
      }
      const toolCallsPromise =
        roundToolCalls.length > 0
          ? persistRoundToolCalls(
              opts.workspaceRoot,
              sid,
              opts.userMessage,
              state.roundIndex,
              roundToolCalls,
            )
          : Promise.resolve();

      const evidencePromise =
        roundEvidence.length > 0
          ? persistRoundEvidence(
              opts.workspaceRoot,
              sid,
              opts.userMessage,
              state.roundIndex,
              roundEvidence,
            )
          : Promise.resolve();

      const fileChangesPromise = fileChanges.length > 0
        ? persistRoundFileChanges(opts.workspaceRoot, sid, opts.userMessage, state.roundIndex, fileChanges)
        : Promise.resolve();

      Promise.all([reportPromise, evidencePromise, fileChangesPromise, toolCallsPromise])
        .then(([reportRecord]) => {
          writeEventLog({
            category: "other",
            message: "轮次历史已写入",
            details: {
              sessionId: sid,
              roundIndex: reportRecord?.index,
              reportChars: assistantText.length,
              evidenceCount: roundEvidence.length,
              hasDecompose: !!reportRecord?.taskDecompose,
            },
          });
        })
        .catch((persistError) => {
          const msg = persistError instanceof Error ? persistError.message : String(persistError);
          writeEventLog({
            category: "other",
            message: `轮次历史写入失败 (best-effort, 已忽略): ${msg}`,
            details: { sessionId: sid, error: msg },
          });
        });
    }

    console.log(`[loop] sid=${opts.sessionId ?? "unknown"} step=final_result status=done duration=${Math.round(performance.now() - started)}ms`);
    return result;
  };

  // ── Unified Pipeline Scheduler (T8-T10) ──
  // Replaces the former hardcoded pre-loop processing (context_gather /
  // task_decompose / history_compact) and the midStages switch. All stages
  // are dispatched through StageHandlers in pipeline order.
  const state: SchedulerState = {
    lastAssistant: "",
    correctionCount: 0,
    currentPlan: reasoningTrace.plan,
    turnInformationTask: null,
    userMessageInjected: false,
    budgetUsed: 0,
    decomposeCount: 0,
    aborted: false,
    awaitingUserConfirmation: false,
    handoffRequested: false,
    documentWorkflow: undefined,
    shortCircuited: false,
    blocked: false,
    blockedReason: undefined,
    verifyNodeForReport: null,
    decomposeTokens: 0,
    taskRunState: opts.taskRunState ?? null,
    successRejected: false,
  };

  const schedulerCtx: SchedulerContext = {
    opts,
    messages,
    history,
    memory,
    tracer,
    reasoningTrace,
    toolCtx,
    toolsFinal,
    model,
    budgets,
    state,
    hasToolStage,
    hasExecute,

    taskClassification,
    anchorsNode,
  };

  console.log(ts(`scheduler start stages=${midStages.map((n: PipelineNode) => n.type).join(",")}`));
  try {
    await runPipelineScheduler(midStages, schedulerCtx);
    console.log(ts(`scheduler done`));
  } catch (stageError) {
    // A stage handler (verify, post_verify, etc.) threw unexpectedly after the
    // main loop already accumulated history. Return the accumulated history so
    // the caller (sendMessage) can persist it instead of losing everything.
    const msg = stageError instanceof Error ? stageError.message : String(stageError);
    const stack = stageError instanceof Error ? stageError.stack : undefined;
    console.error("[runAgentLoop] stage error after loop, preserving history:", msg);
    writeEventLog({
      category: "stage_error",
      message: `runAgentLoop stage handler 抛出未捕获异常: ${msg}`,
      details: {
        sessionId: opts.sessionId,
        mode: opts.mode,
        error: msg,
        stack,
        lastAssistantLen: state.lastAssistant.length,
        correctionCount: state.correctionCount,
      },
    });
    opts.onEvent?.({ type: "error", message: `Stage error: ${msg}` });
    return finishWithRoundsPersist(state.lastAssistant || msg);
  }

  const reportStarted = performance.now();
  let reportStatus = "skipped";
  // ── Final verification report (single LLM call) ──
  // All verify nodes in the pipeline have now finished; issue ONE
  // `chatCompletionStream` and merge the `### Verification` paragraph into the
  // final assistantText + history. This replaces the previous per-verify-node
  // report, which made N LLM calls per turn when the pipeline contained N
  // verify nodes. Suppressed when the turn was aborted, handed off, or a
  // document deliverable awaits user confirmation — matching the existing
  // rule that a handoff / abort ends the autonomous part of the turn.
  if (
    state.verifyNodeForReport !== null &&
    !state.postVerifyFailed &&
    !state.aborted &&
    !state.blocked &&
    !state.awaitingUserConfirmation &&
    !state.handoffRequested
  ) {
    console.log(`[loop] sid=${opts.sessionId ?? "unknown"} step=verify_report start`);
    reportStatus = "error";
    try {
      const verifyText = await runVerifyReport(
        opts,
        state.verifyNodeForReport,
        messages,
        state.lastAssistant,
        tracer,
      );
      state.lastAssistant = mergeVerificationIntoAssistant(
        state.lastAssistant,
        verifyText,
        history,
      );
      reportStatus = "done";
    } catch (verifyError) {
      // best-effort: a failed verification report must not break the turn
      const verifyErr = verifyError instanceof Error ? verifyError.message : String(verifyError);
      writeEventLog({
        category: "verify",
        message: `最终验证报告生成失败 (best-effort, 已忽略): ${verifyErr}`,
        details: {
          sessionId: opts.sessionId,
          error: verifyErr,
          stack: verifyError instanceof Error ? verifyError.stack : undefined,
        },
      });
    }
  }

  console.log(`[loop] sid=${opts.sessionId ?? "unknown"} step=verify_report status=${reportStatus} duration=${Math.round(performance.now() - reportStarted)}ms`);

  // A blocked exploration is a user-visible non-success terminal state. Keep
  // the collected report/evidence, but do not run verification or auto-fix.
  // 验证门禁拒绝成功时，只在 LLM 正文区提示失败文件，不再弹顶部错误条。
  if (state.blocked && !state.successRejected) {
    const blockedMessage = state.blockedReason ?? "Exploration is blocked; additional user guidance is required.";
    // 自动修复达上限 / 导出移除类警告只进正文，不弹顶部错误条。
    if (!blockedMessage.includes("自动修复达到上限") && !blockedMessage.includes("移除了导出")) {
      opts.onEvent?.({
        type: "warning",
        message: blockedMessage,
      });
    }
  }

  // ── Aborted: return early (skip experience harvest) ──
  if (state.aborted) {
    return finishWithRoundsPersist(state.lastAssistant);
  }

  if (reasoningTrace.steps.length > 0) {
    opts.onEvent?.({ type: "trace_report", summary: formatReasoningTrace(reasoningTrace) });
  }

  // Harvest failure→fix episodes from the trace into .owncoder/experiences/.
  // Callers can override this with persistExperiencesOverride; the default path
  // (used by SessionOrchestrator) is unchanged.
  // 
  // Run asynchronously (fire-and-forget) to avoid blocking the done event and UI update.
  // The experience harvest is best-effort and should not delay user feedback.
  const persist = opts.persistExperiencesOverride ?? persistExperiences;
  persist(opts.workspaceRoot, tracer.generateReport(), opts.index).catch((harvestError) => {
    /* non-fatal: experience harvest must never break the loop */
    const harvestErr = harvestError instanceof Error ? harvestError.message : String(harvestError);
    writeEventLog({
      category: "other",
      message: `experience 持久化失败 (best-effort, 已忽略): ${harvestErr}`,
      details: {
        sessionId: opts.sessionId,
        error: harvestErr,
      },
    });
  });


  return finishWithRoundsPersist(state.lastAssistant);
}

// ── Termination Metrics API ────────────────────────────────────────────────────
// Re-export metrics collector for external access
export {
  getGlobalMetricsCollector,
  resetGlobalMetricsCollector,
  type TerminationMetric,
  type TerminationStats,
  TerminationMetricsCollector,
} from "./loop/termination-metrics.ts";
