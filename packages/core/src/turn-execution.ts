/**
 * 单轮代理执行与收尾。
 *
 * 从 index.ts (SessionOrchestrator.executeAgentTurn) 拆分：由
 * SessionRunCoordinator 的 drain handler 触发。这里集中处理
 * MessageProjector 组装、事件持久化、checkpoint 保存、历史自动压缩、
 * 会话/turn 落盘与 turn_complete 发射；编排器只负责构建 AgentTurnContext
 * （会话运行时、全局配置与宿主桥接）。
 */
import type { ChatAttachment } from "@owncoder/llm";
import type { SystemWorkflowConfig } from "@owncoder/settings";
import type { CodemapImpact, CodemapSearchHit, IndexClient } from "@owncoder/index";
import { runAgentLoop, type AgentLoopResult, type TurnEvent } from "./harness/loop.ts";
import { stampTurnEvent, type AgentLoopOpts, type MessageMetadata } from "./harness/loop/types.ts";
import type { AskUserRequest } from "./harness/tools/types.ts";
import { appendTurnEvent, completeTurn } from "./conversation-store.ts";
import { saveSessionById } from "./session-store.ts";
import { newCheckpointId, persistCheckpoint, type FileSnapshot } from "./harness/checkpoint.ts";
import { readActiveMeta, readPlanFile, writeActiveMeta, type TaskItem } from "./plans.ts";
import { applyTaskEvent, taskRunMetricsSnapshot, taskRunPhaseLabel, taskRunTotalDurationMs } from "./task-run.ts";
import type { McpManager } from "./mcp/client.ts";
import type { UserMemoryStore } from "./user-memories.ts";
import type { ChangeFile } from "./changes.ts";
import type { SessionRuntime } from "./session-runtime.ts";
import { buildSessionPersistPayload, enqueueSessionPersist } from "./session-persist.ts";
import { compactHistory } from "./history-compact.ts";

export interface AgentTurnContext {
  sessionId: string;
  text: string;
  turnId: string;
  onEvent?: (ev: TurnEvent) => void;
  attachments: ChatAttachment[];
  /** 会话运行时（history、terminalLog、persistQueue 等直接在本函数内读写）。 */
  runtime: SessionRuntime;
  /** 本轮绑定的项目根目录；openWorkspace 切换不影响这个快照。 */
  workspaceRoot: string;
  /** 协调器为本轮创建的中止控制器；调用前已镜像到 runtime.abort。 */
  abortController: AbortController;
  workflow: SystemWorkflowConfig;
  /** 本轮启用 checkpoint 与否（workflow.harness.checkpoint）。 */
  checkpointEnabled: boolean;
  /** 绑定到本会话项目的查询索引。 */
  index: IndexClient;
  /** 面向 agent 工具的 codemap 查询桥。 */
  codemap: {
    search: (query: string, limit?: number) => Promise<CodemapSearchHit[]>;
    impact: (nodeId: string, depth?: number) => Promise<CodemapImpact>;
  };
  llmApiKey: string | null;
  projectRules: string | null;
  /** 预格式化的可用技能目录（注入 system prompt）。 */
  skillsCatalog: string | null;
  /** use_skill 工具的技能加载 API。 */
  skills: AgentLoopOpts["skills"];
  /** 已格式化的全局+项目 memories 提示块。 */
  memoriesBlock: string | null;
  mcp: McpManager;
  memoryStore: UserMemoryStore | null;
  projectMemoryStore: UserMemoryStore | null;
  historyVector: AgentLoopOpts["historyVector"] | undefined;
  confirmDangerousBash?: (command: string) => Promise<boolean>;
  /** Auto-approve dangerous bash commands (settings modes.agent.autoApproveBash). */
  autoApproveDangerousBash?: boolean;
  askUser?: (req: AskUserRequest) => Promise<string>;
  renderPage?: AgentLoopOpts["renderPage"];
  sessionChanges: {
    getPendingChanges(): Promise<{ checkpointId: string | null; files: ChangeFile[]; expired?: boolean }>;
    undoChange(path: string): Promise<void>;
  };
  /** 活动计划任务状态的串行化更新队列。 */
  enqueueActivePlanUpdate<T>(update: () => Promise<T>): Promise<T>;
}

