import type { AgentMode, WorkspaceInfo } from "@owncoder/shared";
import type { AskUserRequest } from "./harness/tools/types.ts";
import { BUILTIN_WORKFLOW, type SystemWorkflowConfig } from "@owncoder/settings";
import {
  createCodemapClient,
  createIndexClient,
  type CodemapClient,
  type CodemapImpact,
  type CodemapSearchHit,
  type IndexClient,
} from "@owncoder/index";
import { join, resolve } from "node:path";
import { watch, statSync, type FSWatcher, promises as fs } from "node:fs";
import { initLlmLogger } from "@owncoder/llm";
import {
  runAgentLoop,
  type AgentLoopResult,
  type ChatTurn,
  type DocumentWorkflowState,
  type TurnEvent,
  type TurnEventInput,
} from "./harness/loop.ts";
import { stampTurnEvent, type AgentLoopOpts, type MessageMetadata } from "./harness/loop/types.ts";
import {
  SessionRunCoordinator,
  type SessionInput,
} from "./session-coordinator.ts";
import {
  listCheckpoints,
  loadCheckpoint,
  newCheckpointId,
  persistCheckpoint,
  restoreCheckpointFiles,
  type FileSnapshot,
} from "./harness/checkpoint.ts";
export {
  fileEvidenceHash,
  isReusableEvidence,
  loadSharedEvidence,
  loadTaskState,
  persistSharedEvidence,
  persistTaskCheckpoint,
  persistTaskState,
  prepareTaskState,
} from "./task-state.ts";
export {
  applyTaskEvent,
  canReportSuccess,
  createTaskRunMetrics,
  createTaskRunState,
  finalizeTaskSuccess,
  formatVerificationFailureNotice,
  normalizeTaskRunMetrics,
  normalizeVerificationResult,
  restoreTaskRunState,
  sealTaskRunSuccess,
  taskRunMetricsSnapshot,
  taskRunPhaseLabel,
  taskRunTotalDurationMs,
  verificationStatus,
  type TaskEvent,
  type TaskRunMetrics,
  type TaskRunPhase,
  type TaskRunState,
  type VerificationCheck,
  type VerificationError,
  type VerificationResult,
  type VerificationStatus,
} from "./task-run.ts";
import {
  buildChangesFromCheckpoint,
  restoreSingleFile,
  type ChangeFile,
} from "./changes.ts";
import { getGitStatus, type GitStatus } from "./git.ts";
import { McpManager } from "./mcp/client.ts";
import { migrateHistory, needsMigration } from "./session-migration.ts";
import {
  beginTurn,
  appendTurnEvent,
  completeTurn,
  migrateLegacyHistory,
  loadRecentTurns,
  loadOlderTurns,
  projectConversationTurns,
} from "./conversation-store.ts";

import type { TerminalEntry } from "./harness/terminal.ts";
import {
  clearPersistedSession,
  createSessionFile,
  deleteSessionFile,
  listSessionMetas,
  loadSessionById,
  type PersistedSession,
  saveSessionById,
  setActiveSessionId,
  toggleSessionPin,
  type SessionMeta,
} from "./session-store.ts";
import type { TaskRunState } from "./task-run.ts";
import { applyTaskEvent, restoreTaskRunState, taskRunMetricsSnapshot, taskRunPhaseLabel, taskRunTotalDurationMs } from "./task-run.ts";
import {
  deleteRule,
  listRules,
  loadCombinedRules,
  readRule,
  writeRule,
  type RuleFileInfo,
} from "./rules.ts";
import {
  extractTitle,
  isPlanPath,
  listPlans,
  readActiveMeta,
  readPlanFile,
  writeActiveMeta,
  writePlanFile,
  parseTasksFromMarkdown,
  normalizeTasks,
  selectNextPendingTask,
  ACTIVE_DIR,
  type ActivePlanMeta,
  type PlanInfo,
  type TaskItem,
  type TaskStatus,
} from "./plans.ts";
import { UserMemoryStore } from "./user-memories.ts";
import { AdaptivePromptOptimizer } from "./harness/prompt-optimizer.ts";

export type { TurnEvent, TurnEventInput };
export { stampTurnEvent } from "./harness/loop.ts";
export type {
  AgentLoopOpts,
  HistoryChunk,
  HistoryChunkInput,
  HistorySearchHit,
  EmbeddingService,
  HistoryVectorStore,
  HistoryRoundInput,
} from "./harness/loop.ts";
export { archiveTurn, computeContentHash } from "./harness/loop.ts";
export { isRedactionEnabled, isSensitiveFile, redactSecrets } from "./harness/redact.ts";

export interface SessionState {
  mode: AgentMode;
  workspace: WorkspaceInfo | null;
  workflow: SystemWorkflowConfig;
  activePlanPath: string | null;
  lastPlanPath: string | null;
  todoAnchor: string | null;
  lastCheckpointId: string | null;
  /** Pending PRD/TDD workflow state, persisted with the active chat session. */
  documentWorkflow: DocumentWorkflowState | null;
  /** True when history was restored from disk. */
  sessionRestored: boolean;
  activeSessionId: string | null;
  sessionTitle: string | null;
  /** Messages queued while a turn was running; persisted to survive restarts. */
  queuedMessages?: string[];
  /** 统一任务运行状态（会话级快照）。 */
  taskRunState?: TaskRunState | null;
}

/**
 * Per-session runtime state. Multiple sessions can run concurrently in the
 * background; each has its own history, abort controller, terminal log, plan
 * state, checkpoint state, and persist/plan-update queues. Global resources
 * (workspace, index, codemap, mcp, memories, llmApiKey, workflow, projectRules,
 * fileWatcher, promptOptimizer) remain on the orchestrator singleton.
 */
