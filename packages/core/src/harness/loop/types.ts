import type { ChatAttachment, ChatMessage, ToolDef } from "@owncoder/llm";
import type { ModelRef, SystemWorkflowConfig } from "@owncoder/settings";
import type { AgentMode, TaskDecompositionDto } from "@owncoder/shared";
import type { IndexClient } from "@owncoder/index";
import type { TerminalEntry } from "../terminal.ts";
import type { FileSnapshot } from "../checkpoint.ts";
import type { McpManager } from "../../mcp/client.ts";
import type { ToolContext } from "../execute.ts";
import type { ToolResultMetadata, AskUserRequest } from "../tools/types.ts";
import type { AgentPlan, ReasoningTrace } from "../agent-reasoning.ts";
import type { MemoryManager } from "../memory.ts";
import type { Tracer } from "../observability.ts";
import type { UserMemoryStore } from "../../user-memories.ts";
import type { TaskItem } from "../../plans.ts";
import type { TraceReport } from "../observability.ts";
import type { ContextControlState } from "./context-control.ts";

/** Public, bounded ReAct decision summary; excludes private chain-of-thought. */
export interface ReactDecisionSummary {
  iteration: number;
  goal: string;
  action: string;
  reasonSummary: string;
  expectedObservation: string;
  actualObservationSummary?: string;
  nextDecision?: string;
  timestamp: number;
}

/**
 * Discriminated event payloads. `sessionId` is stamped at the loop / session
 * boundary so individual emit sites can omit it; the stamp rejects empty ids.
 */
/**
 * 子智能体（Explore）来源标识。子循环的工具事件镜像到父回合时携带该字段，
 * 前端据此把工具流折叠进对应的子智能体卡片，而不是与主循环工具混排。
 * id 与包裹它的 stage_start/stage_done 事件 id 相同，用于关联开闭。
 */
export interface SubagentProvenance {
  /** 固定为 "Explore"，当前唯一支持的子智能体类型。 */
  agentType: string;
  /** 子智能体阶段 id，与 stage_start/stage_done 的 id 一致。 */
  id: string;
  /** 派发给子智能体的任务摘要（截断），用于卡片标题。 */
  task: string;
}

