import type { AgentMode, WorkspaceInfo } from "@owncoder/shared";
import type { SystemWorkflowConfig } from "@owncoder/settings";
import type { IndexClient } from "@owncoder/index";
import type { ChatTurn, DocumentWorkflowState } from "./harness/loop.ts";
import type { TerminalEntry } from "./harness/terminal.ts";
import type { TaskRunState } from "./task-run.ts";
import type { QueuedMessage } from "./session-store.ts";

/**
 * Global + focus-session state. workspace/workflow are global; activeSessionId
 * is the front-end focus session. Per-session fields live in `SessionRuntime`.
 */
export interface SessionState {
  mode: AgentMode;
  workspace: WorkspaceInfo | null;
  workflow: SystemWorkflowConfig;
  activePlanPath: string | null;
  lastPlanPath: string | null;
  /** Spec feature this session is working on (spec → design → tasks chain). */
  currentFeature: string | null;
  todoAnchor: string | null;
  lastCheckpointId: string | null;
  /** Pending PRD/TDD workflow state, persisted with the active chat session. */
  documentWorkflow: DocumentWorkflowState | null;
  /** True when history was restored from disk. */
  sessionRestored: boolean;
  activeSessionId: string | null;
  sessionTitle: string | null;
  /** Messages queued while a turn was running; persisted to survive restarts. */
  queuedMessages?: QueuedMessage[];
  /** 统一任务运行状态（会话级快照）。 */
  taskRunState?: TaskRunState | null;
}


/**
 * Per-session runtime state. Multiple sessions can run concurrently in the
 * background; each has its own history, abort controller, terminal log, plan
 * state, checkpoint state, and persist/plan-update queues. Global resources
 * (workspace, index, codemap, mcp, memories, llmApiKey, workflow, projectRules,
 * fileWatcher) remain on the orchestrator singleton.
 */
export interface SessionRuntime {
  id: string;
  history: ChatTurn[];
  abort: AbortController | null;
  terminalLog: TerminalEntry[];
  mode: AgentMode;
  activePlanPath: string | null;
  lastPlanPath: string | null;
  currentFeature: string | null;
  todoAnchor: string | null;
  lastCheckpointId: string | null;
  documentWorkflow: DocumentWorkflowState | null;
  sessionRestored: boolean;
  sessionTitle: string | null;
  sessionCreatedAt: string | null;
  queuedMessages: QueuedMessage[];
  /** 统一任务运行状态；从会话快照恢复，供下一轮 agent 循环继续。 */
  taskRunState: TaskRunState | null;
  keptPaths: Set<string>;
  persistQueue: Promise<void>;
  activePlanUpdateQueue: Promise<void>;
  /** Project this runtime was created in. Survives workspace switches so persist() writes to the right folder. */
  workspaceRoot: string | null;
  /** Query-only index bound to workspaceRoot. Survives a later global project switch. */
  index: IndexClient | null;
}

export function createSessionRuntime(id: string, mode: AgentMode = "agent"): SessionRuntime {
  return {
    id,
    history: [],
    abort: null,
    terminalLog: [],
    mode,
    activePlanPath: null,
    lastPlanPath: null,
    currentFeature: null,
    todoAnchor: null,
    lastCheckpointId: null,
    documentWorkflow: null,
    sessionRestored: false,
    sessionTitle: null,
    sessionCreatedAt: null,
    queuedMessages: [],
    taskRunState: null,
    keptPaths: new Set(),
    persistQueue: Promise.resolve(),
    activePlanUpdateQueue: Promise.resolve(),
    workspaceRoot: null,
    index: null,
  };
}