export async function executeAgentTurn(ctx: AgentTurnContext): Promise<AgentLoopResult> {
  const { sessionId, turnId, runtime: r, workspaceRoot, onEvent } = ctx;
  const trimmed = ctx.text.trim();
  const attachments = ctx.attachments;

  // 创建 MessageProjector 用于构建结构化消息
  const { MessageProjector } = await import("./message-projector.js");
  const projector = new MessageProjector();

  // Capture workspace root for persist. openWorkspace() may switch the active
  // workspace and clear runtimes while sendMessage is still running. Using
  // the passed-in runtime + captured root survives the workspace switch.
  const capturedRoot = workspaceRoot;
  const timingContext = `sid=${sessionId} turn=${turnId}`;
  const logTiming = (step: string, started: number, status = "done") => {
    console.log(`[turn] ${timingContext} step=${step} status=${status} duration=${Math.round(performance.now() - started)}ms`);
  };
  const timed = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    let status = "error";
    console.log(`[turn] ${timingContext} step=${step} start`);
    try {
      const value = await run();
      status = "done";
      return value;
    } finally {
      logTiming(step, started, status);
    }
  };
  const directPersist = (): Promise<void> => {
    const queuedAt = performance.now();
    const run = async () => {
      logTiming("session_queue_wait", queuedAt);
      return timed("session_save", async () => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [persist] sid=${r.id} historyLen=${r.history.length} terminalLogLen=${r.terminalLog.length}`);
        const meta = await saveSessionById(capturedRoot, r.id, buildSessionPersistPayload(r));
        r.sessionTitle = meta.title;
      });
    };
    return enqueueSessionPersist(r, run);
  };

  let activePlan: { path: string; content: string } | null = null;
  let activeTasks: TaskItem[] | undefined;
  let currentTaskId: string | null | undefined;
  if (r.mode === "agent" && r.activePlanPath) {
    try {
      const content = await readPlanFile(workspaceRoot, r.activePlanPath);
      activePlan = { path: r.activePlanPath, content };
      const meta = await readActiveMeta(workspaceRoot);
      if (meta && meta.tasks.length > 0) {
        activeTasks = meta.tasks;
        currentTaskId = meta.currentTaskId;
      }
    } catch {
      activePlan = null;
    }
  }

  const onTaskUpdate = async (tasks: TaskItem[], nextId: string | null) => {
    const activePlanPath = r.activePlanPath;
    const snapshot = JSON.parse(JSON.stringify(tasks)) as TaskItem[];
    // 有批准计划：写回 .owncoder/plans/.active/<sid>.json（线程安全队列）。
    if (activePlanPath) {
      await ctx.enqueueActivePlanUpdate(async () => {
        const meta = await readActiveMeta(workspaceRoot);
        if (!meta) throw new Error("活动计划在任务执行期间丢失");
        if (meta.path !== activePlanPath) {
          throw new Error("活动计划已切换，拒绝写入过期的任务状态");
        }
        meta.tasks = snapshot;
        meta.currentTaskId = nextId;
        await writeActiveMeta(workspaceRoot, meta);
      });
    }
    // 无论有无计划都下发 task_update，DecomposeCard 靠它实时显示顺序任务状态。
    onEvent?.(stampTurnEvent({ type: "task_update", tasks: snapshot, currentTaskId: nextId }, sessionId));
  };

  const fileSnapshots: FileSnapshot[] = [];
  const touchedPaths: string[] = [];
  const historyBefore = r.history.map((h) => ({ ...h }));
  const checkpointEnabled = ctx.checkpointEnabled;

  // user 消息不在此预先追加，统一由 stage-handlers 在 loop 内注入 history，
  // 避免与 stage-handlers 的 history.push(user) 双重写入导致用户消息重复落盘。
  // turn 完成后由 result.history 覆盖并 persist；loop 抛错时在 catch 中补写。

  // 为此会话注册日志目录，确保多工作区场景下日志写入正确的位置
  const { registerTaskLogDir } = await import("@owncoder/llm");
  registerTaskLogDir(r.id, workspaceRoot);

  let eventPersist: Promise<unknown> = Promise.resolve();
  const persistEvent = (ev: TurnEvent) => {
    // Stream deltas are presentation-only and must never create one durable
    // row per token. Persist lifecycle/tool/task events only; the final
    // transcript remains in the existing session snapshot for compatibility.
    if (ev.type === "thinking_delta" || ev.type === "assistant_delta" ||
        ev.type === "minimum_context_decision" || ev.type === "minimum_context_read_follow_up") {
      return;
    }
    // Large tool/terminal bodies are truncated inside appendTurnEvent
    // (slimDurableEvent) so every write path stays bounded.
    const payload = ev;
    eventPersist = eventPersist.then(() => appendTurnEvent(capturedRoot, sessionId, turnId, payload, {
      eventType: ev.type,
    })).catch((error) => {
      console.warn(`[conversation] turn event append failed (${turnId}):`, error);
    });
  };

  let result: AgentLoopResult;
  try {
    result = await runAgentLoop({
      mode: r.mode,
      workspaceRoot,
      sessionId: r.id,
      turnId,
      workflow: ctx.workflow,
      index: ctx.index,
      codemap: ctx.codemap,
      history: r.history,
      userMessage: trimmed,
      attachments,
      signal: ctx.abortController.signal,
      onEvent: (ev) => {
        const stamped = stampTurnEvent(ev, sessionId);
        persistEvent(stamped);
        // 将事件传递给 projector
        projector.handleEvent(stamped);

        if (stamped.type === "terminal") {
          const idx = r.terminalLog.findIndex((t) => t.id === stamped.entry.id);
          if (idx >= 0) r.terminalLog[idx] = stamped.entry;
          else r.terminalLog.push(stamped.entry);
          // Cap terminal log during live turns to bound memory growth.
          // The 80-entry limit was only enforced on disk restore; a long
          // agent turn with many bash calls could accumulate unboundedly.
          const MAX_TERMINAL_LIVE = 80;
          if (r.terminalLog.length > MAX_TERMINAL_LIVE) {
            r.terminalLog = r.terminalLog.slice(-MAX_TERMINAL_LIVE);
          }
        }
        if (
          stamped.type === "task_decomposition" ||
          stamped.type === "stage_done"
        ) {
          void directPersist();
        }
        onEvent?.(stamped);
      },
      activePlan,
      activeTasks,
      currentTaskId,
      onTaskUpdate,
      todoAnchor: r.mode === "agent" ? r.todoAnchor : null,
      currentFeature: r.currentFeature ?? undefined,
      projectRules: ctx.projectRules,
      skillsCatalog: ctx.skillsCatalog,
      skills: ctx.skills,
      documentWorkflow: r.documentWorkflow,
      taskRunState: r.taskRunState,

      fileSnapshots: checkpointEnabled ? fileSnapshots : undefined,
      touchedPaths: checkpointEnabled ? touchedPaths : undefined,
      confirmDangerousBash: ctx.confirmDangerousBash,
      autoApproveDangerousBash: ctx.autoApproveDangerousBash,
      askUser: ctx.askUser,
      renderPage: ctx.renderPage,
      llmApiKey: ctx.llmApiKey,
      mcp: ctx.mcp,
      memoryStore: ctx.memoryStore ?? undefined,
      projectMemoryStore: ctx.projectMemoryStore ?? undefined,
      memoriesBlock: ctx.memoriesBlock,
      historyVector: ctx.historyVector,
      sessionChanges: ctx.sessionChanges,
      });
  } catch (error) {
    const finalizeStarted = performance.now();
    const messageStarted = performance.now();
    // 判断是否是用户中止
    const isAborted = error instanceof Error && error.name === 'AbortError';

    // loop 失败时，用户消息已在 sendMessage 中可靠落盘；这里只补写助手错误消息。
    // 不要再次追加 user，否则失败回合会产生重复的 ChatTurn。

    // ✅ 准备错误或中止状态的 metadata
    const errorMetadata: Partial<MessageMetadata> = isAborted
      ? { aborted: true, abortReason: '用户中止', isPartial: true }
      : { error: error instanceof Error ? error.message : String(error), isPartial: true };

    // ✅ 完成 projector，传入错误 metadata（保证不可变性）
    const { parts, metadata } = projector.finalize(errorMetadata);

    // Expand tool_use/tool_result into independent tool ChatTurns so the UI
    // process panel still lists every step after an LLM/runtime failure.
    // Previously partsToContent() collapsed them into one assistant blob,
    // which made "执行过程 · N 步" look like only the last few tools survived.
    const errorSuffix = isAborted
      ? "\n\n[用户已中止]"
      : `\n\n[错误: ${metadata.error}]`;
    const expanded = MessageProjector.partsToChatTurns(parts, {
      assistantSuffix: parts.length > 0 ? errorSuffix : undefined,
      metadata,
    });
    if (expanded.length > 0) {
      r.history.push(...expanded);
    } else {
      const errorMsg = isAborted
        ? "[用户已中止]"
        : `[执行失败: ${metadata.error}]`;
      r.history.push({
        role: "assistant",
        content: errorMsg,
        parts: [{ type: "text", text: errorMsg }],
        metadata,
      });
    }

    logTiming("final_message", messageStarted);
    await directPersist();
    await timed("events_drain", () => eventPersist);
    await timed("completeTurn", () => completeTurn(capturedRoot, sessionId, turnId, { error: metadata.error, aborted: isAborted }, isAborted ? "cancelled" : "failed"));
    const notifyStarted = performance.now();
    // 收尾落盘完成后再发 turn_complete，让界面「已完成」与 sendChat 返回对齐。
    if (onEvent) {
      onEvent(stampTurnEvent({
        type: "turn_complete",
        parts,
        metadata,
      }, sessionId));
    }
    logTiming("turn_complete_emit", notifyStarted, onEvent ? "done" : "skipped");
    logTiming("finalize_total", finalizeStarted, isAborted ? "cancelled" : "failed");
    r.abort = null;

    // 注销会话日志目录映射
    const { unregisterTaskLogDir } = await import("@owncoder/llm");
    unregisterTaskLogDir(r.id);

    throw error;
  }

  const finalizeStarted = performance.now();
  const projectorStarted = performance.now();
  // 完成 projector，获取结构化消息
  // timestamp 已在 finalize() 中自动设置，无需额外处理
  const { parts, metadata } = projector.finalize();

  // ✅ 更新 runtime 的 history 为 loop 返回的完整 history
  r.history = result.history;
  logTiming("projector_finalize", projectorStarted);
  const compactStarted = performance.now();
  let compactedHistory = false;

  // Auto-compact: bound in-memory history after each turn to prevent
  // unbounded heap growth during long sessions. The manual compactNow()
  // has the same logic but is only triggered by /compact; this keeps the
  // runtime size under control automatically.
  const AUTO_COMPACT_BUDGET = 120 * 1024; // bytes (UTF-16 char count × 2)
  const AUTO_COMPACT_WINDOW = 30;          // keep at most this many recent turns
  if (r.history.length > AUTO_COMPACT_WINDOW) {
    const outcome = compactHistory(r.history, {
      recentWindow: AUTO_COMPACT_WINDOW,
      budgetBytes: AUTO_COMPACT_BUDGET,
      reason: "auto",
    });
    if (outcome.compacted) {
      r.history = outcome.history;
      compactedHistory = true;
      if (r.taskRunState && sessionId) {
        r.taskRunState = applyTaskEvent(r.taskRunState, {
          type: "observability",
          taskId: r.taskRunState.taskId,
          contextCompressions: 1,
        });
        onEvent?.({
          type: "task_run_state",
          sessionId,
          taskId: r.taskRunState.taskId,
          phase: r.taskRunState.phase,
          verificationStatus: r.taskRunState.verification.status,
          verificationPassed: r.taskRunState.verification.passed,
          verificationSummary: r.taskRunState.verification.summary,
          repairAttempts: r.taskRunState.repairAttempts,
          maxRepairAttempts: r.taskRunState.maxRepairAttempts,
          label: taskRunPhaseLabel(r.taskRunState.phase),
          metrics: taskRunMetricsSnapshot(r.taskRunState.metrics),
          totalDurationMs: taskRunTotalDurationMs(r.taskRunState.metrics),
        });
      }
      console.log(`[session] auto-compact: ${outcome.oldCount} old turns → summary, kept ${AUTO_COMPACT_WINDOW} recent`);
    }
  }

  logTiming("history_compact", compactStarted, compactedHistory ? "done" : "skipped");
  const messageStarted = performance.now();
  // 循环内已把最终报告写入 history。不要把整轮 projector parts
  //（含每一次 assistant_delta）再叠到最后一条消息 / turn_complete 上，
  // 否则用户会看到同一份最终报告两次。
  let completeParts = parts;
  if (r.history.length > 0) {
    const lastMsg = r.history[r.history.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
      lastMsg.metadata = metadata;
      if (!lastMsg.content || !lastMsg.content.trim()) {
        lastMsg.parts = parts;
        lastMsg.content = MessageProjector.partsToContent(parts);
      } else {
        const thinkingParts = parts.filter((part) => part.type === "thinking");
        completeParts = [...thinkingParts, { type: "text", text: lastMsg.content }];
        lastMsg.parts = completeParts;
      }
    }
  }

  if (result.lastPlanPath) {
    r.lastPlanPath = result.lastPlanPath;
  }
  if (result.currentFeature) {
    r.currentFeature = result.currentFeature;
  }
  if (result.documentWorkflow !== undefined) {
    r.documentWorkflow = result.documentWorkflow;
  }
  if (result.taskRunState !== undefined) {
    r.taskRunState = result.taskRunState;
  }

  logTiming("final_message", messageStarted);
  const persistStarted = performance.now();
  let checkpointMs = 0;
  if (checkpointEnabled && (fileSnapshots.length > 0 || touchedPaths.length > 0)) {
    const cp = {
      id: newCheckpointId(),
      createdAt: new Date().toISOString(),
      historyLen: historyBefore.length,
      history: historyBefore,
      files: fileSnapshots,
      touched: [...new Set(touchedPaths)],
      sessionId: r.id ?? null,
    };
    const checkpointStarted = performance.now();
    await timed("checkpoint", () => persistCheckpoint(workspaceRoot, cp));
    checkpointMs = Math.round(performance.now() - checkpointStarted);
    r.lastCheckpointId = cp.id;
    r.keptPaths.clear();

    // present_changes disabled or autoKeep → keep all (no review UI)
    if (result.presentChanges === false) {
      for (const p of cp.touched) r.keptPaths.add(p);
    }
  }

  if (!checkpointEnabled || (fileSnapshots.length === 0 && touchedPaths.length === 0)) {
    logTiming("checkpoint", performance.now(), "skipped");
  }
  const sessionStarted = performance.now();
  await directPersist();
  const sessionMs = Math.round(performance.now() - sessionStarted);
  const eventsStarted = performance.now();
  await timed("events_drain", () => eventPersist);
  const eventsMs = Math.round(performance.now() - eventsStarted);
  const completeStarted = performance.now();
  await timed("completeTurn", () => completeTurn(capturedRoot, sessionId, turnId, result));
  const completeMs = Math.round(performance.now() - completeStarted);
  console.log(`[turn] ${timingContext} persist checkpoint=${checkpointMs}ms session=${sessionMs}ms events=${eventsMs}ms completeTurn=${completeMs}ms total=${Math.round(performance.now() - persistStarted)}ms`);
  const notifyStarted = performance.now();
  // 收尾落盘完成后再发 turn_complete，让界面「已完成」与 sendChat 返回对齐。
  if (onEvent) {
    onEvent(stampTurnEvent({
      type: "turn_complete",
      parts: completeParts,
      metadata,
    }, sessionId));
  }
  logTiming("turn_complete_emit", notifyStarted, onEvent ? "done" : "skipped");
  logTiming("finalize_total", finalizeStarted);
  r.abort = null;

  // 注销会话日志目录映射
  const { unregisterTaskLogDir } = await import("@owncoder/llm");
  unregisterTaskLogDir(r.id);

  return result;
}