type TurnEventFields =
  /**
   * 「截至目前」的累积文本快照，不是增量片段：codec 每次下发的是该文本
   * 段的完整内容（渲染端按替换语义渲染连续气泡）。累积消费用
   * applyStreamSnapshot / pushStreamSnapshot，直接 += 会产生 O(n²) 重复。
   * 一次性整段文本（finalReport 等）也走该事件，追加语义由前者保留。
   */
  | { type: "assistant_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; args: Record<string, unknown>; subagent?: SubagentProvenance }
  | { type: "tool_end"; id: string; name: string; ok: boolean; output: string; metadata?: ToolResultMetadata; skipped?: boolean; subagent?: SubagentProvenance }
  | { type: "terminal"; entry: TerminalEntry }
  | { type: "stage_start"; id: string; nodeType: string; label: string }
  | { type: "stage_done"; id: string; nodeType: string; label: string; ok?: boolean; report?: string }
  /**
   * Result of the task_decompose stage: the user's intent, the durable user
   * constraints, and the tasks (each with its ordered steps, information needs
   * and stop-reading criteria). Emitted once per turn after the decomposition
   * call completes, so the user can review and judge the decomposition.
   */
  | {
      type: "task_decomposition";
      intent: string;
      userConstraints: string[];
      tasks: TaskDecompositionDto["tasks"];
      /** 任务相关历史：与 tasks 同级，简单任务无需分解时仍提取。 */
      relevantHistory: string;
      /** True when the LLM call failed and the shown plan is a local heuristic fallback. */
      fallback: boolean;
    }
  | { type: "error"; message: string }
  /** Non-fatal problem the user should know about; the turn keeps running. */
  | { type: "warning"; message: string }
  /** Non-fatal context-budget warning: fixed segments exceed input budget. */
  | { type: "context_warning"; message: string; fixedTotal: number; inputBudget: number }
  // "done" event removed — turn_complete handles all completion duties
  | { type: "reasoning_step"; stepType: string; content: string }
  | { type: "decision_summary"; summary: ReactDecisionSummary }
  | { type: "recovery"; errorType: import("../recovery.ts").RecoveryErrorType; action: import("../recovery.ts").RecoveryAction; retryable: boolean; summary: string }
  | { type: "verification_result"; passed: boolean; summary: string }
  | { type: "trace_report"; summary: string }
  | { type: "semantic_search"; results: number }
  /** Content-free record of the initial minimum-context selection. */
  | {
      type: "minimum_context_decision";
      selectionMode: "off" | "observe" | "apply";
      selectedCandidates: number;
      omittedCandidates: number;
      materializedCandidates: number;
      indexedPaths: number;
      budgetUsed: number;
      tokenBudget: number;
    }
  /** Freshness receipt state changed after a structured current-source read or mutation. */
  | {
      type: "minimum_context_read_follow_up";
      action: "fresh_read" | "invalidated" | "invalidated_all";
      path?: string;
      startLine?: number;
      endLine?: number;
      totalLines?: number;
      affectedPaths?: number;
    }
  | {
      type: "history_filter";
      originalTurns: number;
      filteredTurns: number;
      charsSaved: number;
      filteringTime: number;
      stagesApplied: string[];
    }
  | { type: "task_update"; tasks: TaskItem[]; currentTaskId: string | null }
  /**
   * Unified task-run snapshot for UI live status.
   * Emitted whenever TaskRunState changes inside the ReAct loop.
   */
  | {
      type: "task_run_state";
      phase: import("../../task-run.ts").TaskRunPhase;
      taskId: string;
      verificationStatus: import("../../task-run.ts").VerificationStatus;
      verificationPassed: boolean;
      verificationSummary: string;
      repairAttempts: number;
      maxRepairAttempts: number;
      /** Short Chinese label suitable for liveStatus. */
      label: string;
      /** 本轮任务可观测性指标（阶段四）。 */
      metrics?: import("../../task-run.ts").TaskRunMetrics;
      /** 总耗时（ms），含当前未封账阶段。 */
      totalDurationMs?: number;
    }
  | {
      type: "loop_termination_metrics";
      terminationReason: string;
      isAborted: boolean;
      iterations: number;
      totalToolCalls: number;
      consecutiveSimilarOutputs: number;
      consecutiveTextOnlyTurns: number;
      metadata?: Record<string, unknown>;
    }
  /**
   * turn_complete - 回合完成事件（阶段三架构）
   *
   * 在 done 事件之后发送，包含本回合构建的完整结构化消息
   * 前端接收后可以缓存 parts，用于历史消息的结构化渲染
   */
  | {
      type: "turn_complete";
      /** 本回合的所有消息部件 */
      parts: MessagePart[];
      /** 消息元数据 */
      metadata: MessageMetadata;
    };

/** Event payload as emitted inside the loop (sessionId may still be missing). */
export type TurnEventInput = TurnEventFields & { sessionId?: string };

/** Every turn event carries the owning chat session id after the stamp boundary. */
export type TurnEvent = TurnEventFields & { sessionId: string };

/** Stamp a non-empty `sessionId` onto a turn event. Empty ids are rejected. */
export function stampTurnEvent(ev: TurnEventInput, sessionId: string): TurnEvent {
  if (!sessionId) {
    throw new Error("stampTurnEvent requires a non-empty sessionId");
  }
  return ev.sessionId === sessionId ? (ev as TurnEvent) : { ...ev, sessionId };
}

// ── Structured Message Parts ──────────────────────────────────────────────────

/**
 * MessagePart - 结构化消息的基本单元
 * 
 * 每条消息可以包含多个 part，每个 part 代表不同类型的内容：
 * - text: 普通文本（助手回复、用户输入）
 * - thinking: 思考过程（内部推理）
 * - tool_use: 工具调用请求
 * - tool_result: 工具执行结果
 */
export type MessagePart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "thinking";
      text: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

/**
 * MessageMetadata - 消息元数据
 */
export interface MessageMetadata {
  /** 消息创建时间（ISO 8601） */
  timestamp?: string;
  /** 使用的模型 */
  model?: string;
  /** 停止原因（stop, length, tool_use等） */
  stopReason?: string;
  /** Token使用统计 */
  tokens?: {
    input: number;
    output: number;
  };
  /** 压缩元数据（保持向后兼容） */
  isCompressed?: boolean;
  originalLength?: number;
  compressedAt?: string;
  compressionReason?: "context_limit" | "manual" | "auto" | "disk_save" | "retained";
  importantSnippets?: string[];
  
  /** 错误和状态相关 */
  error?: string;           // 错误消息
  isPartial?: boolean;      // 是否是部分消息（因错误或中止而不完整）
  aborted?: boolean;        // 是否被用户中止
  abortReason?: string;     // 中止原因
  
  /** 其他可扩展字段 */
  [key: string]: unknown;
}

export interface ChatTurn {
  role: "user" | "assistant" | "tool" | "system";
  /** 会话内唯一 turn id（历史归档 / 向量检索关联用，向后兼容可选）。 */
  id?: string;
  /** 所属对话轮次（用户输入+回复对）的持久化 turn id，用于整轮删除。 */
  turnId?: string;
  /** 
   * 纯文本内容（向后兼容）
   * 当 parts 存在时，这是所有 parts 的纯文本连接
   * 当 parts 不存在时，这是完整内容
   */
  content: string;
  attachments?: ChatAttachment[];
  toolName?: string;
  /** 工具调用参数，用于历史执行过程回放。 */
  toolArgs?: Record<string, unknown>;
  
  /**
   * 结构化消息部件（阶段三架构）
   * 当存在时，UI应该从parts渲染，而不是从content解析
   */
  parts?: MessagePart[];
  
  /**
   * 消息元数据（阶段三架构）
   */
  metadata?: MessageMetadata;
  
  // 压缩元数据（已弃用，保留向后兼容）
  /** @deprecated 使用 metadata.isCompressed */
  isCompressed?: boolean;
  /** @deprecated 使用 metadata.originalLength */
  originalLength?: number;
  /** @deprecated 使用 metadata.compressedAt */
  compressedAt?: string;
  /** @deprecated 使用 metadata.compressionReason */
  compressionReason?: "context_limit" | "manual" | "auto" | "disk_save" | "retained";
  /** @deprecated 使用 metadata.importantSnippets */
  importantSnippets?: string[];
}

/** Document type classification for workflow tracking. */
export type DocumentType = "spec" | "design" | "tasks" | "other";

/** Document status in the workflow. */
export type DocumentStatus = "pending_approval" | "approved" | "modified";

/** Metadata for a single document in the workflow. */
export interface DocumentMetadata {
  /** Document type (PRD, TDD, etc.) */
  type: DocumentType;
  /** Workspace-relative path using forward slashes */
  path: string;
  /** When this document was created */
  createdAt: string;
  /** Current approval status */
  status: DocumentStatus;
  /** Paths of documents this one depends on */
  basedOn?: string[];
}

/** Persisted state for the staged spec → design → tasks approval workflow. */
export interface DocumentWorkflowState {
  stage:
    | "awaiting_spec_confirmation"
    | "awaiting_design_confirmation"
    | "awaiting_tasks_confirmation"
    | "spec_workflow_done";
  /** Current document awaiting approval (for backward compatibility) */
  documentPath: string;
  updatedAt: string;
  /** 已生成的所有文档路径列表，按生成顺序排列（PRD, TDD等） - deprecated, use documents instead */
  allDocuments?: string[];
  /** Enhanced document metadata with type, status, and dependencies */
  documents?: DocumentMetadata[];
}

export interface AgentLoopOpts {
  mode: AgentMode;
  workspaceRoot: string;
  /** Owning chat session id; required so every emitted event can be stamped. */
  sessionId: string;
  /** Durable conversation-store turn id for structured execution records. */
  turnId?: string;
  workflow: SystemWorkflowConfig;
  index: IndexClient;
  codemap?: ToolContext["codemap"];
  history: ChatTurn[];
  userMessage: string;
  attachments?: ChatAttachment[];
  signal?: AbortSignal;
  onEvent?: (ev: TurnEventInput) => void;
  maxIterations?: number;
  /**
   * Optional replacement for the loop's default `persistExperiences()` call
   * (which writes to `.owncoder/experiences/`). `SessionOrchestrator` never sets
   * this, so its existing behavior is unchanged.
   */
  persistExperiencesOverride?: (
    workspaceRoot: string,
    report: TraceReport,
    index?: IndexClient,
  ) => Promise<string[]>;
  activePlan?: { path: string; content: string } | null;
  /** Spec feature carried into the loop so save_spec/save_design/save_tasks can track it. */
  currentFeature?: string;
  todoAnchor?: string | null;
  projectRules?: string | null;
  /** Pre-formatted available-skills catalog injected into the system prompt. */
  skillsCatalog?: string | null;
  /** Skill loading API backing the use_skill tool. */
  skills?: ToolContext["skills"];
  /** Staged document workflow state owned and persisted by the session. */
  documentWorkflow?: DocumentWorkflowState | null;

  fileSnapshots?: FileSnapshot[];
  touchedPaths?: string[];
  /** Paths modified in the most recently completed turn of this session.
   * The context gatherer injects these so the model knows to re-read them. */
  recentlyTouchedPaths?: string[];
  confirmDangerousBash?: (command: string) => Promise<boolean>;
  /** Auto-approve dangerous bash commands (settings modes.agent.autoApproveBash). */
  autoApproveDangerousBash?: boolean;
  /** Ask the user a question (options or free text) and block until answered. */
  askUser?: (request: AskUserRequest) => Promise<string>;
  /**
   * Optional host browser renderer (Electron). Injected so web_fetch can fall
   * back to post-JS DOM content for CSR pages.
   */
  renderPage?: ToolContext["renderPage"];
  llmApiKey?: string | null;
  mcp?: McpManager;
  /** Memory manager for layered memory */
  memory?: MemoryManager;
  /** Enable execution-grounded verification */
  enableVerification?: boolean;
  /** Enable LSP tools */
  enableLsp?: boolean;
  /** Enable web search */
  enableWebSearch?: boolean;
  /** Global user memory store (cross-project preferences). */
  memoryStore?: UserMemoryStore;
  /** Project-scoped user memory store (current workspace only). */
  projectMemoryStore?: UserMemoryStore;
  /** Pre-formatted memories block for system prompt injection. */
  memoriesBlock?: string | null;
  /**
   * Pending session file changes API (checkpoint-backed), same as UI Changes bar.
   * Enables list_session_changes / undo_session_change tools.
   */
  sessionChanges?: ToolContext["sessionChanges"];

  /** Whether auto-fix is enabled after file-modifying tools */
  enableAutoFix?: boolean;
  /** Disable knowledge graph population from the index */
  disableKnowledgeGraph?: boolean;
  /** Structured task list from the approved plan (agent mode, hard step driver). */
  activeTasks?: TaskItem[];
  /** Shared bounded evidence cache for fresh source reads in this turn. */
  evidenceStore?: import("../evidence-store.ts").EvidenceStore;
  /**
   * 动态任务清单更新闭包（add_tasks / update_tasks 工具）。任务图路径由调度器注入
   * （改共享 tasks 数组）；顺序路径由 react.ts 兜底安装（改 ctx.tasks）。
   */
  updateTasks?: (ops: import("../../plans.ts").TaskListOps) => Promise<import("../../plans.ts").TaskListApplyOutcome>;
  /**
   * 历史向量检索基础设施（可选）。由调用方（Electron main）注入 sqlite-vec +
   * embedding 实现；未注入时 `history_compact` 退化为原有「最近 N 轮 → LLM 过滤」行为。
   */
  historyVector?: {
    embedding: import("./history-vector.ts").EmbeddingService;
    store: import("./history-vector.ts").HistoryVectorStore;
    /** 向量召回 top-K（默认 5，与任务分解使用的最近 5 轮历史一致）。 */
    topK?: number;
    /**
     * 历史归档器（turn 结束时调用）；未提供则不做向量归档。
     * turnIndex 由 store 内部单调分配，调用方无需（也不能）传入。
     */
    archive?: (turn: ChatTurn, sessionId: string) => void | Promise<void>;
    archiveRound?: (round: import("./history-vector.ts").HistoryRoundInput) => void | Promise<void>;
    /** 删除某会话的待归档队列与已写入向量。 */
    deleteSession?: (sessionId: string) => void;
    /** 释放归档存储及其 native 资源。 */
    close?: () => void;
  };
  /** id of the task the agent must currently execute; null when none active. */
  currentTaskId?: string | null;
  /** Called whenever task status/currentTaskId changes so the session can persist + notify UI. */
  onTaskUpdate?: (tasks: TaskItem[], currentTaskId: string | null) => void | Promise<void>;
  /** 从会话/任务快照恢复的统一运行状态；agent 模式可继续。 */
  taskRunState?: import("../../task-run.ts").TaskRunState | null;

  /**
   * Tool whitelist — when set, only tools whose `function.name` is in this list
   * are available to the loop. This is the role-based permission sandbox:
   * the role declares what it may use, and everything else is denied at the
   * mechanism level, not merely asked-for in the prompt.
   */
  allowedTools?: string[];

  /**
   * Read-only sandbox — when true, all write/mutating tools (apply_patch,
   * write_file, bash, save_*, …) are removed.
   * Used as a fallback when a role sets `readOnly: true` but does not
   * declare an explicit `allowedTools` whitelist.
   */
  readOnly?: boolean;

  /**
   * Override the system prompt derived from the pipeline node. Used by
   * subagents (Explore) which carry their own specialist prompt instead of
   * the normal plan/agent pipeline prompt.
   */
  systemPromptOverride?: string;

  /**
   * Lean pipeline: skip context_gather / task_decompose / verify /
   * post_verify / present_changes and run only the tool stage. Used by
   * subagents which do their own focused research and must produce a plain
   * text report without the full task-driven turn machinery.
   */
  leanPipeline?: boolean;

  /**
   * When the iteration budget is exhausted without a report, issue one
   * tool-free model call that forces a write-up of the evidence gathered so
   * far, instead of returning an empty/placeholder result. Used by Explore so
   * a search that spends every turn on tool calls still yields partial
   * findings plus an explicit gap statement.
   */
  forcedFinalReportOnLimit?: boolean;
  /** Shared request budget; child loops reuse the same monotonic ledger. */
  budget?: import("../budget-ledger.ts").BudgetLedger;
  /** Deterministic local route chosen before pipeline execution. */
  requestRoute?: import("./request-router.ts").RequestRoute;
}

export interface AgentLoopResult {
  history: ChatTurn[];
  assistantText: string;
  lastPlanPath?: string;
  /** Spec feature most recently saved this turn (spec workflow tracking). */
  currentFeature?: string;
  /** Undefined = unchanged; null = implementation plan saved and the flow completed. */
  documentWorkflow?: DocumentWorkflowState | null;
  /** Public bounded summaries of ReAct choices. */
  decisionSummaries?: ReactDecisionSummary[];
  presentChanges?: boolean;
  reasoningTrace?: ReasoningTrace;
  verification?: { passed: boolean; summary: string };
  traceSummary?: string;
  /** 本轮结束时的统一任务运行状态，供会话持久化。 */
  taskRunState?: import("../../task-run.ts").TaskRunState | null;
  /** 成功门禁拒绝时为 true（验证未通过却试图报告成功）。 */
  successRejected?: boolean;
  /**
   * 达到硬限制（迭代/工具调用/成本上限）而结束，产出可能不完整。
   * Explore 子智能体据此把"部分结果"显式标注给父智能体。
   */
  blocked?: boolean;
  /** blocked 为 true 时的人类可读原因（如"已达到最大迭代限制（40 次）"）。 */
  blockedReason?: string;
}

export interface ReActLoopArgs {
  opts: AgentLoopOpts;
  model: ModelRef;
  messages: ChatMessage[];
  history: ChatTurn[];
  toolsFinal: ToolDef[];
  toolCtx: ToolContext;
  maxIter: number;
  stageId: string;
  reasoningTrace: ReasoningTrace;
  memory: MemoryManager;
  tracer: Tracer;
  plan: AgentPlan | null;
  /** Per-turn information requirements derived by task_decompose; never persisted. */
  transientInformationTask?: TaskItem | null;
  /** Ephemeral controls and receipts created by context_gather for this turn. */
  contextControl?: ContextControlState;
  correctionCount: number;
  /** Loop termination thresholds (T6); defaults from react.ts module consts. */
  maxRepeatToolCalls?: number;
  maxTotalToolCalls?: number;
  maxSameFileReads?: number;
  maxConsecutiveReadonlyIters?: number;
  maxEmptyResponses?: number;
  /** Max distinct pages (different offsets) per file before stuck detection fires. */
  maxPagesPerFile?: number;
  /** Max redundant reads of ranges that are already fully covered for one file. */
  maxRedundantRangesPerFile?: number;
  /** ReAct loop sub-steps config — from node.params.reactSteps. Falls back to defaultReactSteps(). */
  reactSteps?: import("@owncoder/settings").ReactStepConfig[];
  /** 思考配置：覆盖 workflow.thinking.defaultEffort，优先级更高。 */
  thinking?: import("@owncoder/llm").ThinkingConfig;
  /** 本轮 task_decompose 的原始分解结果（供顺序任务执行与历史归档）。 */
  rawDecompose?: {
    intent: string;
    userConstraints?: string[];
    relevantHistory?: import("../../plans.ts").TaskRelevantHistory;
    tasks: Array<{
      id: string;
      title?: string;
      description: string;
      prompt: string;
      kind?: "implementation" | "verification";
      dependsOn?: string[];
    }>;
  };
}