interface SessionRuntime {
  id: string;
  history: ChatTurn[];
  abort: AbortController | null;
  terminalLog: TerminalEntry[];
  mode: AgentMode;
  activePlanPath: string | null;
  lastPlanPath: string | null;
  todoAnchor: string | null;
  lastCheckpointId: string | null;
  documentWorkflow: DocumentWorkflowState | null;
  sessionRestored: boolean;
  sessionTitle: string | null;
  sessionCreatedAt: string | null;
  queuedMessages: string[];
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

function createSessionRuntime(id: string, mode: AgentMode = "agent"): SessionRuntime {
  return {
    id,
    history: [],
    abort: null,
    terminalLog: [],
    mode,
    activePlanPath: null,
    lastPlanPath: null,
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

const ERR_NO_WORKSPACE = "请先打开项目文件夹";

export class SessionOrchestrator {
  /** Global + focus-session state. workspace/workflow are global; activeSessionId
   * is the front-end focus session. Per-session fields live in `runtimes`. */
  private state: SessionState = {
    mode: "plan",
    workspace: null,
    workflow: BUILTIN_WORKFLOW,
    activePlanPath: null,
    lastPlanPath: null,
    todoAnchor: null,
    lastCheckpointId: null,
    documentWorkflow: null,
    sessionRestored: false,
    activeSessionId: null,
    sessionTitle: null,
  };

  /** Per-session runtimes keyed by sessionId. The focus session is
   * `state.activeSessionId`; its runtime fields mirror the legacy `state`
   * fields for backward compatibility with getState(). */
  private runtimes = new Map<string, SessionRuntime>();
  /** Stable project binding for sessions whose idle runtime has been unloaded. */
  private sessionRoots = new Map<string, string>();

  /** Session execution coordinator - ensures at most one active drain loop per session */
  private coordinator: SessionRunCoordinator<AgentLoopResult, { turnId: string; onEvent?: (ev: TurnEvent) => void }> = 
    new SessionRunCoordinator(
      // Drain handler: 执行一轮代理循环，使用 input.context 中的 onEvent
      async (sessionId: string, input: SessionInput<{ turnId: string; onEvent?: (ev: TurnEvent) => void }>) => {
        const { turnId, onEvent } = input.context || {};
        if (!turnId) throw new Error(`Missing turnId for session ${sessionId}`);
        return await this.executeAgentTurn(sessionId, input.text, turnId, onEvent);
      },
      // Continuation check: 检查是否需要继续（暂时总是返回 false）
      async (_sessionId: string, _lastResult: AgentLoopResult) => {
        // TODO: 检查工具调用等需要继续的情况
        // 例如：return lastResult.needsToolCalls || lastResult.needsUserInput;
        return false;
      }
    );

  /** Get the runtime for a session, creating an empty one on first access.
   * When `id` is omitted, uses the focus session (state.activeSessionId). */
  private rt(id?: string | null): SessionRuntime {
    const sid = id ?? this.state.activeSessionId;
    if (!sid) {
      throw new Error("没有活跃会话");
    }
    let r = this.runtimes.get(sid);
    if (!r) {
      r = createSessionRuntime(sid, this.state.mode);
      r.workspaceRoot = this.sessionRoots.get(sid) ?? this.state.workspace?.root ?? null;
      this.runtimes.set(sid, r);
    }
    if (r.workspaceRoot) this.sessionRoots.set(sid, r.workspaceRoot);
    return r;
  }

  /** Like rt() but returns undefined instead of throwing when no session. */
  private rtOpt(id?: string | null): SessionRuntime | undefined {
    const sid = id ?? this.state.activeSessionId;
    if (!sid) return undefined;
    let r = this.runtimes.get(sid);
    if (!r) {
      r = createSessionRuntime(sid, this.state.mode);
      r.workspaceRoot = this.sessionRoots.get(sid) ?? this.state.workspace?.root ?? null;
      this.runtimes.set(sid, r);
    }
    if (r.workspaceRoot) this.sessionRoots.set(sid, r.workspaceRoot);
    return r;
  }

  /** Stamp runtimes that don't yet know their project, using the current workspace. */
  private stampRuntimeWorkspaces(): void {
    const root = this.state.workspace?.root;
    if (!root) return;
    for (const r of this.runtimes.values()) {
      if (!r.workspaceRoot) r.workspaceRoot = root;
      this.sessionRoots.set(r.id, r.workspaceRoot);
    }
  }

  /**
   * Project directory this session was created/sent under.
   * Must not follow a later global workspace switch — file lookup, persist,
   * and the agent loop all bind to this snapshot.
   */
  private sessionWorkspaceRoot(sessionId?: string | null): string {
    const r = sessionId ? this.runtimes.get(sessionId) : this.rtOpt();
    const root = r?.workspaceRoot
      ?? (sessionId ? this.sessionRoots.get(sessionId) : null)
      ?? this.state.workspace?.root
      ?? null;
    if (!root) throw new Error(ERR_NO_WORKSPACE);
    if (r && !r.workspaceRoot) r.workspaceRoot = root;
    if (sessionId) this.sessionRoots.set(sessionId, root);
    return root;
  }

  private sessionWorkspace(sessionId?: string | null): { root: string; name: string } {
    const root = this.sessionWorkspaceRoot(sessionId);
    const current = this.state.workspace;
    if (current && current.root === root) return { root: current.root, name: current.name };
    const name = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || root;
    return { root, name };
  }

  /**
   * File/symbol lookup for this session. Always a dedicated query client bound
   * to the session project — never `this.index`, which switchWorkspace/openWorkspace
   * reopen onto the newly focused project and would otherwise make an in-flight
   * turn report files from the wrong directory.
   */
  private sessionIndex(sessionId: string, workspaceRoot: string): IndexClient {
    const r = this.runtimes.get(sessionId);
    if (r?.index) return r.index;
    const bound = createIndexClient();
    bound.setExtraIgnore?.(this.state.workflow.index.extraIgnore ?? []);
    void bound.open(workspaceRoot, undefined, { mode: "query" }).catch((error) => {
      console.warn(`[session] query index open failed for ${workspaceRoot}:`, error);
    });
    if (r) r.index = bound;
    return bound;
  }

  /**
   * Running or unfinished: in-flight turn, queued inputs, or pending coordinator work.
   * Project switches must leave these runtimes untouched.
   */
  private isSessionIncomplete(sessionId: string): boolean {
    if (this.coordinator.isActive(sessionId) || this.coordinator.getPendingCount(sessionId) > 0) {
      return true;
    }
    const r = this.runtimes.get(sessionId);
    if (!r) return false;
    return Boolean(r.abort) || r.queuedMessages.length > 0;
  }

  private index: IndexClient = createIndexClient();
  private codemap: CodemapClient | null = null;
  private codemapInitPromise: Promise<CodemapClient> | null = null;
  private codemapInitRetries = 0;
  private readonly MAX_CODEMAP_RETRIES = 3;
  private readonly CODEMAP_RETRY_DELAY_MS = 1000;

  /** 
   * 获取或初始化Codemap客户端
   * 由于新实现是异步的,需要lazy初始化
   * 
   * 错误恢复策略:
   * 1. 失败后重置promise,允许重试
   * 2. 最多重试3次,每次延迟1秒
   * 3. 检测损坏数据库并自动重建
   * 4. 完全失败后降级为stub客户端
   */
  private async getCodemapClient(): Promise<CodemapClient> {
    if (this.codemap) return this.codemap;
    if (this.codemapInitPromise) return this.codemapInitPromise;
    
    this.codemapInitPromise = this.initCodemapWithRetry()
      .then(client => {
        this.codemap = client;
        this.codemapInitRetries = 0; // 重置重试计数
        console.log("[OwnCoder] Codemap initialized successfully");
        return client;
      })
      .catch(error => {
        // 重置promise以允许下次调用重试
        this.codemapInitPromise = null;
        
        console.error("[OwnCoder] Codemap initialization failed:", error);
        
        // 如果超过最大重试次数,创建stub客户端作为降级
        if (this.codemapInitRetries >= this.MAX_CODEMAP_RETRIES) {
          console.warn("[OwnCoder] Codemap initialization exhausted retries, using stub client");
          this.codemap = this.createStubCodemapClient();
          return this.codemap;
        }
        
        throw error;
      });
    
    return this.codemapInitPromise;
  }

  /**
   * 带重试的Codemap初始化
   */
  private async initCodemapWithRetry(): Promise<CodemapClient> {
    while (this.codemapInitRetries < this.MAX_CODEMAP_RETRIES) {
      try {
        const client = await createCodemapClient();
        
        // 验证客户端可用性
        await this.validateCodemapClient(client);
        
        return client;
      } catch (error) {
        this.codemapInitRetries++;
        
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[OwnCoder] Codemap init attempt ${this.codemapInitRetries}/${this.MAX_CODEMAP_RETRIES} failed: ${errorMsg}`
        );
        
        // 检测是否是数据库损坏错误
        if (this.isDatabaseCorrupted(error)) {
          console.warn("[OwnCoder] Detected corrupted database, attempting to rebuild...");
          await this.cleanupCorruptedDatabase();
          // 清理后立即重试,不计入重试次数
          this.codemapInitRetries--;
          continue;
        }
        
        // 如果还有重试机会,等待后重试
        if (this.codemapInitRetries < this.MAX_CODEMAP_RETRIES) {
          await this.sleep(this.CODEMAP_RETRY_DELAY_MS * this.codemapInitRetries); // 指数退避
          continue;
        }
        
        throw error;
      }
    }
    
    throw new Error("Codemap initialization failed after max retries");
  }

  /**
   * 验证Codemap客户端是否可用
   */
  private async validateCodemapClient(client: CodemapClient): Promise<void> {
    try {
      // 简单的健康检查: 调用status()
      await client.status();
    } catch (error) {
      throw new Error(`Codemap client validation failed: ${error}`);
    }
  }

  /**
   * 检测是否是数据库损坏错误
   */
  private isDatabaseCorrupted(error: unknown): boolean {
    const errorMsg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    
    return (
      errorMsg.includes("database disk image is malformed") ||
      errorMsg.includes("database is locked") ||
      errorMsg.includes("not a database") ||
      errorMsg.includes("file is not a database") ||
      errorMsg.includes("sqlite") && errorMsg.includes("corrupt")
    );
  }

  /**
   * 清理损坏的数据库文件
   */
  private async cleanupCorruptedDatabase(): Promise<void> {
    if (!this.state.workspace) return;
    
    const dbPath = join(this.state.workspace.root, ".owncoder", "unified-index.db");
    
    try {
      await fs.unlink(dbPath);
      console.log("[OwnCoder] Removed corrupted database:", dbPath);
    } catch (error) {
      // 文件可能不存在,忽略错误
      console.warn("[OwnCoder] Failed to remove database:", error);
    }
  }

  /**
   * 创建stub客户端作为降级方案
   */
  private createStubCodemapClient(): CodemapClient {
    const stubStatus = async (): Promise<import("@owncoder/index").CodemapStatus> => ({
      ready: false,
      fileCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      message: "Codemap unavailable (initialization failed)",
    });

    return {
      async status() {
        return stubStatus();
      },
      async build(_root: string) {
        console.warn("[OwnCoder] Stub codemap: build() called but no-op");
        return stubStatus();
      },
      async search(_query: string, _limit?: number) {
        console.warn("[OwnCoder] Stub codemap: search() called but returning empty results");
        return [];
      },
      async impact(_query: string, _depth?: number) {
        console.warn("[OwnCoder] Stub codemap: impact() called but returning empty results");
        return {
          focal: {
            id: "",
            name: "",
            kind: "",
            path: "",
            startLine: 0,
            endLine: 0,
            language: "",
          },
          callers: [],
          callees: [],
          likelyTests: [],
          directCallers: 0,
          transitiveCallers: 0,
          riskLevel: "low",
          riskScore: 0,
          explanation: "Stub implementation - no impact analysis available",
        };
      },
    };
  }

  /**
   * 延迟辅助函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Access the embedded CodeGraph engine through OwnCoder's private API. */
  async getCodemap(): Promise<CodemapClient> {
    return this.getCodemapClient();
  }

  /**
   * Ensure the Codemap graph is fresh before an agent query. If a rebuild is
   * pending (file changed but the debounce window hasn't elapsed), flush it
   * immediately instead of waiting, so the agent reads the latest graph. On the
   * steady state (no changes, already built) this is a no-op and the search
   * hits the native layer directly.
   */
  private async flushCodemapForQuery(): Promise<void> {
    // Never build the whole workspace synchronously from an agent tool call.
    // The desktop UtilityProcess owns indexing; queries use the latest snapshot.
  }

  async searchCodemapForAgent(query: string, limit = 12): Promise<CodemapSearchHit[]> {
    await this.flushCodemapForQuery();
    const codemap = await this.getCodemapClient();
    const t = Date.now();
    const hits = await codemap.search(query, limit);
    console.warn(
      `[owncoder/codemap] search query=${JSON.stringify(query)} ${Date.now() - t}ms results=${hits.length}`,
    );
    return hits;
  }

  async impactCodemapForAgent(nodeId: string, depth = 3): Promise<CodemapImpact> {
    await this.flushCodemapForQuery();
    const codemap = await this.getCodemapClient();
    const t = Date.now();
    const impact = await codemap.impact(nodeId, depth);
    console.warn(
      `[owncoder/codemap] impact nodeId=${JSON.stringify(nodeId)} ${Date.now() - t}ms`,
    );
    return impact;
  }

  /** FS watcher for live incremental index updates; closed on workspace switch. */
  private fileWatcher: FSWatcher | null = null;
  /** Per-path debounce timers for the file watcher, so repeated save events
   * (e.g. editor auto-save) collapse into a single `invalidate` call. */
  private fileWatchTimers: Map<string, NodeJS.Timeout> = new Map();
  private confirmDangerousBash: ((command: string, sessionId?: string) => Promise<boolean>) | null = null;
  private askUserHandler: ((req: AskUserRequest, sessionId?: string) => Promise<string>) | null = null;
  private renderPageHandler: AgentLoopOpts["renderPage"] | null = null;
  private llmApiKey: string | null = null;
  private projectRules = "";

  private mcp = new McpManager();
  private memoryStore: UserMemoryStore | null = null;
  private projectMemoryStore: UserMemoryStore | null = null;
  /** Adaptive prompt optimizer; persists learned failure patterns across turns. */
  private promptOptimizer = new AdaptivePromptOptimizer();
  /** 历史向量检索基础设施（可选，由 desktop 层注入 sqlite-vec + embedding）。 */
  private historyVector: AgentLoopOpts["historyVector"] | undefined;
  /** Desktop IndexHost sink: forward dirty paths to the writable UtilityProcess. */
  private indexDirtySink: ((batch: { files: string[]; directories: string[] }) => void) | null = null;

  setDangerousBashConfirmer(fn: ((command: string, sessionId?: string) => Promise<boolean>) | null): void {
    this.confirmDangerousBash = fn;
  }

  /** Wire a host-supplied ask-user bridge (main process → renderer UI → answer). */
  setAskUserHandler(fn: ((req: AskUserRequest, sessionId?: string) => Promise<string>) | null): void {
    this.askUserHandler = fn;
  }

  /**
   * Wire a host browser renderer (Electron BrowserWindow) so web_fetch can
   * obtain post-JS content for CSR pages. Unset → static HTML only.
   */
  setRenderPageHandler(fn: AgentLoopOpts["renderPage"] | null): void {
    this.renderPageHandler = fn;
  }

  setLlmApiKey(key: string | null): void {
    this.llmApiKey = key?.trim() || null;
  }

  /** 注入历史向量检索基础设施（sqlite-vec + embedding）。未注入时退化为原有行为。 */
  setHistoryVector(hv: AgentLoopOpts["historyVector"] | undefined): void {
    const previous = this.historyVector;
    this.historyVector = hv;
    if (previous && previous !== hv) {
      // Replacing the vector backend must release SQLite and native embedding
      // resources; otherwise every reconfiguration leaves an ONNX session alive.
      void previous.close?.();
    }
  }

  /** Forward filesystem dirty notifications to the desktop index UtilityProcess. */
  setIndexDirtySink(fn: ((batch: { files: string[]; directories: string[] }) => void) | null): void {
    this.indexDirtySink = fn;
  }

  /**
   * Point the session at a global memories directory. Creates a
   * `UserMemoryStore` backed by `<dir>/memories.json` and loads it.
   * Typically called once from the desktop main process at startup.
   */
  setMemoriesDir(dir: string): void {
    if (!dir) {
      this.memoryStore = null;
      return;
    }
    this.memoryStore = new UserMemoryStore(join(dir, "memories.json"));
    void this.memoryStore.load();
  }

  getMemoryStore(): UserMemoryStore | null {
    return this.memoryStore;
  }

  /**
   * Point the session at a project-scoped memories file inside the workspace.
   * Called from openWorkspace() after the workspace root is set.
   */
  setProjectMemoriesDir(workspaceRoot: string): void {
    const p = join(workspaceRoot, ".owncoder", "memories.json");
    this.projectMemoryStore = new UserMemoryStore(p);
    void this.projectMemoryStore.load();
  }

  getProjectMemoryStore(): UserMemoryStore | null {
    return this.projectMemoryStore;
  }

  private enqueueActivePlanUpdate<T>(update: () => Promise<T>, sessionId?: string): Promise<T> {
    const r = this.rt(sessionId);
    const run = r.activePlanUpdateQueue.then(update, update);
    // Keep the queue usable after a rejected update while returning the original
    // error to its caller, so task execution cannot silently continue on stale state.
    r.activePlanUpdateQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Build the combined memories block (global + project) for system prompt injection.
   */
  private buildMemoriesBlock(): string {
    const parts: string[] = [];
    const g = this.memoryStore?.formatForPrompt(1500, "User preferences (global)");
    if (g) parts.push(g);
    const p = this.projectMemoryStore?.formatForPrompt(1500, "User preferences (this project)");
    if (p) parts.push(p);
    return parts.join("\n\n");
  }

  async getGitStatus(): Promise<GitStatus> {
    const ws = this.state.workspace;
    if (!ws) {
      return {
        isRepo: false,
        branch: null,
        dirty: false,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        ahead: 0,
        behind: 0,
        summary: "未打开项目",
      };
    }
    return getGitStatus(ws.root);
  }

  listMcpTools(): Array<{ serverId: string; name: string; qualifiedName: string; description?: string }> {
    return this.mcp.listTools();
  }

  private syncMcp(): void {
    void this.mcp.sync(this.state.workflow.mcp?.servers ?? []);
  }


  getState(sessionId?: string): SessionState {
    const r = this.rtOpt(sessionId);
    return {
      mode: r?.mode ?? this.state.mode,
      workspace: this.state.workspace ? { ...this.state.workspace } : null,
      workflow: this.state.workflow,
      activePlanPath: r?.activePlanPath ?? null,
      lastPlanPath: r?.lastPlanPath ?? null,
      todoAnchor: r?.todoAnchor ?? null,
      lastCheckpointId: r?.lastCheckpointId ?? null,
      documentWorkflow: r?.documentWorkflow ?? null,
      sessionRestored: r?.sessionRestored ?? false,
      activeSessionId: this.state.activeSessionId,
      sessionTitle: r?.sessionTitle ?? null,
      queuedMessages: r?.queuedMessages ?? [],
      taskRunState: r?.taskRunState ?? null,
    };
  }

  getHistory(sessionId?: string): ChatTurn[] {
    const r = this.rtOpt(sessionId);
    return (r?.history ?? []).map((h) => ({ ...h }));
  }

  /** Load a UI history page from the durable conversation store. This path is
   * deliberately separate from runtime history so older pages never affect LLM context. */
  async loadHistoryPage(sessionId: string, beforeSeq?: number, limit = 10): Promise<{
    turns: ChatTurn[];
    beforeSeq: number | null;
    hasMore: boolean;
  }> {
    const root = this.sessionWorkspaceRoot(sessionId);

    // If the conversation store already has data, use it directly.
    const page = beforeSeq == null
      ? await loadRecentTurns(root, sessionId, limit)
      : await loadOlderTurns(root, sessionId, beforeSeq, limit);
    if (page.turns.length > 0) {
      return { turns: this.projectTurns(page.turns), beforeSeq: page.beforeSeq, hasMore: page.hasMore };
    }

    // First open: migrate from the durable session JSON (full transcript), not
    // the in-memory runtime tail. Runtime history is intentionally capped
    // (RECENT_LIMIT); seeding the conversation store from that tail would
    // permanently hide older turns (migrateLegacyHistory no-ops once any row
    // exists) and leave historyHasMore=false in the UI.
    const saved = await loadSessionById(root, sessionId);
    const diskHistory = Array.isArray(saved?.history) ? saved!.history : [];
    const runtimeHistory = this.runtimes.get(sessionId)?.history ?? [];
    const sourceHistory = diskHistory.length >= runtimeHistory.length ? diskHistory : runtimeHistory;
    if (sourceHistory.length > 0) {
      await migrateLegacyHistory(root, sessionId, sourceHistory);
      const migrated = beforeSeq == null
        ? await loadRecentTurns(root, sessionId, limit)
        : await loadOlderTurns(root, sessionId, beforeSeq, limit);
      return { turns: this.projectTurns(migrated.turns), beforeSeq: migrated.beforeSeq, hasMore: migrated.hasMore };
    }

    return { turns: [], beforeSeq: null, hasMore: false };
  }

  private projectTurns(turns: import("./conversation-store.ts").ConversationTurn[]): ChatTurn[] {
    // Shared with conversation-store so UI reload path and unit tests stay aligned.
    return projectConversationTurns(turns);
  }

  getTerminalLog(sessionId?: string): TerminalEntry[] {
    const r = this.rtOpt(sessionId);
    return (r?.terminalLog ?? []).slice(-200);
  }

  clearTerminalLog(sessionId?: string): void {
    const r = this.rtOpt(sessionId);
    if (r) {
      r.terminalLog = [];
      void this.persist(sessionId);
    }
  }

  clearHistory(sessionId?: string): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [clearHistory] called sid=${sessionId || this.state.activeSessionId}`, new Error().stack);
    const r = this.rtOpt(sessionId);
    if (r) {
      r.history = [];
      void this.persist(sessionId);
    }
  }

  setMode(mode: AgentMode, sessionId?: string): void {
    const r = this.rtOpt(sessionId);
    if (r) {
      r.mode = mode;
      void this.persist(sessionId);
    }
  }

  setWorkflow(workflow: SystemWorkflowConfig): void {
    this.state.workflow = workflow;
    this.index.setExtraIgnore?.(workflow.index.extraIgnore ?? []);

    this.syncMcp();
  }

  setTodoAnchor(todo: string | null, sessionId?: string): void {
    const r = this.rtOpt(sessionId);
    if (r) {
      r.todoAnchor = todo?.trim() || null;
      void this.persist(sessionId);
    }
  }

  /** Persist the session's queued (not yet executed) messages to the session file. */
  setQueuedMessages(messages: string[], sessionId?: string): void {
    const r = this.rtOpt(sessionId);
    if (!r) return;
    r.queuedMessages = Array.isArray(messages)
      ? messages.filter((m) => typeof m === "string" && m.length > 0)
      : [];
    void this.persist(sessionId);
  }

  /**
   * 轻量级切换工作区：只更新活跃工作区引用。
   * 不清空运行中/未完成会话的 runtime、队列或 abort；切回时复用内存状态。
   */
  async switchWorkspace(root: string, name: string): Promise<void> {
    this.stampRuntimeWorkspaces();
    // 保存当前焦点会话（使用旧的 workspace root）
    await this.persist();
    // 只清已完成会话；运行中/未完成的必须保留，切回时才能恢复流式/队列/计划。
    await this.cleanupAllSessions();

    // 更新工作区引用。不 abort、不关 SSE、不清队列。
    this.state.workspace = { root, name };
    this.state.activeSessionId = null;

    // 更新索引配置。轻量切换也必须把全局查询索引切到新项目，
    // 否则后续会话的 search_symbols 仍会命中上一个项目。
    this.index.setExtraIgnore?.(this.state.workflow.index.extraIgnore ?? []);
    if (this.state.workflow.index.enabled) {
      void this.index.open(root, undefined, { mode: "query" }).catch((error) => {
        console.warn(`[session] readonly index open failed:`, error);
      });
    }
    initLlmLogger(root);

    // 重新加载项目规则（轻量级操作）
    await this.reloadProjectRules();

    // 读取该工作区的活跃会话；已在内存中的 runtime 优先，避免覆盖运行中状态。
    const listed = await listSessionMetas(root);
    let id = listed.activeId ?? listed.sessions[0]?.id ?? null;
    if (!id) {
      const created = await createSessionFile(root, { mode: "agent", title: "新会话" });
      id = created.meta.id;
      this.applyLoadedSession(created.session);
      return;
    }
    const existing = this.runtimes.get(id);
    if (existing) {
      this.state.activeSessionId = id;
      this.state.mode = existing.mode;
      this.state.sessionTitle = existing.sessionTitle;
    } else {
      const saved = await loadSessionById(root, id);
      if (saved) {
        this.applyLoadedSession(saved);
      } else {
        const created = await createSessionFile(root, { mode: "agent", title: "新会话" });
        this.applyLoadedSession(created.session);
      }
    }
    const active = await readActiveMeta(root);
    const r = this.rtOpt();
    if (r) r.activePlanPath = active?.path ?? null;
  }

  async openWorkspace(root: string, name: string): Promise<void> {
    // CRITICAL: persist() prefers r.workspaceRoot, falling back to this.state.workspace.root.
    // It MUST run BEFORE we overwrite this.state.workspace with the new project,
    // otherwise the current session gets saved into the NEW project's directory
    // instead of its own. When the user later switches back, listSessionMetas()
    // can't find the session (it's in the wrong project) and creates a new empty
    // one — losing all history and running state.
    // Bug: A→B (B1 running) → A → B turned B1 into a new empty session.
    // Do NOT move this persist() call after the workspace assignment.
    this.stampRuntimeWorkspaces();
    await this.persist();

    // 只清已完成会话。运行中/未完成会话必须跨项目保留，切回时恢复。
    await this.cleanupAllSessions();

    this.state.workspace = { root, name };
    this.state.activeSessionId = null;
    this.index.setExtraIgnore?.(this.state.workflow.index.extraIgnore ?? []);
    // Initialize LLM log directory under the new workspace. Idempotent:
    // first call creates `.owncoder/logs/` and cleans 7-day-old files; later
    // calls just update the directory reference.
    initLlmLogger(root);

    // Chat must become usable before indexing. Main process opens the existing
    // SQLite readonly (if present); the desktop IndexHost UtilityProcess owns
    // writable scan/build and must not block this return path.
    if (this.state.workflow.index.enabled) {
      void this.index.open(root, undefined, { mode: "query" }).catch((error) => {
        console.warn(`[session] readonly index open failed:`, error);
      });
    }
    void this.index.ragLoad?.(root)?.catch(() => undefined);

    // Live incremental updates: watch the workspace and push file
    // add/change/delete straight into the index. Covers external edits.
    this.startFileWatcher(root);

    // Codemap is no longer built from the main process during startup. The
    // writable index worker owns repository scanning; an agent query must not
    // trigger a second full-workspace build in this process.

    this.setProjectMemoriesDir(root);
    const active = await readActiveMeta(root);
    const activePlanPath = active?.path ?? null;
    await this.reloadProjectRules();

    const listed = await listSessionMetas(root);
    let id = listed.activeId ?? listed.sessions[0]?.id ?? null;
    if (!id) {
      const created = await createSessionFile(root, { mode: "agent", title: "新会话" });
      id = created.meta.id;
      this.applyLoadedSession(created.session);
      return;
    }
    const existing = this.runtimes.get(id);
    if (existing) {
      this.state.activeSessionId = id;
      this.state.mode = existing.mode;
      this.state.sessionTitle = existing.sessionTitle;
      const r = this.rtOpt();
      if (r) r.activePlanPath = activePlanPath;
      return;
    }
    const saved = await loadSessionById(root, id);
    if (saved) {
      this.applyLoadedSession(saved);
    } else {
      const created = await createSessionFile(root, { mode: "agent", title: "新会话" });
      this.applyLoadedSession(created.session);
    }
    // Apply the workspace-level active plan path to the focus runtime.
    const r = this.rtOpt();
    if (r) r.activePlanPath = activePlanPath;
  }

  /**
   * Watch the workspace for file changes and push them into the index
   * incrementally. Covers files edited by external tools while the app is open.
   * Directories that are expensive or generated (matching the Rust `SKIP_DIRS`
   * set) are skipped so we never re-index `node_modules`, `.git`, etc.
   */
  private startFileWatcher(root: string): void {
    // Close any watcher / pending timers from a previous workspace.
    this.fileWatcher?.close();
    this.fileWatcher = null;
    for (const t of this.fileWatchTimers.values()) clearTimeout(t);
    this.fileWatchTimers.clear();
    if (!this.state.workflow.index.enabled) return;

    const skip = new Set([
      "node_modules",
      ".git",
      ".venv",
      "venv",
      "target",
      "dist",
      "build",
      ".next",
      ".owncoder",
      "__pycache__",
      "vendor",
      "out",
      "bin",
      "obj",
    ]);

    const shouldSkip = (absPath: string): boolean => {
      const rel = absPath.split(/[\\/]/);
      return rel.some((seg) => skip.has(seg));
    };

    const DEBOUNCE_MS = 300;
    try {
      const watcher = watch(
        root,
        { recursive: true },
        (_event, filename) => {
          if (!filename) return;
          const absPath = join(root, filename);
          if (shouldSkip(absPath)) return;
          // Debounce: collapse bursts of change events (e.g. editor
          // auto-save) for the same path into a single `invalidate`, which
          // re-parses the file (or drops it if deleted) without a full rescan.
          const existing = this.fileWatchTimers.get(absPath);
          if (existing) clearTimeout(existing);
          this.fileWatchTimers.set(
            absPath,
            setTimeout(() => {
              this.fileWatchTimers.delete(absPath);
              // Determine whether this is a directory delete. On Windows a
              // deleted non-empty directory may only report the directory
              // itself (not each file), so we strip the whole subtree to avoid
              // leaving stale entries in the symbol index.
              let isDirOrGone = false;
              try {
                isDirOrGone = statSync(absPath).isDirectory();
              } catch {
                isDirOrGone = true; // deleted: can't tell file vs dir → treat as dir
              }
              if (isDirOrGone) {
                this.index.invalidateDir?.(absPath);
                this.indexDirtySink?.({ files: [], directories: [absPath] });
              } else {
                this.index.invalidate?.(absPath);
                this.indexDirtySink?.({ files: [absPath], directories: [] });
              }
              // The desktop IndexHost receives this path through indexDirtySink.
              // Codemap updates are intentionally not built in the main process.
            }, DEBOUNCE_MS),
          );
        },
      );
      this.fileWatcher = watcher;
    } catch {
      // Recursive watch can fail on some platforms; live updates simply won't
      // run, but the open-time diff still keeps the index correct.
      this.fileWatcher = null;
    }
  }

  private applyLoadedSession(saved: {
    id?: string;
    title?: string;
    createdAt?: string;
    mode: AgentMode;
    history: ChatTurn[];
    terminalLog: TerminalEntry[];
    lastPlanPath: string | null;
    todoAnchor: string | null;
    lastCheckpointId: string | null;
    documentWorkflow?: DocumentWorkflowState | null;
    queuedMessages?: string[];
    taskRunState?: TaskRunState | null;
  }): void {
    const id = saved.id ?? null;
    if (!id) {
      console.error('[session] applyLoadedSession: 缺少会话ID');
      return;
    }
    
    let r = this.runtimes.get(id);
    const isNewRuntime = !r;
    
    if (!r) {
      r = createSessionRuntime(id, saved.mode);
      r.workspaceRoot = this.state.workspace?.root ?? null;
      this.runtimes.set(id, r);
    } else if (this.isSessionIncomplete(id)) {
      // 运行中/未完成：切回项目时绝不能用磁盘快照覆盖内存中的流式、队列、计划。
      this.state.activeSessionId = id;
      this.state.mode = r.mode;
      this.state.sessionTitle = r.sessionTitle;
      return;
    } else {
      // 如果运行时已存在且有内容，需要谨慎合并而不是直接覆盖
      if (r.history.length > 0 && saved.history.length === 0) {
        console.warn(`[session] 磁盘会话数据为空，保留内存中的历史 (${r.history.length} 条)`);
        // 保留内存中的数据，只更新其他字段
        r.mode = saved.mode;
        r.lastPlanPath = saved.lastPlanPath;
        r.todoAnchor = saved.todoAnchor;
        r.lastCheckpointId = saved.lastCheckpointId;
        r.documentWorkflow = saved.documentWorkflow ?? null;
        r.sessionTitle = saved.title ?? r.sessionTitle;
        r.sessionCreatedAt = saved.createdAt ?? r.sessionCreatedAt;
        // 不覆盖 history 和 terminalLog
        this.state.activeSessionId = id;
        this.state.mode = saved.mode;
        this.state.sessionTitle = r.sessionTitle;
        return;
      }
      
      // 如果内存和磁盘都有内容，比较数量，优先使用内容更多的
      if (r.history.length > saved.history.length) {
        console.warn(`[session] 内存历史更完整 (${r.history.length}条) > 磁盘历史 (${saved.history.length}条)，保留内存数据`);
        this.state.activeSessionId = id;
        this.state.mode = r.mode;
        this.state.sessionTitle = r.sessionTitle;
        return;
      }
    }
    if (r.workspaceRoot) this.sessionRoots.set(id, r.workspaceRoot);
    
    // 安全地应用磁盘数据
    try {
      // 迁移旧格式历史记录（阶段三架构）
      let fullHistory = Array.isArray(saved.history) ? saved.history : [];
      if (fullHistory.length > 0) {
        try {
          if (needsMigration(fullHistory)) {
            console.log(`[SessionOrchestrator] Migrating session ${r.id} to structured message format`);
            fullHistory = migrateHistory(fullHistory);
          }
        } catch (err) {
          console.warn(`[SessionOrchestrator] Migration failed, using original history:`, err);
        }
      }

      // Only keep the tail of history in the runtime to bound startup memory.
      // The full transcript lives in the conversation store for UI pagination.
      const RECENT_LIMIT = 20;
      const recentHistory = fullHistory.slice(-RECENT_LIMIT);
      r.history = recentHistory;
      r.terminalLog = Array.isArray(saved.terminalLog) ? saved.terminalLog.slice(-20) : [];
      r.mode = saved.mode || 'agent';
      r.lastPlanPath = saved.lastPlanPath;
      r.todoAnchor = saved.todoAnchor;
      r.lastCheckpointId = saved.lastCheckpointId;
      r.documentWorkflow = saved.documentWorkflow ?? null;
      r.queuedMessages = Array.isArray(saved.queuedMessages)
        ? saved.queuedMessages.filter((m) => typeof m === "string" && m.length > 0)
        : [];
      r.taskRunState = restoreTaskRunState(saved.taskRunState, id) ?? null;
      r.sessionTitle = saved.title ?? null;
      r.sessionCreatedAt = saved.createdAt ?? null;
      r.sessionRestored = fullHistory.length > 0 || (saved.terminalLog?.length ?? 0) > 0;

      // Migrate the full legacy history to the conversation store in the
      // background so the UI can paginate older turns without keeping them
      // in the runtime. fire-and-forget, errors are non-fatal.
      if (fullHistory.length > RECENT_LIMIT && r.workspaceRoot) {
        const root = r.workspaceRoot;
        void migrateLegacyHistory(root, id, fullHistory).catch((err) => {
          console.warn(`[session] background conversation migration failed for ${id}:`, err);
        });
      }

      console.log(`[session] ${isNewRuntime ? '创建新运行时' : '更新现有运行时'}: ${id}, 历史: ${r.history.length}/${fullHistory.length}条, 终端: ${r.terminalLog.length}条`);
    } catch (error) {
      console.error(`[session] 应用会话数据失败: ${id}`, error);
      // 如果应用失败，至少确保运行时处于可用状态
      if (isNewRuntime) {
        r.history = [];
        r.terminalLog = [];
        r.mode = 'agent';
        r.sessionTitle = '恢复失败的会话';
      }
    }
    
    // Make this the focus session.
    this.state.activeSessionId = id;
    this.state.mode = r.mode;
    this.state.sessionTitle = r.sessionTitle;
  }

  async listChatSessions(): Promise<{ activeId: string | null; sessions: SessionMeta[] }> {
    const ws = this.state.workspace;
    if (!ws) return { activeId: null, sessions: [] };
    return listSessionMetas(ws.root);
  }

  async createChatSession(title?: string): Promise<SessionMeta> {
    const ws = this.state.workspace;
    if (!ws) throw new Error(ERR_NO_WORKSPACE);
    // Persist the current focus session (if any) without aborting it.
    const previousId = this.state.activeSessionId;
    if (previousId) {
      await this.persist(previousId);
      const previousRuntime = this.runtimes.get(previousId);
      if (previousRuntime) {
        await previousRuntime.persistQueue;
      }
    }
    const focusMode = this.rtOpt()?.mode ?? "agent";
    const created = await createSessionFile(ws.root, {
      title: title || "新会话",
      mode: focusMode === "plan" ? "plan" : "agent",
    });
    this.applyLoadedSession(created.session);
    const r = this.rtOpt();
    if (r) r.sessionRestored = false;
    // Bound multi-session heap: drop the previous idle runtime after the new
    // session becomes focus. Running/queued sessions are kept by unloadIdleRuntime.
    if (previousId) this.unloadIdleRuntime(previousId);
    return created.meta;
  }

  /**
   * Drop an idle session runtime from memory after it has been persisted.
   * Running / queued sessions stay resident so background turns keep working.
   * This bounds multi-session heap growth: switching focus no longer retains
   * every previously opened session's history/terminal forever.
   */
  private async unloadIdleRuntime(sessionId: string): Promise<void> {
    if (!sessionId) return;
    if (this.coordinator.isActive(sessionId) || this.coordinator.getPendingCount(sessionId) > 0) {
      return;
    }
    const r = this.runtimes.get(sessionId);
    if (!r || r.abort) return;
    await this.coordinator.cleanup(sessionId);
    this.runtimes.delete(sessionId);
  }

  async switchChatSession(id: string): Promise<SessionState> {
    const ws = this.state.workspace;
    if (!ws) throw new Error(ERR_NO_WORKSPACE);
    // Persist the current focus session (if any) without aborting it.
    const previousId =
      this.state.activeSessionId && this.state.activeSessionId !== id
        ? this.state.activeSessionId
        : null;
    if (previousId) {
      // 关键修复：等待持久化完成，确保当前会话状态被正确保存
      await this.persist(previousId);
      // 额外等待持久化队列完全清空，防止竞态条件
      const currentRuntime = this.runtimes.get(previousId);
      if (currentRuntime) {
        await currentRuntime.persistQueue;
      }
    }
    // If the target runtime is already loaded (e.g. running in background),
    // just switch focus to it — do not overwrite its in-memory state.
    const existing = this.runtimes.get(id);
    if (existing) {
      this.state.activeSessionId = id;
      this.state.mode = existing.mode;
      this.state.sessionTitle = existing.sessionTitle;
      await setActiveSessionId(ws.root, id);
      // Drop the previous idle runtime after focus has moved. Keeps background
      // turns alive (unloadIdleRuntime no-ops when active/queued/aborting).
      if (previousId) this.unloadIdleRuntime(previousId);
      return this.getState(id);
    }
    // Otherwise load from disk into a new runtime and make it the focus.
    // 防护措施：如果会话文件不存在或损坏，不要覆盖内存中的运行状态
    let saved: PersistedSession | null = null;
    try {
      saved = await loadSessionById(ws.root, id);
    } catch (error) {
      console.error(`[session] 加载会话 ${id} 失败:`, error);
      // 如果加载失败，检查内存中是否有运行状态
      const memoryRuntime = this.runtimes.get(id);
      if (memoryRuntime && memoryRuntime.history.length > 0) {
        console.warn(`[session] 使用内存中的会话状态代替损坏的磁盘文件: ${id}`);
        this.state.activeSessionId = id;
        this.state.mode = memoryRuntime.mode;
        this.state.sessionTitle = memoryRuntime.sessionTitle;
        await setActiveSessionId(ws.root, id);
        // 尝试重新保存以修复损坏的文件
        try {
          await this.persist(id);
        } catch (persistError) {
          console.error(`[session] 重新保存会话 ${id} 失败:`, persistError);
        }
        if (previousId) this.unloadIdleRuntime(previousId);
        return this.getState(id);
      }
      throw new Error(`找不到会话：${id}，且内存中无可用状态`);
    }
    
    if (!saved) {
      // 会话文件不存在，检查内存状态
      const memoryRuntime = this.runtimes.get(id);
      if (memoryRuntime && memoryRuntime.history.length > 0) {
        console.warn(`[session] 会话文件不存在，使用内存状态: ${id}`);
        this.state.activeSessionId = id;
        this.state.mode = memoryRuntime.mode;
        this.state.sessionTitle = memoryRuntime.sessionTitle;
        await setActiveSessionId(ws.root, id);
        // 创建缺失的会话文件
        try {
          await this.persist(id);
        } catch (persistError) {
          console.error(`[session] 创建会话文件 ${id} 失败:`, persistError);
        }
        if (previousId) this.unloadIdleRuntime(previousId);
        return this.getState(id);
      }
      throw new Error(`找不到会话：${id}`);
    }
    
    // 验证加载的会话数据完整性
    if (!this.validateSessionData(saved)) {
      console.error(`[session] 会话数据验证失败: ${id}`, saved);
      // 如果内存中有更好的状态，使用内存状态
      const memoryRuntime = this.runtimes.get(id);
      if (memoryRuntime && memoryRuntime.history.length > 0) {
        console.warn(`[session] 使用内存状态代替无效的磁盘数据: ${id}`);
        this.state.activeSessionId = id;
        this.state.mode = memoryRuntime.mode;
        this.state.sessionTitle = memoryRuntime.sessionTitle;
        await setActiveSessionId(ws.root, id);
        if (previousId) this.unloadIdleRuntime(previousId);
        return this.getState(id);
      }
    }
    
    await setActiveSessionId(ws.root, id);
    this.applyLoadedSession(saved);
    if (previousId) this.unloadIdleRuntime(previousId);
    return this.getState(id);
  }

  async deleteChatSession(id: string, projectRoot?: string): Promise<{ activeId: string | null }> {
    const ws = this.state.workspace;
    if (!ws) throw new Error(ERR_NO_WORKSPACE);
    // When deleting from a non-current project, just remove the file and return.
    // No runtime or active-session bookkeeping needed.
    if (projectRoot && projectRoot !== ws.root) {
      await deleteSessionFile(projectRoot, id);
      return { activeId: null };
    }
    // Cancel any in-flight turn for the deleted session before removing it.
    const r = this.runtimes.get(id);
    if (r?.abort) {
      r.abort.abort();
      r.abort = null;
    }
    await this.coordinator.cleanup(id);
    const nextId = await deleteSessionFile(ws.root, id);
    this.runtimes.delete(id);
    this.sessionRoots.delete(id);
    if (this.state.activeSessionId === id) {
      if (nextId) {
        // Switch focus to the next session; prefer an already-loaded runtime,
        // otherwise load from disk.
        const existing = this.runtimes.get(nextId);
        if (existing) {
          this.state.activeSessionId = nextId;
          this.state.mode = existing.mode;
          this.state.sessionTitle = existing.sessionTitle;
        } else {
          const saved = await loadSessionById(ws.root, nextId);
          if (saved) this.applyLoadedSession(saved);
        }
      } else {
        // Deleting the last remaining session: do NOT auto-create a replacement.
        // Honour the user's intent — the session list ends up empty, and a new
        // session is only created when the user explicitly clicks "新建对话".
        this.state.activeSessionId = null;
        this.state.sessionTitle = "";
      }
    }
    return { activeId: this.state.activeSessionId };
  }

  async toggleChatSessionPin(id: string): Promise<SessionMeta[]> {
    const ws = this.state.workspace;
    if (!ws) throw new Error(ERR_NO_WORKSPACE);
    return toggleSessionPin(ws.root, id);
  }

  /** Remove the last assistant reply (and tool steps) and resend the preceding user message. */
  async regenerateLastReply(onEvent?: (ev: TurnEvent) => void, sessionId?: string): Promise<AgentLoopResult> {
    const r = this.rt(sessionId);
    let lastUserIdx = -1;
    for (let i = r.history.length - 1; i >= 0; i--) {
      if (r.history[i]?.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) {
      throw new Error("没有可重新生成的用户消息");
    }
    const userText = r.history[lastUserIdx]!.content.trim();
    if (!userText) {
      throw new Error("上一条用户消息为空");
    }
    r.history = r.history.slice(0, lastUserIdx);
    await this.persist(sessionId);
    return this.sendMessage(userText, onEvent, sessionId);
  }

  /** Flush current chat session to `.owncoder/sessions/{id}.json`. */
  async persist(sessionId?: string): Promise<void> {
    const sid = sessionId ?? this.state.activeSessionId;
    if (!sid) return;
    const r = this.runtimes.get(sid);
    if (!r) return;
    const persistRoot = r.workspaceRoot ?? this.state.workspace?.root;
    if (!persistRoot) return;
    const run = async () => {
      try {
        const meta = await saveSessionById(persistRoot, sid, {
          mode: r.mode,
          history: r.history,
          terminalLog: r.terminalLog.slice(-80),
          lastPlanPath: r.lastPlanPath,
          todoAnchor: r.todoAnchor,
          lastCheckpointId: r.lastCheckpointId,
          documentWorkflow: r.documentWorkflow,
          queuedMessages: r.queuedMessages,
          taskRunState: r.taskRunState,
          createdAt: r.sessionCreatedAt ?? undefined,
        });
        r.sessionTitle = meta.title;
        if (sid === this.state.activeSessionId) {
          this.state.sessionTitle = meta.title;
        }
        console.log(`[session] 成功保存会话: ${sid}, 历史条目: ${r.history.length}`);
      } catch (error) {
        console.error(`[session] 保存会话 ${sid} 失败:`, error);
        // 保存失败不应该阻塞后续操作，但需要记录错误
        throw error;
      }
    };
    r.persistQueue = r.persistQueue.then(run, run);
    return r.persistQueue;
  }

  /**
   * 验证会话数据的完整性
   */
  private validateSessionData(session: PersistedSession): boolean {
    try {
      // 基本结构验证
      if (!session || typeof session !== 'object') {
        console.warn('[session] 会话数据不是有效对象');
        return false;
      }
      
      // 版本验证
      if (session.version !== 1) {
        console.warn(`[session] 不支持的会话版本: ${session.version}`);
        return false;
      }
      
      // 历史数据验证
      if (!Array.isArray(session.history)) {
        console.warn('[session] 会话历史不是数组');
        return false;
      }
      
      // 验证历史条目结构
      for (let i = 0; i < session.history.length; i++) {
        const turn = session.history[i];
        if (!turn || typeof turn !== 'object') {
          console.warn(`[session] 历史条目 ${i} 结构无效`);
          return false;
        }
        if (!turn.role || !['user', 'assistant', 'tool', 'system'].includes(turn.role)) {
          console.warn(`[session] 历史条目 ${i} 角色无效: ${turn.role}`);
          return false;
        }
      }
      
      // 终端日志验证
      if (session.terminalLog && !Array.isArray(session.terminalLog)) {
        console.warn('[session] 终端日志不是数组');
        return false;
      }
      
      // 模式验证
      if (session.mode && !['agent', 'spec'].includes(session.mode)) {
        console.warn(`[session] 未知的会话模式: ${session.mode}`);
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('[session] 验证会话数据时发生错误:', error);
      return false;
    }
  }

  /** 等待所有 session 的持久化队列完成，用于应用退出前 flush，防止 pending persist 丢失。 */
  async drainPersists(): Promise<void> {
    const queues: Promise<void>[] = [];
    for (const r of this.runtimes.values()) {
      queues.push(r.persistQueue);
    }
    await Promise.all(queues);
  }

  async wipePersistedSession(sessionId?: string): Promise<void> {
    const sid = sessionId ?? this.state.activeSessionId;
    if (!sid) return;
    const root = this.sessionWorkspaceRoot(sid);
    const r = this.rtOpt(sessionId);
    if (r) {
      r.history = [];
      r.terminalLog = [];
      r.lastPlanPath = null;
      r.todoAnchor = null;
      r.lastCheckpointId = null;
      r.documentWorkflow = null;
      r.sessionRestored = false;
      r.sessionTitle = "新会话";
    }
    await clearPersistedSession(root);
  }

  async reloadProjectRules(): Promise<string> {
    const ws = this.state.workspace;
    if (!ws) {
      this.projectRules = "";
      return "";
    }
    this.projectRules = await loadCombinedRules(ws.root);
    return this.projectRules;
  }

  getProjectRulesText(): string {
    return this.projectRules;
  }

  async listRules(): Promise<RuleFileInfo[]> {
    const ws = this.state.workspace;
    if (!ws) return [];
    return listRules(ws.root);
  }

  async readRule(name: string): Promise<string> {
    const ws = this.state.workspace;
    if (!ws) throw new Error(ERR_NO_WORKSPACE);
    return readRule(ws.root, name);
  }

  async writeRule(name: string, content: string): Promise<RuleFileInfo> {
    const ws = this.state.workspace;
    if (!ws) throw new Error(ERR_NO_WORKSPACE);
    const info = await writeRule(ws.root, name, content);
    await this.reloadProjectRules();
    return info;
  }

  async deleteRule(name: string): Promise<void> {
    const ws = this.state.workspace;
    if (!ws) throw new Error(ERR_NO_WORKSPACE);
    await deleteRule(ws.root, name);
    await this.reloadProjectRules();
  }

  getIndex(): IndexClient {
    return this.index;
  }

  /**
   * List plan files. Plans are scoped to the chat session that saved them:
   * when `sessionId` is given only that session's plans are returned, so a
   * freshly created session no longer surfaces plans from older sessions.
   * Omitting `sessionId` (legacy callers) returns the unfiltered list.
   */
  async listPlans(sessionId?: string): Promise<PlanInfo[]> {
    const root = sessionId ? this.sessionWorkspaceRoot(sessionId) : this.state.workspace?.root;
    if (!root) return [];
    const plans = await listPlans(root);
    if (!sessionId) return plans;
    return plans.filter((p) => p.sessionId === sessionId);
  }

  async readPlan(relPath: string): Promise<string> {
    const ws = this.state.workspace;
    if (!ws) throw new Error(ERR_NO_WORKSPACE);
    return readPlanFile(ws.root, relPath);
  }

  async getActivePlan(sessionId?: string): Promise<ActivePlanMeta | null> {
    const sid = sessionId ?? this.state.activeSessionId;
    const root = sid ? this.sessionWorkspaceRoot(sid) : this.state.workspace?.root;
    if (!root) return null;
    return readActiveMeta(root, sid ?? undefined);
  }

  async updateTask(taskId: string, status: TaskStatus, result?: string, sessionId?: string): Promise<ActivePlanMeta | null> {
    const sid = sessionId ?? this.state.activeSessionId;
    const root = sid ? this.sessionWorkspaceRoot(sid) : this.state.workspace?.root;
    if (!root) throw new Error(ERR_NO_WORKSPACE);
    return this.enqueueActivePlanUpdate(async () => {
      const meta = await readActiveMeta(root, sid ?? undefined);
      if (!meta) throw new Error("没有活动计划");
      const t = meta.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`找不到任务 ${taskId}`);
      t.status = status;
      if (result !== undefined) t.result = result.slice(0, 400);
      if (status === "in_progress") meta.currentTaskId = taskId;
      if (meta.currentTaskId === null || meta.currentTaskId === taskId) {
        const next = selectNextPendingTask(meta.tasks);
        meta.currentTaskId = status === "completed" || status === "failed" || status === "skipped"
          ? (next?.id ?? null)
          : meta.currentTaskId;
      }
      await writeActiveMeta(root, meta, sid ?? undefined);
      return meta;
    }, sessionId);
  }

  async listCheckpoints(): Promise<
    Array<{ id: string; createdAt: string; touched: string[]; historyLen: number }>
  > {
    const ws = this.state.workspace;
    if (!ws) return [];
    return listCheckpoints(ws.root);
  }

  async getPendingChanges(sessionId?: string): Promise<{
    checkpointId: string | null;
    files: ChangeFile[];
    /** True when this session had a checkpoint but it is gone from disk. */
    expired?: boolean;
  }> {
    const root = sessionId ? this.sessionWorkspaceRoot(sessionId) : this.state.workspace?.root;
    const r = this.rtOpt(sessionId);
    if (!root || !r || !r.lastCheckpointId) {
      return { checkpointId: null, files: [] };
    }
    const cp = await loadCheckpoint(root, r.lastCheckpointId);
    if (!cp) {
      // The checkpoint this session pointed at is no longer on disk (pruned, or
      // deleted externally). Say so instead of reporting "no pending changes",
      // which reads as "nothing to undo" and silently drops undo capability.
      console.log(
        `[checkpoint] session checkpoint ${r.lastCheckpointId} is missing; undo unavailable`,
      );
      r.lastCheckpointId = null;
      return { checkpointId: null, files: [], expired: true };
    }
    const files = (await buildChangesFromCheckpoint(root, cp)).filter(
      (f) => !r.keptPaths.has(f.path),
    );
    return { checkpointId: cp.id, files };
  }

  /** Accept all pending file changes (keep on disk). */
  async keepAllChanges(sessionId?: string): Promise<void> {
    const r = this.rtOpt(sessionId);
    if (r) {
      r.keptPaths.clear();
      r.lastCheckpointId = null;
      await this.persist(sessionId);
    }
  }

  async keepChange(path: string, sessionId?: string): Promise<void> {
    const r = this.rtOpt(sessionId);
    if (!r) return;
    r.keptPaths.add(path);
    const pending = await this.getPendingChanges(sessionId);
    if (pending.files.length === 0) {
      r.keptPaths.clear();
      r.lastCheckpointId = null;
      await this.persist(sessionId);
    }
  }

  async undoChange(path: string, sessionId?: string): Promise<void> {
    const root = sessionId ? this.sessionWorkspaceRoot(sessionId) : this.state.workspace?.root;
    const r = this.rtOpt(sessionId);
    if (!root || !r || !r.lastCheckpointId) throw new Error("没有可撤销的变更");
    const cp = await loadCheckpoint(root, r.lastCheckpointId);
    if (!cp) throw new Error("找不到检查点");
    const snap = cp.files.find((f) => f.path === path);
    if (!snap) throw new Error(`检查点中无文件：${path}`);
    await restoreSingleFile(root, snap);
    this.index.invalidate(path);
    r.keptPaths.add(path);
    const pending = await this.getPendingChanges(sessionId);
    if (pending.files.length === 0) {
      r.keptPaths.clear();
      r.lastCheckpointId = null;
    }
    await this.persist(sessionId);
  }

  /**
   * Roll back the latest (or given) turn checkpoint: restore files, history, invalidate index.
   *
   * `.owncoder/checkpoints/` is workspace-global, so target selection must be
   * session-aware: previously this picked the newest checkpoint on disk ahead of
   * the current session's own, which could restore another session's files and
   * overwrite this conversation with that session's history.
   */
  async rollbackCheckpoint(id?: string, sessionId?: string): Promise<{
    restored: string[];
    checkpointId: string;
  }> {
    const r = this.rt(sessionId);
    const root = this.sessionWorkspaceRoot(r.id);
    const activeSessionId = r.id;
    let targetId = id ?? r.lastCheckpointId ?? null;
    if (!targetId) {
      // Fall back to the newest checkpoint that belongs to this session.
      const list = await listCheckpoints(root);
      targetId =
        list.find((c) => c.sessionId && c.sessionId === activeSessionId)?.id ??
        // No owned candidate: only consider legacy checkpoints of unknown origin.
        list.find((c) => !c.sessionId)?.id ??
        null;
    }
    if (!targetId) throw new Error("没有可回滚的检查点");
    const cp = await loadCheckpoint(root, targetId);
    if (!cp) throw new Error(`找不到检查点：${targetId}`);

    const owner = cp.sessionId ?? null;
    if (owner && activeSessionId && owner !== activeSessionId) {
      throw new Error(
        `检查点 ${cp.id} 属于另一个会话，拒绝回滚（避免覆盖当前会话的文件与对话历史）。`,
      );
    }

    const restored = await restoreCheckpointFiles(root, cp);
    for (const p of restored) {
      this.index.invalidate(p);
    }
    // Only adopt the checkpoint's conversation when we can prove it is ours.
    // Legacy checkpoints carry no sessionId; restoring their files is fine, but
    // replacing the live history with a foreign one is unrecoverable.
    if (owner && activeSessionId && owner === activeSessionId) {
      r.history = (cp.history as ChatTurn[]).map((h) => ({ ...h }));
    }
    r.lastCheckpointId = null;
    r.keptPaths.clear();
    r.history.push({
      role: "assistant",
      content: `已回滚检查点 ${cp.id}（${restored.length} 个文件）。`,
    });
    await this.persist(sessionId);
    return { restored, checkpointId: cp.id };
  }

  async approvePlan(opts?: {
    path?: string;
    content?: string;
    title?: string;
    tasks?: TaskItem[];
  }, sessionId?: string): Promise<SessionState> {
    const r = this.rt(sessionId);
    const root = this.sessionWorkspaceRoot(r.id);

    let path = opts?.path?.trim();
    if (path) {
      if (!isPlanPath(path)) {
        throw new Error("批准路径必须在 .owncoder/plans/ 下");
      }
    } else if (opts?.content?.trim()) {
      path = await writePlanFile(root, opts.content, { title: opts.title, sessionId: r.id });
    } else if (r.lastPlanPath) {
      path = r.lastPlanPath;
    } else {
      const lastAssistant = [...r.history]
        .reverse()
        .find((h) => h.role === "assistant" && h.content.trim().length > 40);
      if (!lastAssistant) {
        throw new Error("没有可批准的计划 - 请先 save_plan 或传入内容");
      }
      path = await writePlanFile(root, lastAssistant.content, {
        title: opts?.title ?? "已批准的计划",
        sessionId: r.id,
      });
    }

    // 防重复批准：该计划已是活动计划则拒绝，闭环状态机
    if (r.activePlanPath === path) {
      throw new Error("该计划已批准并切换到 Agent 模式，无需重复操作");
    }

    const body = await readPlanFile(root, path);
    const tasks = normalizeTasks(opts?.tasks && opts.tasks.length > 0 ? opts.tasks : parseTasksFromMarkdown(body));
    const firstPending = selectNextPendingTask(tasks);
    const meta: ActivePlanMeta = {
      path,
      approvedAt: new Date().toISOString(),
      title: extractTitle(body, path),
      tasks,
      currentTaskId: firstPending?.id ?? null,
      status: "approved",
      sessionId: r.id,
    };
    await writeActiveMeta(root, meta, r.id);

    // 清除 checkpoint 引用：Plan 模式生成的文档文件（PRD/TDD 等）以 existed=false
    // 记录在 checkpoint 中，若不清除，后续 rollback 会因 existed=false 将其删除。
    // 批准即视为用户确认所有生成产物，无需保留回滚能力。
    r.keptPaths.clear();
    r.lastCheckpointId = null;

    r.activePlanPath = path;
    r.lastPlanPath = path;
    r.mode = "agent";
    r.todoAnchor = null;
    if (r.id === this.state.activeSessionId) {
      this.state.mode = "agent";
    }

    r.history.push({
      role: "assistant",
      content: `✅ 计划已批准 → 已切换到 Agent 模式。\n\n📋 **活动计划**：${path}\n📊 **任务总数**：${tasks.length}\n\n💡 **下一步**：在下方输入框发送消息（如"开始执行"）即可触发 Agent 按顺序执行任务。`,
    });

    await this.persist(sessionId);
    return this.getState(sessionId);
  }

  async clearActivePlan(sessionId?: string): Promise<SessionState> {
    const sid = sessionId ?? this.state.activeSessionId;
    const root = sid ? this.sessionWorkspaceRoot(sid) : this.state.workspace?.root;
    if (root && sid) {
      // 删除 session-scoped 的活动计划文件
      const activePath = resolve(root, ACTIVE_DIR, `${sid}.json`);
      await fs.unlink(activePath).catch(() => undefined);
    }
    const r = this.rtOpt(sessionId);
    if (r) r.activePlanPath = null;
    await this.persist(sessionId);
    return this.getState(sessionId);
  }

  cancelTurn(sessionId?: string): void {
    // 走协调器的中断路径（与 cancelAllTurns 一致）：即使 `r.abort` 还没被
    // executeAgentTurn 写入，或已经被上一轮清空，只要协调器的 drain loop
    // 还在跑或还有 pending input，就能可靠地把 AbortController 触发、拒绝
    // 队列里等待的输入并等待当前 fiber 完成。仅 abort `r.abort` 在以下时机
    // 会失效：admit 后 drain 还没取到这个 input 的窗口；上一轮结束后、下一轮
    // executeAgentTurn 写入新 controller 之前的间隙。这两个窗口里 `r.abort`
    // 为 null，旧 controller 也不再被任何运行中的 turn 引用。
    const sid = sessionId ?? this.state.activeSessionId;
    if (!sid) return;
    void this.coordinator.interrupt(sid);
    const r = this.rtOpt(sid);
    if (r) {
      // 双保险：executeAgentTurn 把 coordinator 的 controller 也镜像到了 r.abort，
      // 如果它指向的 controller 跟 coordinator 当前的不是同一个（旧引用），再补一刀。
      if (r.abort && !r.abort.signal.aborted) r.abort.abort();
      r.abort = null;
    }
  }

  /**
   * Abort every in-flight turn across all sessions. Called when the renderer
   * is gone (window closed / renderer crashed or reloaded) so streaming LLM
   * responses stop producing events that nobody can receive.
   */
  cancelAllTurns(): void {
    for (const [sid, r] of this.runtimes.entries()) {
      // 通过协调器中断（会同时处理 abort 和清理）
      void this.coordinator.interrupt(sid);
      // 兼容性：也清理 runtime 的 abort 引用
      r.abort = null;
    }
  }

  /**
   * Drop completed/idle session runtimes only.
   * Running or unfinished sessions (in-flight turn, abort controller, queued
   * messages, coordinator pending) stay resident so a project switch cannot
   * stop them. Window-close / renderer-crash still call cancelAllTurns first.
   */
  async cleanupAllSessions(): Promise<void> {
    for (const sid of Array.from(this.runtimes.keys())) {
      if (this.isSessionIncomplete(sid)) continue;
      await this.coordinator.cleanup(sid);
      this.runtimes.delete(sid);
    }
  }

  /**
   * 获取协调器统计信息（用于调试和监控）
   */
  getCoordinatorStats() {
    return this.coordinator.getStats();
  }

  /**
   * 检查会话是否正在执行
   */
  isSessionActive(sessionId: string): boolean {
    return this.coordinator.isActive(sessionId);
  }

  /**
   * Preserve the visible/persisted transcript. Long-history compaction now runs
   * as an LLM-generated context summary immediately before a model request.
   */
  compactNow(sessionId?: string): ChatTurn[] {
    const r = this.rtOpt(sessionId);
    const history = r?.history ?? [];
    const budget = 120 * 1024;
    const recentWindow = 20;
    const size = (turn: ChatTurn) => turn.content.length * 2;
    let total = history.reduce((n, turn) => n + size(turn), 0);
    if (total <= budget || history.length <= recentWindow) return this.getHistory(sessionId);
    const keepFrom = Math.max(0, history.length - recentWindow);
    const old = history.slice(0, keepFrom);
    const summary = old.map((turn) => `${turn.role}: ${turn.content.slice(0, 240)}`).join("\n").slice(0, 16 * 1024);
    const compacted: ChatTurn = {
      role: "system",
      content: `[历史摘要，共 ${old.length} 条，原始内容已压缩]\n${summary}`,
      metadata: { isCompressed: true, originalLength: old.length, compressedAt: new Date().toISOString(), compressionReason: "manual" },
    };
    const next = [compacted, ...history.slice(keepFrom)];
    while (total > budget && next.length > recentWindow + 1) {
      next.splice(1, 1);
      total = next.reduce((n, turn) => n + size(turn), 0);
    }
    r!.history = next;
    if (r!.taskRunState) {
      r!.taskRunState = applyTaskEvent(r!.taskRunState, {
        type: "observability",
        taskId: r!.taskRunState.taskId,
        contextCompressions: 1,
      });
    }
    void this.persist(sessionId);
    return next.map((turn) => ({ ...turn }));
  }

  async sendMessage(
    text: string,
    onEvent?: (ev: TurnEvent) => void,
    sessionId?: string,
  ): Promise<AgentLoopResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("消息不能为空");
    }
    
    const sid = sessionId ?? this.state.activeSessionId;
    if (!sid) {
      throw new Error("没有活跃会话");
    }

    console.log(`[SessionOrchestrator] sendMessage via coordinator:`, {
      sessionId: sid,
      textLength: trimmed.length,
      coordinatorActive: this.coordinator.isActive(sid),
      pendingCount: this.coordinator.getPendingCount(sid),
    });

    // 用户消息必须先进入 conversation store（beginTurn），再写入 session JSON。
    // 若先 persist 再 beginTurn，并发的 getChatHistoryPage 会在 store 仍为空时
    // 把「仅有新 user、尚无 turn 行」的磁盘历史 migrate 成一条已完成 legacy turn，
    // 随后 beginTurn 再插入同一条 user → 切回会话加载时出现两条用户消息。
    const r = this.rt(sid);
    const workspaceRoot = this.sessionWorkspaceRoot(sid);
    // Seed the conversation store from the longest known transcript before
    // admitting this turn. Prefer disk over the runtime tail so a truncated
    // in-memory history cannot lock the store into an incomplete migration.
    // migrate 必须使用「追加本轮 user 之前」的历史，避免把 in-flight user 写成 legacy。
    const savedForMigrate = await loadSessionById(workspaceRoot, sid);
    const diskHistory = Array.isArray(savedForMigrate?.history) ? savedForMigrate.history : [];
    const migrateSource = diskHistory.length >= r.history.length ? diskHistory : r.history;
    await migrateLegacyHistory(workspaceRoot, sid, migrateSource);

    // Generate the durable turn id and claim the conversation-store row first.
    const turnId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await beginTurn(workspaceRoot, sid, { role: "user", content: trimmed }, turnId);

    // beginTurn 成功后再写入 runtime + session JSON，保证并发 loadHistoryPage
    // 看到 store 已有行时会跳过 migrate，不会再复制一条 user。
    r.history = [...r.history, { role: "user" as const, content: trimmed }];
    await this.persist(sid);

    // 通过协调器提交输入，传递 onEvent 上下文
    // 协调器会自动处理队列、串行化和 drain loop
    return await this.coordinator.admit(sid, trimmed, { turnId, onEvent });
  }

  /**
   * 执行一个代理轮次（由协调器调用）
   * 这是实际的执行逻辑，从 sendMessage 中提取出来
   */
  private async executeAgentTurn(
    sessionId: string,
    text: string,
    turnId: string,
    onEvent?: (ev: TurnEvent) => void,
  ): Promise<AgentLoopResult> {
    const r = this.rt(sessionId);
    const ws = this.sessionWorkspace(sessionId);
    const trimmed = text.trim();
    
    // 使用协调器的 AbortController 而不是自己创建
    const abortController = this.coordinator.getAbortController(sessionId);
    if (!abortController) {
      throw new Error(`No abort controller for session ${sessionId}`);
    }
    
    // 兼容：也更新 runtime 的 abort 引用（供其他代码使用）
    r.abort = abortController;

    // 创建 MessageProjector 用于构建结构化消息
    const { MessageProjector } = await import("./message-projector");
    const projector = new MessageProjector();

    // Capture workspace root for persist. openWorkspace() may switch the active
    // workspace and clear runtimes while sendMessage is still running. Using
    // this.state.workspace / this.runtimes for the final persist would then save
    // to the wrong project or silently skip (map entry removed). The captured
    // root + direct reference to `r` survive the workspace switch.
    const capturedRoot = ws.root;
    const directPersist = (): Promise<void> => {
      const run = async () => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [persist] sid=${r.id} historyLen=${r.history.length} terminalLogLen=${r.terminalLog.length}`);
        const meta = await saveSessionById(capturedRoot, r.id, {
          mode: r.mode,
          history: r.history,
          terminalLog: r.terminalLog.slice(-80),
          lastPlanPath: r.lastPlanPath,
          todoAnchor: r.todoAnchor,
          lastCheckpointId: r.lastCheckpointId,
          documentWorkflow: r.documentWorkflow,
          queuedMessages: r.queuedMessages,
          taskRunState: r.taskRunState,
          createdAt: r.sessionCreatedAt ?? undefined,
        });
        r.sessionTitle = meta.title;
      };
      r.persistQueue = r.persistQueue.then(run, run);
      return r.persistQueue;
    };

    let activePlan: { path: string; content: string } | null = null;
    let activeTasks: TaskItem[] | undefined;
    let currentTaskId: string | null | undefined;
    if (r.mode === "agent" && r.activePlanPath) {
      try {
        const content = await readPlanFile(ws.root, r.activePlanPath);
        activePlan = { path: r.activePlanPath, content };
        const meta = await readActiveMeta(ws.root);
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
      if (!activePlanPath) return;
      const snapshot = JSON.parse(JSON.stringify(tasks)) as TaskItem[];
      await this.enqueueActivePlanUpdate(async () => {
        const meta = await readActiveMeta(ws.root);
        if (!meta) throw new Error("活动计划在任务执行期间丢失");
        if (meta.path !== activePlanPath) {
          throw new Error("活动计划已切换，拒绝写入过期的任务状态");
        }
        meta.tasks = snapshot;
        meta.currentTaskId = nextId;
        await writeActiveMeta(ws.root, meta);
      }, sessionId);
      onEvent?.(stampTurnEvent({ type: "task_update", tasks: snapshot, currentTaskId: nextId }, sessionId));
    };

    const fileSnapshots: FileSnapshot[] = [];
    const touchedPaths: string[] = [];
    const historyBefore = r.history.map((h) => ({ ...h }));
    const checkpointEnabled = this.state.workflow.harness.checkpoint;

    // user 消息不在此预先追加，统一由 stage-handlers 在 loop 内注入 history，
    // 避免与 stage-handlers 的 history.push(user) 双重写入导致用户消息重复落盘。
    // turn 完成后由 result.history 覆盖并 persist；loop 抛错时在 catch 中补写。
    
    // 为此会话注册日志目录，确保多工作区场景下日志写入正确的位置
    const { registerTaskLogDir } = await import("@owncoder/llm");
    registerTaskLogDir(r.id, ws.root);
    
    let eventPersist: Promise<unknown> = Promise.resolve();
    const persistEvent = (ev: TurnEvent) => {
      // Stream deltas are presentation-only and must never create one durable
      // row per token. Persist lifecycle/tool/task events only; the final
      // transcript remains in the existing session snapshot for compatibility.
      if (ev.type === "thinking_delta" || ev.type === "assistant_delta" ||
          ev.type === "minimum_context_decision" || ev.type === "minimum_context_read_follow_up") {
        return;
      }
      const payload = ev.type === "terminal"
        ? {
            ...ev,
            entry: {
              ...ev.entry,
              stdout: ev.entry.stdout?.slice(-32_000),
              stderr: ev.entry.stderr?.slice(-32_000),
            },
          }
        : ev;
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
      workspaceRoot: ws.root,
      sessionId: r.id,
      turnId,
      workflow: this.state.workflow,
      index: this.sessionIndex(sessionId, ws.root),
      codemap: {
        search: (query, limit) => this.searchCodemapForAgent(query, limit),
        impact: (nodeId, depth) => this.impactCodemapForAgent(nodeId, depth),
      },
      history: r.history,
      userMessage: trimmed,
      signal: abortController.signal,
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
      projectRules: this.projectRules || null,
      documentWorkflow: r.documentWorkflow,
      taskRunState: r.taskRunState,

      fileSnapshots: checkpointEnabled ? fileSnapshots : undefined,
      touchedPaths: checkpointEnabled ? touchedPaths : undefined,
      confirmDangerousBash: this.confirmDangerousBash
        ? (command: string) => this.confirmDangerousBash!(command, sessionId)
        : undefined,
      askUser: this.askUserHandler
        ? (req: AskUserRequest) => this.askUserHandler!(req, sessionId)
        : undefined,
      renderPage: this.renderPageHandler ?? undefined,
      llmApiKey: this.llmApiKey,
      mcp: this.mcp,
      memoryStore: this.memoryStore ?? undefined,
      projectMemoryStore: this.projectMemoryStore ?? undefined,
      memoriesBlock: this.buildMemoriesBlock() || null,
      promptOptimizer: this.promptOptimizer,
      historyVector: this.historyVector,
      sessionChanges: {
        getPendingChanges: () => this.getPendingChanges(sessionId),
        undoChange: (path: string) => this.undoChange(path, sessionId),
      },
      });
    } catch (error) {
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
      
      await directPersist();
      await eventPersist;
      await completeTurn(capturedRoot, sessionId, turnId, { error: metadata.error, aborted: isAborted }, isAborted ? "cancelled" : "failed");
      // 收尾落盘完成后再发 turn_complete，让界面「已完成」与 sendChat 返回对齐。
      if (onEvent) {
        onEvent(stampTurnEvent({
          type: "turn_complete",
          parts,
          metadata,
        }, sessionId));
      }
      r.abort = null;
      
      // 注销会话日志目录映射
      const { unregisterTaskLogDir } = await import("@owncoder/llm");
      unregisterTaskLogDir(r.id);
      
      throw error;
    }

    // 完成 projector，获取结构化消息
    // timestamp 已在 finalize() 中自动设置，无需额外处理
    const { parts, metadata } = projector.finalize();
    
    // ✅ 更新 runtime 的 history 为 loop 返回的完整 history
    r.history = result.history;

    // Auto-compact: bound in-memory history after each turn to prevent
    // unbounded heap growth during long sessions. The manual compactNow()
    // has the same logic but is only triggered by /compact; this keeps the
    // runtime size under control automatically.
    const AUTO_COMPACT_BUDGET = 120 * 1024; // bytes (UTF-16 char count × 2)
    const AUTO_COMPACT_WINDOW = 30;          // keep at most this many recent turns
    if (r.history.length > AUTO_COMPACT_WINDOW) {
      const size = (turn: ChatTurn) => turn.content.length * 2;
      let total = r.history.reduce((n, t) => n + size(t), 0);
      if (total > AUTO_COMPACT_BUDGET) {
        const keepFrom = Math.max(0, r.history.length - AUTO_COMPACT_WINDOW);
        const old = r.history.slice(0, keepFrom);
        const summary = old.map((t) => `${t.role}: ${t.content.slice(0, 240)}`).join("\n").slice(0, 16 * 1024);
        const compacted: ChatTurn = {
          role: "system",
          content: `[历史摘要，共 ${old.length} 条，原始内容已压缩]\n${summary}`,
          metadata: { isCompressed: true, originalLength: old.length, compressedAt: new Date().toISOString(), compressionReason: "auto" },
        };
        r.history = [compacted, ...r.history.slice(keepFrom)];
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
        console.log(`[session] auto-compact: ${old.length} old turns → summary, kept ${AUTO_COMPACT_WINDOW} recent`);
      }
    }

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
    if (result.documentWorkflow !== undefined) {
      r.documentWorkflow = result.documentWorkflow;
    }
    if (result.taskRunState !== undefined) {
      r.taskRunState = result.taskRunState;
    }

    const persistStarted = Date.now();
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
      const checkpointStarted = Date.now();
      await persistCheckpoint(ws.root, cp);
      checkpointMs = Date.now() - checkpointStarted;
      r.lastCheckpointId = cp.id;
      r.keptPaths.clear();

      // present_changes disabled or autoKeep → keep all (no review UI)
      if (result.presentChanges === false) {
        for (const p of cp.touched) r.keptPaths.add(p);
      }
    }

    const sessionStarted = Date.now();
    await directPersist();
    const sessionMs = Date.now() - sessionStarted;
    const eventsStarted = Date.now();
    await eventPersist;
    const eventsMs = Date.now() - eventsStarted;
    const completeStarted = Date.now();
    await completeTurn(capturedRoot, sessionId, turnId, result);
    const completeMs = Date.now() - completeStarted;
    console.log(`[turn] sid=${sessionId} persist checkpoint=${checkpointMs}ms session=${sessionMs}ms events=${eventsMs}ms completeTurn=${completeMs}ms total=${Date.now() - persistStarted}ms`);
    // 收尾落盘完成后再发 turn_complete，让界面「已完成」与 sendChat 返回对齐。
    if (onEvent) {
      onEvent(stampTurnEvent({
        type: "turn_complete",
        parts: completeParts,
        metadata,
      }, sessionId));
    }
    r.abort = null;
    
    // 注销会话日志目录映射
    const { unregisterTaskLogDir } = await import("@owncoder/llm");
    unregisterTaskLogDir(r.id);
    
    return result;
  }
}

export function createSession(): SessionOrchestrator {
  return new SessionOrchestrator();
}

export { checkWritable } from "./harness/writable.ts";
export { listSessionMetas } from "./session-store.ts";

export {
  COMPATIBILITY_ADAPTER_MODULE_ID,
  createCompatibilityAdapter,
  type CompatibilityAdapter,
} from "./compatibility-adapter.ts";

