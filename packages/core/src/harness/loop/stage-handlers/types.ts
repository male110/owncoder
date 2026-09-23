/**
 * Shared types for stage handlers.
 * 
 * These types define the context and state passed between stage handlers in the
 * pipeline scheduler.
 */

import type { ChatMessage, ToolDef } from "@owncoder/llm";
import type { ModelRef, PipelineNode } from "@owncoder/settings";
import type { contextBudgets, ContextBudget, FixedSegments } from "../../budget.ts";
import type { Tracer } from "../../observability.ts";
import type { ToolContext } from "../../execute.ts";
import type { AgentPlan, ReasoningTrace } from "../../agent-reasoning.ts";
import type { MemoryManager } from "../../memory.ts";
import type { classifyTask } from "../../model-coordinator.ts";
import type { AgentLoopOpts, ChatTurn, DocumentWorkflowState } from "../types.ts";
import type { ContextControlState } from "../context-control.ts";
import type { TaskItem, TaskRelevantHistory } from "../../../plans.ts";

// ── Scheduler State (shared mutable across handlers) ───────────

export interface SchedulerState {
  lastAssistant: string;
  correctionCount: number;
  currentPlan: AgentPlan | null;
  /** Per-turn evidence-backed information requirements; never persisted to an active plan. */
  turnInformationTask: TaskItem | null;
  /** Set true once history + user message have been pushed into `messages`. */
  userMessageInjected: boolean;
  budgetUsed: number;
  /** Per-turn indexed-source receipts and output projection settings. */
  contextControl?: ContextControlState;
  aborted: boolean;
  /** A document deliverable was written; do not run later autonomous stages. */
  awaitingUserConfirmation: boolean;
  /**
   * The turn was handed back to the user via report_blocker. Suppresses the
   * autonomous follow-up stages (verify / post_verify) but still lets
   * present_changes run, so the user sees any diff alongside the blocker.
   */
  handoffRequested: boolean;
  /** Cross-turn document workflow update emitted by ReAct after a PRD/TDD write. */
  documentWorkflow?: DocumentWorkflowState | null;
  /** A stage produced the whole reply locally; stop all remaining pipeline stages. */
  shortCircuited: boolean;
  /**
   * First enabled verify node visited during this turn. The single endpoint in
   * `loop.ts` uses it to issue ONE final LLM verification report (instead of
   * one per verify node). Null if no verify node ran (or all were disabled).
   */
  verifyNodeForReport: PipelineNode | null;
  /** A ReAct stage could not proceed without additional user input/context. */
  blocked: boolean;
  blockedReason?: string;
  /** 本轮统一任务运行状态（由 ReAct 回写）。 */
  taskRunState?: import("../../../task-run.ts").TaskRunState | null;
  /** 成功门禁拒绝。 */
  successRejected?: boolean;
  /** post_verify 发生硬失败；禁止随后生成成功型验证报告。 */
  postVerifyFailed?: boolean;
  /** Fixed segment sizes measured during context_gather. */
  fixedSegments?: FixedSegments;
  /** Token-based context budget from context_gather (taskDecomposition=0). */
  tokenBudget?: ContextBudget;
  /** Token count of the task decomposition output (set by task_decompose). */
  decomposeTokens: number;
  /** Index of this turn in `.owncoder/sessions/{id}.rounds.json` after decompose persist. */
  roundIndex?: number;
  /** Raw task decomposition result with full informationNeeds (for history recall). */
  rawDecompose?: {
    intent: string;
    userConstraints?: string[];
    progressStatus?: string;
    tasks: Array<{
      id: string;
      description: string;
      steps: Array<{
        id: string;
        description: string;
        dependsOn: string[];
        informationNeeds: Array<{
          id: string;
          question: string;
          source?: "file" | "search" | "command";
          priority?: "blocking" | "important" | "nice-to-have";
          fallback?: string;
        }>;
        stopReadingWhen: Array<{ condition: string; requiredEvidenceIds: string[] }>;
        verificationCriteria?: {
          command: string;
          expectedOutput: string;
          exitCode?: number;
        };
        rollbackStrategy?: string;
        estimatedComplexity?: "low" | "medium" | "high";
        /** 本步可复用的全部相关历史（自由文本） */
        relevantHistory?: TaskRelevantHistory;
      }>;
    }>;
    /** 整单共享可复用历史（兼容；优先使用 steps[].relevantHistory） */
    relevantHistory?: TaskRelevantHistory;
  };
}

// ── Handler Context ────────────────────────────────────────────

export interface SchedulerContext {
  opts: AgentLoopOpts;
  messages: ChatMessage[];
  history: ChatTurn[];
  memory: MemoryManager;
  tracer: Tracer;
  reasoningTrace: ReasoningTrace;
  toolCtx: ToolContext;
  toolsFinal: ToolDef[];
  model: ModelRef;
  budgets: ReturnType<typeof contextBudgets>;
  state: SchedulerState;
  hasToolStage: boolean;
  hasExecute: boolean;

  taskClassification: ReturnType<typeof classifyTask>;
  /** Legacy load_anchors node (undefined after migration; kept for backward compat). */
  anchorsNode: PipelineNode | undefined;
}

export interface StageHandlerContext extends SchedulerContext {
  node: PipelineNode;
}

export interface StageHandler {
  run(ctx: StageHandlerContext): Promise<void>;
}
