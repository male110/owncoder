import {
  type ChatMessage,
  type ToolDef,
  writeEventLog,
} from "@owncoder/llm";
import {
  BUILTIN_AGENT_PROMPT,
  BUILTIN_SPEC_PROMPT,
  findPipelineNode,
  modePipeline,
  type PipelineNode,
} from "@owncoder/settings";
import { mcpToolsToOpenAi } from "../mcp/client.ts";
import { contextBudgets } from "./budget.ts";
import type { ToolContext } from "./execute.ts";
import { allEnhancedTools } from "./enhanced-tools.ts";
import { OS_LOCALE } from "./tools/shared.ts";
import { BudgetLedger } from "./budget-ledger.ts";
import { EvidenceStore } from "./evidence-store.ts";
import { assertSessionArtifactPath, readPlanFile } from "../plans.ts";
import { publicPhaseRel, readFeatureState } from "../specs.ts";
import {
  classifySpecDesignIntent, classifySpecRequirementsIntent, isSpecDesignReview, isSpecRequirementsReview,
  readSpecDesignSnapshot, readSpecRequirementsSnapshot,
} from "./loop/spec-design-intent.ts";

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

import { persistExperiences } from "./experience.ts";
export { classifyRecoveryError } from "./recovery.ts";
import { applyTaskEvent, formatVerificationFailureNotice, sealTaskRunSuccess } from "../task-run.ts";
import { persistRoundReport, persistRoundEvidence, persistRoundFileChanges, persistRoundToolCalls, collectReadEvidenceFromTurns, collectToolCallsFromTurns, type PersistedEvidence, type PersistedFileChange } from "../turn-rounds.ts";

// Loop submodules (responsibility split: types / prompts / stages / scheduler)
import { stampTurnEvent, type AgentLoopOpts, type AgentLoopResult, type TurnEvent } from "./loop/types.ts";

