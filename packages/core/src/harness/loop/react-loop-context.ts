/**
 * ReAct 循环共享上下文。
 *
 * 从 react.ts 拆分：runReActLoop 的循环状态此前全部是函数体内的闭包变量，
 * 无法逐字提取到独立模块。拆分后由本接口显式描述这份共享可变状态，
 * 各阶段辅助函数（react-finalize / react-termination-check / react-llm-call /
 * react-text-branch / react-tool-exec）通过 ctx 读写同一份状态；
 * 数组/对象字段（messages、history、taskReports 等）原地修改即对全体可见。
 */
import type { ChatMessage, ToolDef } from "@owncoder/llm";
import type { ModelRef } from "@owncoder/settings";
import type { Tracer } from "../observability.ts";
import type { MemoryManager } from "../memory.ts";
import type { ToolContext } from "../execute.ts";
import type { AutoFixState } from "../auto-fix.ts";
import type { TaskRunState } from "../../task-run.ts";
import type { TaskItem } from "../../plans.ts";
import type { ReasoningTrace, PlanStep, AgentPlan } from "../agent-reasoning.ts";
import type { ContextControlState } from "./context-control.ts";
import type {
  AgentLoopOpts,
  ChatTurn,
  DocumentWorkflowState,
  ReactDecisionSummary,
} from "./types.ts";
import type { LoopState, TerminationConfig } from "./termination.ts";
import type { TaskReport } from "./task-reports.ts";

/** runReActLoop 的内部返回形状（与公开签名一致）。 */
export type ReActReturn = {
  lastAssistant: string;
  aborted: boolean;
  awaitingUserConfirmation?: boolean;
  handoffRequested?: boolean;
  documentWorkflow?: DocumentWorkflowState | null;
  blocked?: boolean;
  blockedReason?: string;
  correctionCount: number;
  taskRunState?: TaskRunState | null;
  successRejected?: boolean;
  decisionSummaries?: ReactDecisionSummary[];
};

/** finalizeSuccess 的输入（taskRunState/successRejected/blocked 由门禁与记账补齐）。 */
export type FinalizeSuccessInput = Omit<ReActReturn, "taskRunState" | "successRejected" | "blocked" | "blockedReason"> & {
  blocked?: boolean;
  blockedReason?: string;
};

/** finalizeTerminal 的输入。 */
export type FinalizeTerminalInput = Omit<ReActReturn, "taskRunState">;

/** runReActLoop 各阶段共享的可变循环状态。 */
export interface ReActLoopContext {
  // ── 循环不变量（来自 args，整个循环期间不变） ──
  opts: AgentLoopOpts;
  model: ModelRef;
  messages: ChatMessage[];
  history: ChatTurn[];
  toolsFinal: ToolDef[];
  toolCtx: ToolContext;
  stageId: string;
  reasoningTrace: ReasoningTrace;
  memory: MemoryManager;
  tracer: Tracer;
  plan: AgentPlan | null;
  contextControl: ContextControlState | undefined;
  // ── 由 reactSteps 派生的配置 ──
  llmMaxRetries: number;
  maxConsecutiveReadonlyIters: number;
  /** 同文件重复读上限（stuck_detect.maxReadCount）：超过即拦截同文件读取。 */
  maxSameFileReads: number;
  toolExecParallel: boolean;
  docDeliverableEnabled: boolean;
  gitSnapshotEnabled: boolean;
  loopNudgeEnabled: boolean;
  // ── 任务驱动状态 ──
  taskDriven: boolean;
  tasks: TaskItem[];
  currentTask: TaskItem | null;
  turnInformationTask: TaskItem | null;
  /** Stable messages prefix at loop entry (system/context/decompose/user). */
  messagePrefixLen: number;
  /** Per-task reports retained across switches; composed into the final report. */
  taskReports: TaskReport[];
  // ── 任务运行状态 ──
  taskRunState: TaskRunState | null;
  autoFixState: AutoFixState;
  /** 是否在本轮执行过会触发验证的文件改动（用于成功门禁）。 */
  hadFileModifyingTools: boolean;
  /** 自动修复耗尽后的失败摘要（追加到最终报告，不中断流程）。 */
  autoFixFailureSummary: string | null;
  /** 思考配置：覆盖 workflow.thinking.defaultEffort，优先级更高。 */
  thinking?: import("@owncoder/llm").ThinkingConfig;
  // ── 终止系统 ──
  terminationConfig: TerminationConfig;
  loopState: LoopState;
  // ── 每轮可变标量 ──
  lastAssistant: string;
  correctionCount: number;
  currentStep: PlanStep | null;
  decisionSummaries: ReactDecisionSummary[];
  postToolTextNudgeCount: number;
  prevIterHadToolCalls: boolean;
  gitSnapshotWarned: boolean;
  // ── 工具计数 ──
  totalToolCalls: number;
  consecutiveReadonlyIters: number;
  /**
   * 同文件读取计数（归一化路径 → 成功读取次数）。超过 maxSameFileReads 的
   * 读取被拦截；写操作与任务切换时清空对应条目/整表。
   */
  sameFileReads: Map<string, number>;
  // ── 文档交付物 / 交还用户停止状态 ──
  documentDelivered: boolean;
  deliveredDocName: string;
  documentWorkflowUpdate: DocumentWorkflowState | null | undefined;
  handoffRequested: boolean;
  handoffReport: string;
}
