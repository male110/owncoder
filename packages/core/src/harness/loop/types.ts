import type { ChatMessage, ToolDef } from "@owncoder/llm";
import type { ModelRef, SystemWorkflowConfig } from "@owncoder/settings";
import type { AgentMode } from "@owncoder/shared";
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
import type { AdaptivePromptOptimizer } from "../prompt-optimizer.ts";
import type { TaskItem } from "../../plans.ts";
import type { TraceReport } from "../observability.ts";
import type { ContextControlState } from "./context-control.ts";

/**
 * Discriminated event payloads. `sessionId` is stamped at the loop / session
 * boundary so individual emit sites can omit it; the stamp rejects empty ids.
 */
type TurnEventFields =
  | { type: "assistant_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_end"; id: string; name: string; ok: boolean; output: string; metadata?: ToolResultMetadata; skipped?: boolean }
  | { type: "terminal"; entry: TerminalEntry }
  | { type: "stage_start"; id: string; nodeType: string; label: string }
  | { type: "stage_done"; id: string; nodeType: string; label: string }
  /**
   * Result of the task_decompose stage: the understanding paragraph, the
   * durable user constraints, and the ordered steps (with information needs
   * and stop-reading criteria). Emitted once per turn after the decomposition
   * call completes, so the user can review and judge the decomposition.
   */
  | {
      type: "task_decomposition";
      understanding: string;
      /** 可恢复任务的显式状态快照。 */
      taskState?: import("../../turn-rounds.ts").TaskState;
      userConstraints: string[];
      steps: Array<{
        id: string;
        description: string;
        dependsOn: string[];
        informationNeeds: Array<{ id: string; question: string }>;
        stopReadingWhen: Array<{ condition: string; requiredEvidenceIds: string[] }>;
      }>;
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
      requiresFreshRead: number;
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
  /** 
   * 纯文本内容（向后兼容）
   * 当 parts 存在时，这是所有 parts 的纯文本连接
   * 当 parts 不存在时，这是完整内容
   */
  content: string;
  toolName?: string;
  
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
export type DocumentType = "prd" | "tdd" | "design" | "architecture" | "other";

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

/** Persisted state for the staged PRD → TDD → implementation-plan workflow. */
export interface DocumentWorkflowState {
  stage: "awaiting_prd_confirmation" | "awaiting_tdd_confirmation";
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
  todoAnchor?: string | null;
  projectRules?: string | null;
  /** Staged document workflow state owned and persisted by the session. */
  documentWorkflow?: DocumentWorkflowState | null;

  fileSnapshots?: FileSnapshot[];
  touchedPaths?: string[];
  /** Paths modified in the most recently completed turn of this session.
   * The context gatherer injects these so the model knows to re-read them. */
  recentlyTouchedPaths?: string[];
  confirmDangerousBash?: (command: string) => Promise<boolean>;
  /** Ask the user a question (options or free text) and block until answered. */
  askUser?: (request: AskUserRequest) => Promise<string>;
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
  /** Adaptive prompt optimizer owned by the session (persists across turns). */
  promptOptimizer?: AdaptivePromptOptimizer;
  /** Structured task list from the approved plan (agent mode, hard step driver). */
  activeTasks?: TaskItem[];
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
   * are available to the loop. This is the opencode-style permission sandbox:
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
}

export interface AgentLoopResult {
  history: ChatTurn[];
  assistantText: string;
  lastPlanPath?: string;
  /** Undefined = unchanged; null = implementation plan saved and the flow completed. */
  documentWorkflow?: DocumentWorkflowState | null;
  presentChanges?: boolean;
  reasoningTrace?: ReasoningTrace;
  verification?: { passed: boolean; summary: string };
  traceSummary?: string;
  /** 本轮结束时的统一任务运行状态，供会话持久化。 */
  taskRunState?: import("../../task-run.ts").TaskRunState | null;
  /** 成功门禁拒绝时为 true（验证未通过却试图报告成功）。 */
  successRejected?: boolean;
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
}