import { resolveMidStages, resolveStageModel } from "./loop/stages.ts";
import { runPipelineScheduler, type SchedulerContext, type SchedulerState } from "./loop/pipeline-scheduler.ts";
import { resumeAgentPlan } from "./loop/stage-handlers/planner.ts";
import {
  selectedSpecTask, SPEC_TASK_OUTCOME_TOOL, SPEC_TASK_OUTCOME_TOOL_DEF,
  SPEC_TASK_REPORT_REQUIRED, SPEC_TASK_WORKFLOW_TOOLS,
} from "./loop/single-spec-task.ts";
import { runVerifyReport, mergeVerificationIntoAssistant } from "./loop/react-verify.ts";

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
  // Create one ledger for the whole request. Nested task nodes and Explore
  // loops receive this same object through their options instead of resetting
  // local counters at every child boundary.
  if (!opts.budget) opts = { ...opts, budget: new BudgetLedger() };
  if (!opts.evidenceStore) opts = { ...opts, evidenceStore: new EvidenceStore() };

  if (!sessionId) {
    throw new Error("runAgentLoop requires a non-empty sessionId");
  }
  if (opts.singleSpecTask) {
    // Keep the caller's validated Spec plan as context, not as a continuation.
    opts = { ...opts, documentWorkflow: null, taskRunState: null, forcedFinalReportOnLimit: false };
  }
  if (opts.documentWorkflow?.sessionId !== sessionId) opts = { ...opts, documentWorkflow: null };
  if (opts.documentWorkflow) {
    try {
      for (const path of [opts.documentWorkflow.documentPath, ...(opts.documentWorkflow.allDocuments ?? []), ...(opts.documentWorkflow.documents ?? []).map((d) => d.path)]) {
        await readPlanFile(opts.workspaceRoot, path, sessionId);
      }
    } catch {
      opts = { ...opts, documentWorkflow: null };
    }
  }
  if (opts.activePlan) await readPlanFile(opts.workspaceRoot, opts.activePlan.path, sessionId);
  opts = { ...opts, history: opts.history.filter((turn) => {
    const references = [...turn.content.matchAll(/<!--plan_saved:([^>]+)-->/g)];
    return references.every((match) => {
      try { assertSessionArtifactPath(match[1]!.trim(), sessionId); return true; } catch { return false; }
    });
  }) };
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

  // ── Resolve pipeline nodes ──

  const anchorsNode = findPipelineNode(pipeline, "load_anchors");
  const exploreNodes = pipeline.nodes.filter(
    (n: PipelineNode) => n.type === "explore_tools",
  );
  const executeNodes = pipeline.nodes.filter(
    (n: PipelineNode) => n.type === "execute_tools",
  );
  const exploreNode = exploreNodes[0];
  const executeNode = executeNodes[0];
  const hasExplore = !!exploreNode;
  const hasExecute = !!executeNode;
  const hasToolStage = hasExplore || hasExecute;
  const toolNode = hasExecute ? executeNode : exploreNode;
  const draftNode = findPipelineNode(pipeline, "draft_plan");

  const allowSpecFiles =
    opts.workflow.modes.spec.allowSpecFiles !== false;

  const planBashReadonly =
    opts.mode === "spec" && opts.workflow.modes.spec.bash === "readonly";

  // ── Tools: use enhanced tools (backward-compatible: all existing tools still work) ──
  // 主 executor 循环（agent 模式）探索外包：不注册发现类搜索工具，调研全部
  // 走 dispatch_agent（Explore 子代理）。子代理循环（exploreLoop/plannerLoop
  // 自带白名单）与 readOnly 分析型循环不受影响。
  let toolsFinal: ToolDef[] = [
    ...allEnhancedTools({
      mode: opts.mode,
      allowBash: opts.mode === "agent",
      planBashReadonly,
      allowSpecFiles,
      enableLsp: opts.enableLsp !== false,
      enableWebSearch: opts.enableWebSearch !== false,
      enableVerification: opts.enableVerification !== false && opts.mode === "agent",
      plannerLoop: opts.plannerLoop === true,
      exploreLoop: opts.exploreLoop === true,
      delegateExploration:
        opts.mode === "agent" &&
        opts.plannerLoop !== true &&
        opts.exploreLoop !== true &&
        opts.readOnly !== true,
    }),
    ...(hasToolStage && opts.mode === "agent" && opts.mcp
      ? (mcpToolsToOpenAi(opts.mcp.listTools()) as ToolDef[])
      : []),
  ];
  if (opts.singleSpecTask) {
    toolsFinal = toolsFinal.filter(({ function: { name } }) =>
      !SPEC_TASK_WORKFLOW_TOOLS.has(name) && name !== SPEC_TASK_OUTCOME_TOOL);
    toolsFinal.push(SPEC_TASK_OUTCOME_TOOL_DEF);
  }

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
      "save_plan", "save_spec", "save_design", "save_tasks", "save_experience",
      "save_memory", "update_memory", "forget_memory",
      "undo_session_change", "run_script",
      // 任务清单追加（活清单的新增）同样是会话状态写入，readOnly
      // 会话（探索沙箱）不可用。
      "add_tasks",
    ]);
    toolsFinal = toolsFinal.filter((t) => !WRITE_TOOLS.has(t.function.name));
  }

  // ── System prompt: baked into the builtin pipeline node (English, canonical) ──
  // Prompts are no longer user-editable, so the node prompt is the only source;
  // the builtin constants remain as a defensive fallback if a node lacks one.
  const basePrompt =
    hasExplore && !hasExecute
      ? exploreNode?.prompt?.trim() || draftNode?.prompt?.trim() || BUILTIN_SPEC_PROMPT.trim()
      : executeNode?.prompt?.trim() || BUILTIN_AGENT_PROMPT.trim();


  // 系统提示词（用户/项目定制 prompt 或内置 builtin prompt）不允许截断：
  // 用户在设置里写下的提示词是契约、规则、约束；内置 prompt 也是出厂定义的产品行为。
  // 任何裁剪都会让 LLM 丢掉关键指令（典型如大项目禁止全量 build 的约束被砍）。
  // 历史消息可以截断（由 history_compact 控制）。
  const model = resolveStageModel(opts.workflow, opts.mode, toolNode ?? draftNode);
  const specReview: Pick<ToolContext, "specRequirementsFollowup" | "specDesignFollowup" | "specRequirementsRevision" | "specDesignGeneration" | "specDesignRevision" | "specTaskGeneration"> = {};
  if (!opts.singleSpecTask && opts.mode === "spec" && opts.currentFeature && !opts.readOnly && !opts.initialMessages) {
    const state = await readFeatureState(opts.workspaceRoot, opts.currentFeature, sessionId);
    if (state && (isSpecRequirementsReview(state.stage) || isSpecDesignReview(state.stage))) {
      const { feature } = state;
      const requirementsPath = publicPhaseRel(feature, "spec");
      const designPath = publicPhaseRel(feature, "design");
      let allowedSave: string | undefined;
      let guidance: string;
      if (isSpecRequirementsReview(state.stage)) {
        specReview.specRequirementsFollowup = true;
        const snapshot = await readSpecRequirementsSnapshot(opts.workspaceRoot, feature, sessionId);
        const intent = snapshot && await classifySpecRequirementsIntent(opts, model, feature);
        if (snapshot && intent === "generate_design") {
          specReview.specDesignGeneration = snapshot;
          allowedSave = "save_design";
          guidance = `The user wants to draft the technical design for ${feature}. Read ${requirementsPath} and call save_design for this feature. Do not ask for requirements approval or draft tasks this turn.`;
        } else if (snapshot && intent === "revise_requirements") {
          specReview.specRequirementsRevision = snapshot;
          allowedSave = "save_spec";
          guidance = `Read and revise ${requirementsPath} according to the latest feedback. Save the requirements again for ${feature}; do not advance this turn.`;
        } else {
          guidance = "Answer the requirements follow-up or clarify what the user wants. Do not save or advance a Spec document this turn.";
        }
      } else {
        specReview.specDesignFollowup = true;
        const snapshot = await readSpecDesignSnapshot(opts.workspaceRoot, feature, sessionId);
        const intent = snapshot && await classifySpecDesignIntent(opts, model, feature);
        if (snapshot && intent === "generate_tasks") {
          specReview.specTaskGeneration = snapshot;
          allowedSave = "save_tasks";
          guidance = `The user wants to draft tasks for ${feature}. Read ${requirementsPath} and ${designPath}, then call save_tasks for this feature. Do not ask for design approval or implement the tasks.`;
        } else if (snapshot && intent === "revise_design") {
          specReview.specDesignRevision = snapshot;
          allowedSave = "save_design";
          guidance = `Read and revise ${designPath} according to the latest feedback. Save the design again for ${feature}; do not generate tasks this turn.`;
        } else {
          guidance = "Answer the design follow-up or clarify what the user wants. Do not save or advance a Spec document this turn.";
        }
      }
      toolsFinal = toolsFinal.filter(({ function: { name } }) =>
        name === allowedSave || (name !== "save_spec" && name !== "save_design" && name !== "save_tasks"));
      opts = { ...opts, currentFeature: feature, specReviewGuidance: guidance };
    }
  }
  const systemPrompt = [opts.systemPromptOverride ?? basePrompt, opts.specReviewGuidance].filter(Boolean).join("\n\n");

  // Wrap system prompt with semantic tag to clearly mark it as core instructions
  const { tagSystemInstructions, tagUserInput } = await import("./message-tags.js");
  // 续接种子：沿用预置转录（含系统提示与历史工具往返），userMessage 作为
  // 新 user 消息追加到末尾；scheduler 的用户消息注入由 userMessageInjected
  // 初值置位跳过，避免把历史打包再注一遍。
  const messages: ChatMessage[] = opts.initialMessages
    ? [...opts.initialMessages, { role: "user", content: tagUserInput(opts.userMessage) }]
    : [{ role: "system", content: tagSystemInstructions(systemPrompt) }];

  if (!opts.initialMessages) {
    // ── Language: settings harness.locale (system → OS locale) ──
    messages.push({
      role: "system",
      content: localeSystemPrompt(opts.workflow.harness.locale),
    });
  }

  const history = [...opts.history];

  // ── Few-shot examples: removed (Assistant-style minimal system, no curated examples) ──

  memory.setGoal(opts.userMessage.slice(0, 200));

  // ── Explore 子代理续接线程表（本父轮次作用域）──────────────────────────
  // 对齐 ZCode SendMessage：「continue a previously spawned agent with its
  // context intact」——派发结束后保留子代理的消息转录，后续带 continueAgentId
  // 的派发以之为 initialMessages，子代理读过的内容与结论全部保留，追问无需
  // 重搜。线程只在本父轮次存活，不跨用户轮次持久化（v1 边界）。
  const subagentThreads = new Map<string, ChatMessage[]>();
  let subagentThreadSeq = 0;
  /** 收尾补记：submit_report 的工具结果只是确认串、报告原文不在 messages 里，
   *  注册前追加一条携带最终报告的 assistant 消息，续接的代理才「记得」自己交付了什么。 */
  const withClosingReport = (transcript: ChatMessage[], report: string): ChatMessage[] => [
    ...transcript,
    { role: "assistant", content: report },
  ];

  const readSet = new Set<string>();
  const toolCtx: ToolContext = {
    workspaceRoot: opts.workspaceRoot,
    sessionId: opts.sessionId,
    mode: opts.mode,
    workflow: opts.workflow,
    availableTools: new Set(toolsFinal.map(t => t.function.name)),
    budget: opts.budget,
    index: opts.index,
    codemap: opts.codemap,
    readSet,
    maxOutputChars: opts.workflow.harness.toolOutputMaxChars,
    bashMaxChars: opts.workflow.harness.bashMaxChars,
    currentFeature: opts.currentFeature,
    ...specReview,
    fileSnapshots: opts.fileSnapshots,
    touchedPaths: opts.touchedPaths ?? (opts.singleSpecTask ? [] : undefined),
    confirmDangerousBash: opts.confirmDangerousBash,
    autoApproveDangerousBash: opts.autoApproveDangerousBash,
    askUser: opts.askUser,
    askUserTurnCache: new Map(),
    renderPage: opts.renderPage,
    onTerminal: (entry) => opts.onEvent?.({ type: "terminal", entry }),
    onEvent: (ev) => opts.onEvent?.(ev as TurnEvent),

    mcp: opts.mcp,
    projectRules: opts.projectRules,
    skills: opts.skills,
    llmApiKey: opts.llmApiKey,
    signal: opts.signal,
    historyVector: opts.historyVector,
    memory, // Pass memory manager so tools can update knowledge graph
    memoryStore: opts.memoryStore,
    projectMemoryStore: opts.projectMemoryStore,
    sessionChanges: opts.sessionChanges,
    // 子智能体派发：按请求角色运行隔离子循环（包括 Explore 与 Planner）。
    // 动态导入 run-subagent，避免 subagent ↔ loop 的静态导入环。
    dispatchSubagent: async (request) => {
      const { runExploreSubagent, resolveContinuation } = await import("./subagent/run-subagent.ts");
      const relevantHistory = request.relevantHistory?.trim()
        ? request.relevantHistory
        : opts.activeTasks?.find((task) => task.relevantHistory?.trim())?.relevantHistory;
      const subagentDeps = {
        workspaceRoot: opts.workspaceRoot,
        sessionId: opts.sessionId,
        workflow: opts.workflow,
        mode: opts.mode,
        index: opts.index,
        codemap: opts.codemap,
        llmApiKey: opts.llmApiKey,
        signal: opts.signal,
        renderPage: opts.renderPage,
        // 危险命令确认回调必须透传：子循环里 looksDangerous 命中时，没有
        // 这个回调就会走硬拦截分支，宿主弹窗永远不会出现。
        confirmDangerousBash: opts.confirmDangerousBash,
        autoApproveDangerousBash: opts.autoApproveDangerousBash,
        budget: opts.budget,
        onEvent: opts.onEvent,
      };
      // 续接解析（拒绝语义见 resolveContinuation）：拒绝直接把原因串交还父智能体。
      const continuation = resolveContinuation(request, subagentThreads);
      if (continuation.kind === "refused") return continuation.message;
      if (continuation.kind === "continue") {
        const { report, transcript } = await runExploreSubagent(
          { ...request, relevantHistory, initialMessages: continuation.initialMessages }, subagentDeps);
        if (transcript) subagentThreads.set(request.continueAgentId!, withClosingReport(transcript, report));
        return report;
      }
      const agentId = `explore-${++subagentThreadSeq}`;
      const { report, transcript } = await runExploreSubagent(
        { ...request, relevantHistory }, subagentDeps);
      if (request.agentType === "Planner") return report;
      if (transcript) subagentThreads.set(agentId, withClosingReport(transcript, report));
      // id 尾注是父智能体发现续接通道的唯一入口（工具结果为纯文本）。
      return `${report}\n\n---\n[Explore agent id: ${agentId} · dispatch again with continueAgentId="${agentId}" to ask follow-ups with its full context intact]`;
    },
    // Shared bounded evidence cache and sequential task-list updates.
    evidenceStore: opts.evidenceStore,
    updateTasks: opts.singleSpecTask ? undefined : opts.updateTasks,
  };

  // ── Resolve middle stages from pipeline (user-configurable) ──
  // T8-T10: resolveMidStages now includes context_gather so the scheduler
  // dispatches it through its StageHandler instead of hardcoding it before the loop.
  let midStages = resolveMidStages(pipeline);
  if (opts.singleSpecTask) {
    const execute = midStages.find((node) => node.type === "execute_tools");
    midStages = midStages.filter((node) => node === execute || node.type === "context_gather" ||
      node.type === "post_verify" || node.type === "present_changes");
  }
  if (opts.leanPipeline) {
    // Subagents run only the tool stage; no context gather, decomposition,
    // verification, or change presentation.
    midStages = midStages.filter(
      (n: PipelineNode) => n.type === "execute_tools" || n.type === "explore_tools",
    );
  }

  const presentNodes = midStages.filter((n: PipelineNode) => n.type === "present_changes");
  const presentNode = presentNodes[presentNodes.length - 1];


  const finish = (assistantText: string): AgentLoopResult => {
    const autoKeep = presentNode?.params?.autoKeepChanges === true;
    updateTraceStats(reasoningTrace, estimateTokens(messages.map((m: ChatMessage) => m.content ?? "").join("")), 0, 0);
    const traceSummary = tracer.formatSummary();
    opts.onEvent?.({ type: "trace_report", summary: traceSummary });

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

    const specTaskOutcome: AgentLoopResult["specTaskOutcome"] = !opts.singleSpecTask ? undefined
      : opts.signal?.aborted ? { status: "cancelled" }
      : state.handoffRequested ? { status: "blocked", result: assistantText }
      : state.specTaskApprovalBlocked ? { status: "blocked", result: state.blockedReason }
      : state.specTaskSubmission?.status === "completed" && state.taskRunState?.phase === "completed"
        && !state.aborted && !state.blocked && !state.awaitingUserConfirmation
        ? { status: "completed", result: state.specTaskSubmission.result }
        : state.specTaskSubmission?.status === "partial"
          ? { status: "partial", result: state.specTaskSubmission.result }
          : { status: "failed", result: state.blockedReason ?? state.specTaskSubmission?.result ?? SPEC_TASK_REPORT_REQUIRED };

    return {
      ...(specTaskOutcome && { specTaskOutcome }),
      history,
      assistantText,
      // 完整 LLM 消息转录：父循环为 Explore 子代理注册续接线程用。
      agentMessages: messages,
      lastPlanPath: toolCtx.lastPlanPath,
      currentFeature: toolCtx.currentFeature,
      presentChanges:
        opts.mode === "agent" ? presentNodes.length > 0 && !autoKeep : undefined,
      documentWorkflow: state.documentWorkflow,
      // 透传本轮 git 快照锚点：turn 层 persistCheckpoint 引用它（ZCode 式）。
      snapshotRef: state.snapshotRef ?? undefined,
      reasoningTrace,
      traceSummary,
      taskRunState: state.taskRunState ?? opts.taskRunState ?? null,
      successRejected: state.successRejected === true || state.postVerifyFailed === true,
      // 透传硬限制（迭代/工具调用/成本上限）终态，供 Explore 子智能体标注部分结果。
      blocked: state.blocked === true,
      blockedReason: state.blockedReason,
      // 透传中止终态（用户中止 / 工具循环检测终止）：子代理调度方据此标注
      // 部分结果，此前该信息在 finish() 处被丢弃，aborted 只影响父级跳过
      // verify，子级拿到的是"看似完整"的假成功报告。
      aborted: state.aborted === true,
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
                relevantHistory: state.rawDecompose.relevantHistory ?? "",
                tasks: state.rawDecompose.tasks.map((task) => ({
                  id: task.id,
                  ...(task.title ? { title: task.title } : {}),
                  executionGuidance: task.executionGuidance,
                  ...(task.kind ? { kind: task.kind } : {}),
                  ...(task.dependsOn ? { dependsOn: task.dependsOn } : {}),
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
    // 续接转录已含全部前置上下文，且 userMessage 已在消息构造时追加，
    // 调度器不得再注入历史打包或重复的用户消息。
    userMessageInjected: Boolean(opts.initialMessages),
    budgetUsed: 0,
    decomposeCount: 0,
    aborted: false,
    awaitingUserConfirmation: false,
    handoffRequested: false,
    documentWorkflow: undefined,
    shortCircuited: false,
    blocked: false,
    blockedReason: undefined,
    planRequested: false,
    planApproval: null,
    planApprovalFeedback: undefined,
    approvedAgentPlan: undefined,
    verifyNodeForReport: null,
    decomposeTokens: 0,
    taskRunState: opts.taskRunState ?? null,
    successRejected: false,
  };

  const schedulerCtx: SchedulerContext = {
    opts: { ...opts },
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
    if (!opts.singleSpecTask) {
      await resumeAgentPlan(schedulerCtx);
    } else if (opts.signal?.aborted) {
      state.aborted = true;
    } else if (!selectedSpecTask(opts) || !midStages.some((node) => node.type === "execute_tools")
      || !toolCtx.availableTools?.has(SPEC_TASK_OUTCOME_TOOL) || !toolCtx.availableTools?.has("report_blocker")) {
      state.blocked = true;
      state.blockedReason = "Single Spec task execution requires one selected runnable task, an Agent execution stage, and the outcome tools.";
      state.lastAssistant = state.blockedReason;
    }
    if (!state.aborted && !state.blocked && !state.awaitingUserConfirmation) {
      await runPipelineScheduler(midStages, schedulerCtx);
    }
    // Seal completion only after execution-grounded post_verify has run.
    if (opts.singleSpecTask && state.specTaskSubmission?.status === "completed" && state.taskRunState
      && !state.aborted && !opts.signal?.aborted && !state.blocked && !state.awaitingUserConfirmation) {
      const sealed = sealTaskRunSuccess(state.taskRunState, {
        requiresVerification: state.specTaskSubmission.requiresVerification,
      });
      state.taskRunState = sealed.state;
      if (!sealed.ok) {
        state.successRejected = true;
        state.blocked = true;
        state.blockedReason = sealed.reason;
        const notice = formatVerificationFailureNotice(sealed.state);
        state.lastAssistant = `${state.lastAssistant}\n\n${notice}`;
        const last = history[history.length - 1];
        if (last?.role === "assistant") last.content = state.lastAssistant;
        opts.onEvent?.({ type: "assistant_delta", text: `\n\n${notice}` });
      }
    }
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
    if (opts.singleSpecTask) {
      state.blocked = true;
      state.blockedReason = `Stage error: ${msg}`;
    }
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
      if (opts.signal?.aborted) {
        state.aborted = true;
      } else {
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
