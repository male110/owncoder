import type { ChatAttachment } from "@owncoder/llm";
import type { AgentMode } from "@owncoder/shared";
import type { AskUserRequest, SkillsApi } from "./harness/tools/types.ts";
import { BUILTIN_WORKFLOW, type SystemWorkflowConfig } from "@owncoder/settings";
import {
  createIndexClient,
  type CodemapClient,
  type CodemapImpact,
  type CodemapSearchHit,
  type IndexClient,
  type SemanticSearchPort,
} from "@owncoder/index";
import { join } from "node:path";
import { initLlmLogger } from "@owncoder/llm";
import {
  type AgentLoopResult,
  type ChatTurn,
  type TurnEvent,
} from "./harness/loop.ts";
import type { AgentLoopOpts } from "./harness/loop/types.ts";
import {
  SessionRunCoordinator,
  type SessionInput,
} from "./session-coordinator.ts";
import { type SessionRuntime, createSessionRuntime } from "./session-runtime.ts";
import { buildSessionPersistPayload, enqueueSessionPersist, validateSessionData } from "./session-persist.ts";
import { compactHistory } from "./history-compact.ts";
import { CodemapManager } from "./codemap-manager.ts";
import { WorkspaceFileWatcher } from "./workspace-watcher.ts";
import { executeAgentTurn } from "./turn-execution.ts";
import { applyLoadedSession, type LoadedSession, type SessionLoadHost } from "./session-load.ts";
import {
  approvePlan,
  clearActivePlan,
  getActivePlan,
  getPendingChanges,
  keepAllChanges,
  keepChange,
  listCheckpoints,
  listPlans,
  readPlan,
  rollbackCheckpoint,
  undoChange,
  updateTask,
  type PlansHost,
} from "./session-plans.ts";
import type {
  SpecFeature as SpecFeatureDto,
  SpecPhase as SpecPhaseDto,
  SpecStatus as SpecStatusDto,
} from "./specs.ts";
import {
  approveSpecPhase,
  getSpecStatus as getSpecFeatureStatus,
  listSpecFeatures,
  readSpecDocument,
  rejectSpecPhase,
  saveSpecDocument,
  type SpecsHost,
} from "./session-specs.ts";
import type { SessionState } from "./session-runtime.ts";
import {
  type ChangeFile,
} from "./changes.ts";
import { getGitStatus, type GitStatus } from "./git.ts";
import { McpManager } from "./mcp/client.ts";
import { deleteDecomposeRound } from "./turn-rounds.ts";
import {
  beginTurn,
  deleteTurn,
  loadTurn,
  migrateLegacyHistory,
  loadRecentTurns,
  loadOlderTurns,
  projectConversationTurns,
  sanitizeOversizedFinalJson,
  sanitizeOversizedEventPayloads,
} from "./conversation-store.ts";

import type { TerminalEntry } from "./harness/terminal.ts";
import {
  clearPersistedSession,
  createSessionFile,
  deleteSessionFile,
  deleteSessionSidecars,
  listSessionMetas,
  loadSessionById,
  type PersistedSession,
  saveSessionById,
  sanitizeQueuedMessages,
  setActiveSessionId,
  toggleSessionPin,
  renameSession,
  type QueuedMessage,
  type SessionMeta,
} from "./session-store.ts";
import { applyTaskEvent } from "./task-run.ts";
import {
  deleteRule,
  listRules,
  loadCombinedRules,
  readRule,
  writeRule,
  type RuleFileInfo,
} from "./rules.ts";
import {
  buildSkillsCatalogSection,
  deleteSkillDir,
  discoverSkills,
  loadSkillContent,
  parseSkillMarkdown,
  readSkillRaw,
  SKILLS_DIR,
  validateSkillName,
  writeSkillFiles,
  writeSkillRaw,
  type SkillMetadata,
  type SkillWriteInput,
} from "./skills.ts";
import { BUNDLED_SKILLS } from "./skills-bundled.ts";
import { readActiveMeta } from "./plans.ts";
import type {
  ActivePlanMeta,
  PlanInfo,
  TaskItem,
  TaskStatus,
} from "./plans.ts";
import { UserMemoryStore } from "./user-memories.ts";

export * from "./public-api.ts";

const ERR_NO_WORKSPACE = "请先打开项目文件夹";

export class SessionOrchestrator {
  /** Global + focus-session state. workspace/workflow are global; activeSessionId
   * is the front-end focus session. Per-session fields live in `runtimes`. */
  private state: SessionState = {
    mode: "spec",
    workspace: null,
    workflow: BUILTIN_WORKFLOW,
    activePlanPath: null,
    lastPlanPath: null,
    currentFeature: null,
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
  private coordinator: SessionRunCoordinator<AgentLoopResult, { turnId: string; onEvent?: (ev: TurnEvent) => void; attachments?: ChatAttachment[] }> = 
    new SessionRunCoordinator(
      // Drain handler: 执行一轮代理循环，使用 input.context 中的 onEvent
      async (sessionId: string, input: SessionInput<{ turnId: string; onEvent?: (ev: TurnEvent) => void; attachments?: ChatAttachment[] }>) => {
        const { turnId, onEvent, attachments } = input.context || {};
        if (!turnId) throw new Error(`Missing turnId for session ${sessionId}`);
        return await this.executeAgentTurn(sessionId, input.text, turnId, onEvent, attachments);
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
    const bound = createIndexClient({ semantic: this.indexSemanticPort });
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
  /** Codemap 子系统（lazy 初始化、重试、损坏重建、stub 降级、agent 查询）——见 codemap-manager.ts。 */
  private codemapManager = new CodemapManager(() => this.state.workspace?.root ?? null);

  /** Access the embedded CodeGraph engine through OwnCoder's private API. */
  async getCodemap(): Promise<CodemapClient> {
    return this.codemapManager.get();
  }

  async searchCodemapForAgent(query: string, limit = 12): Promise<CodemapSearchHit[]> {
    return this.codemapManager.search(query, limit);
  }

  async impactCodemapForAgent(nodeId: string, depth = 3): Promise<CodemapImpact> {
    return this.codemapManager.impact(nodeId, depth);
  }

  /** FS watcher for live incremental index updates; closed on workspace switch. */
  private fileWatcher = new WorkspaceFileWatcher();
  private confirmDangerousBash: ((command: string, sessionId?: string) => Promise<boolean>) | null = null;
  /** 危险 bash 自动批准开关（settings modes.agent.autoApproveBash），随 setWorkflow 同步。 */
  private autoApproveDangerousBash = false;
  private askUserHandler: ((req: AskUserRequest, sessionId?: string) => Promise<string>) | null = null;
  private renderPageHandler: AgentLoopOpts["renderPage"] | null = null;
  private llmApiKey: string | null = null;
  private projectRules = "";
  /** Discovered skills (project + user + bundled), including disabled ones. */
  private skillsIndex: SkillMetadata[] = [];
  /** Pre-formatted catalog of enabled skills, injected into the system prompt. */
  private skillsCatalogText = "";
  /** User-level skills root, injected by the desktop host at startup. */
  private userSkillsRoot: string | null = null;

  private mcp = new McpManager();
  private memoryStore: UserMemoryStore | null = null;
  private projectMemoryStore: UserMemoryStore | null = null;
  /** 历史向量检索基础设施（可选，由 desktop 层注入 sqlite-vec + embedding）。 */
  private historyVector: AgentLoopOpts["historyVector"] | undefined;
  /**
   * 代码语义检索端口（可选，由 desktop 层启动时注入）。sessionIndex 的
   * 查询客户端携带它后 ragSearch 才真正生效；未注入（CLI/headless）时
   * 维持空结果，消费方 hybrid 自动降级 FTS。
   */
  private indexSemanticPort: SemanticSearchPort | undefined;
  /** Desktop IndexHost sink: forward dirty paths to the writable UtilityProcess. */
  private indexDirtySink: ((batch: { files: string[]; directories: string[] }) => void) | null = null;

  /** Plans/tasks/checkpoints/changes 子系统桥（见 session-plans.ts）。 */
  private readonly plansHost: PlansHost = {
    rt: (id) => this.rt(id),
    rtOpt: (id) => this.rtOpt(id),
    sessionWorkspaceRoot: (id) => this.sessionWorkspaceRoot(id),
    workspaceRoot: () => this.state.workspace?.root ?? null,
    focusSessionId: () => this.state.activeSessionId,
    setFocusMode: (mode) => {
      this.state.mode = mode;
    },
    index: this.index,
    persist: (sessionId, activityUpdatedAt) => this.persist(sessionId, activityUpdatedAt),
    getState: (sessionId) => this.getState(sessionId),
    enqueueActivePlanUpdate: (update, sessionId) => this.enqueueActivePlanUpdate(update, sessionId),
  };

  /** Spec 工作流审批闸门桥（见 session-specs.ts）。 */
  private readonly specsHost: SpecsHost = {
    rt: (id) => this.rt(id),
    sessionWorkspaceRoot: (id) => this.sessionWorkspaceRoot(id),
    focusSessionId: () => this.state.activeSessionId,
    setFocusMode: (mode) => {
      this.state.mode = mode;
    },
    persist: (sessionId, activityUpdatedAt) => this.persist(sessionId, activityUpdatedAt),
    getState: (sessionId) => this.getState(sessionId ?? undefined),
  };

  /** 会话快照装入桥（见 session-load.ts）。 */
  private readonly loadHost: SessionLoadHost = {
    runtimes: this.runtimes,
    sessionRoots: this.sessionRoots,
    state: this.state,
    workspaceRoot: () => this.state.workspace?.root ?? null,
    isSessionIncomplete: (id) => this.isSessionIncomplete(id),
  };

  setDangerousBashConfirmer(fn: ((command: string, sessionId?: string) => Promise<boolean>) | null): void {
    this.confirmDangerousBash = fn;
  }

  /** 设置危险 bash 自动批准开关（settings modes.agent.autoApproveBash）。 */
  setAutoApproveDangerousBash(enabled: boolean): void {
    this.autoApproveDangerousBash = enabled;
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
   * 注入代码语义检索端口（bge 嵌入 + sqlite-vec 加载器）。桌面端启动时
   * 调用一次；sessionIndex 的查询客户端随后创建时携带它，ragSearch 生效。
   */
  setIndexSemanticPort(port: SemanticSearchPort | undefined): void {
    this.indexSemanticPort = port;
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

  /**
   * Point the session at the user-level skills directory. Called once from
   * the desktop main process at startup (mirrors setMemoriesDir).
   */
  setSkillsUserDir(dir: string): void {
    this.userSkillsRoot = dir || null;
    void this.reloadProjectSkills();
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

  async getGitStatus(workspaceRoot?: string): Promise<GitStatus> {
    const ws = workspaceRoot ? { root: workspaceRoot } : this.state.workspace;
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
      currentFeature: r?.currentFeature ?? null,
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

    // Repair oversized legacy final_json blobs before any page read. Cheap when
    // already sanitized; prevents a single 300MB JSON.parse from killing Electron.
    try {
      const changed = sanitizeOversizedFinalJson(root, sessionId);
      if (changed > 0) {
        console.warn(`[conversation] sanitized ${changed} oversized final_json row(s) in ${sessionId}`);
      }
    } catch (error) {
      console.warn(`[conversation] sanitize oversized final_json failed for ${sessionId}:`, error);
    }

    try {
      const eventChanged = sanitizeOversizedEventPayloads(root, sessionId);
      if (eventChanged > 0) {
        console.warn(`[conversation] sanitized ${eventChanged} oversized event payload(s) in ${sessionId}`);
      }
    } catch (error) {
      console.warn(`[conversation] sanitize oversized event payloads failed for ${sessionId}:`, error);
    }

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

  /**
   * Delete one complete turn (user input + assistant reply + tool process).
   * Removes it from the durable conversation store, the runtime LLM context,
   * and the session JSON. No-op (returns false) when the turn does not exist.
   */
  async deleteTurnPair(turnId: string, sessionId?: string): Promise<boolean> {
    if (!turnId) return false;
    const sid = sessionId ?? this.state.activeSessionId ?? undefined;
    const r = sid ? this.rtOpt(sid) : undefined;
    const root = r?.workspaceRoot
      ?? (sid ? this.sessionRoots.get(sid) : null)
      ?? this.state.workspace?.root
      ?? null;
    if (!root || !sid) return false;

    const original = await loadTurn(root, sid, turnId);
    if (!original) return false;
    const removed = await deleteTurn(root, sid, turnId);
    if (!removed) return false;
    await deleteDecomposeRound(root, sid, turnId, original.user?.content, original.startedAt);

    // Drop the turn from the in-memory LLM context as well, so subsequent
    // turns no longer reference the mistaken input/reply. Only the user row
    // carries turnId; the loop's assistant/tool rows for this turn follow it
    // up to the next user row, so remove by that round boundary.
    if (r) {
      const start = r.history.findIndex((h) => h.role === "user" && h.turnId === turnId);
      if (start >= 0) {
        let end = start + 1;
        while (end < r.history.length && r.history[end]!.role !== "user") end++;
        r.history = [...r.history.slice(0, start), ...r.history.slice(end)];
      }
      await this.persist(sid);
    }
    return true;
  }

  setMode(mode: AgentMode, sessionId?: string): void {
    const r = this.rtOpt(sessionId);
    if (r) {
      r.mode = mode;
      void this.persist(sessionId);
    }
  }

  setWorkflow(workflow: SystemWorkflowConfig): void {
    const prevSkills = this.state.workflow.skills;
    this.state.workflow = workflow;
    this.index.setExtraIgnore?.(workflow.index.extraIgnore ?? []);
    // 危险 bash 自动批准开关随 workflow 同步到执行层（bash 工具读取）。
    this.autoApproveDangerousBash = workflow.modes.agent.autoApproveBash ?? false;

    this.syncMcp();
    if (JSON.stringify(prevSkills) !== JSON.stringify(workflow.skills)) {
      void this.reloadProjectSkills();
    }
  }

  setTodoAnchor(todo: string | null, sessionId?: string): void {
    const r = this.rtOpt(sessionId);
    if (r) {
      r.todoAnchor = todo?.trim() || null;
      void this.persist(sessionId);
    }
  }

  /** Persist the session's queued (not yet executed) messages to the session file. */
  setQueuedMessages(messages: QueuedMessage[] | string[], sessionId?: string): void {
    const r = this.rtOpt(sessionId);
    if (!r) return;
    const queuedMessages = sanitizeQueuedMessages(messages);
    const activityUpdatedAt = queuedMessages.length > r.queuedMessages.length
      ? new Date().toISOString() : undefined;
    r.queuedMessages = queuedMessages;
    void this.persist(sessionId, activityUpdatedAt);
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
    // Symbol index is always on (no longer configurable): open read-only
    // immediately so search_symbols never hits a previous workspace.
    void this.index.open(root, undefined, { mode: "query" }).catch((error) => {
      console.warn(`[session] readonly index open failed:`, error);
    });
    initLlmLogger(root);

    // 重新加载项目规则（轻量级操作）
    await this.reloadProjectRules();
    await this.reloadProjectSkills();

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
      await setActiveSessionId(root, id);
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
    // Symbol index is always on (no longer configurable).
    void this.index.open(root, undefined, { mode: "query" }).catch((error) => {
      console.warn(`[session] readonly index open failed:`, error);
    });
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
    await this.reloadProjectSkills();

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
      await setActiveSessionId(root, id);
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
    this.fileWatcher.start(root, {
      invalidate: (path) => this.index.invalidate?.(path),
      invalidateDir: (path) => this.index.invalidateDir?.(path),
      onDirty: (batch) => this.indexDirtySink?.(batch),
    });
  }

  private applyLoadedSession(saved: LoadedSession): void {
    applyLoadedSession(this.loadHost, saved);
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
    }
    const focusMode = this.rtOpt()?.mode ?? "agent";
    const created = await createSessionFile(ws.root, {
      title: title || "新会话",
      mode: focusMode === "spec" ? "spec" : "agent",
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
      // 等待持久化完成，确保当前会话状态被正确保存
      await this.persist(previousId);
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
    if (!validateSessionData(saved)) {
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
      // 磁盘数据无效且内存中无可用状态，抛出错误防止应用损坏数据
      throw new Error(`会话数据验证失败: ${id}`);
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
      await deleteSessionSidecars(projectRoot, id);
      try {
        this.historyVector?.deleteSession?.(id);
      } catch (error) {
        console.warn(`[session] 清除历史向量失败: ${id}`, error);
      }
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
    await deleteSessionSidecars(ws.root, id);
    try {
      this.historyVector?.deleteSession?.(id);
    } catch (error) {
      console.warn(`[session] 清除历史向量失败: ${id}`, error);
    }
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

  async toggleChatSessionPin(id: string, projectRoot?: string): Promise<SessionMeta[]> {
    const root = projectRoot ?? this.sessionRoots.get(id) ?? this.state.workspace?.root;
    if (!root) throw new Error(ERR_NO_WORKSPACE);
    const runtime = this.runtimes.get(id);
    const run = () => toggleSessionPin(root, id);
    const pending = runtime ? runtime.persistQueue.then(run, run) : run();
    if (runtime) runtime.persistQueue = pending.then(() => undefined);
    return pending;
  }

  async renameChatSession(id: string, title: string, projectRoot?: string): Promise<SessionMeta> {
    const root = projectRoot ?? this.sessionRoots.get(id) ?? this.state.workspace?.root;
    if (!root) throw new Error(ERR_NO_WORKSPACE);
    const runtime = this.runtimes.get(id);
    const run = async () => {
      const meta = await renameSession(root, id, title);
      if (runtime) runtime.sessionTitle = meta.title;
      if (this.state.activeSessionId === id) this.state.sessionTitle = meta.title;
      return meta;
    };
    const pending = runtime ? runtime.persistQueue.then(run, run) : run();
    if (runtime) runtime.persistQueue = pending.then(() => undefined);
    return pending;
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
    const lastUser = r.history[lastUserIdx]!;
    const userText = lastUser.content.trim();
    const attachments = lastUser.attachments ?? [];
    if (!userText && !attachments.length) {
      throw new Error("上一条用户消息为空");
    }
    r.history = r.history.slice(0, lastUserIdx);
    await this.persist(sessionId);
    return this.sendMessage(userText, onEvent, sessionId, attachments, false);
  }

  /** Flush current chat session to `.owncoder/sessions/{id}.json`. */
  async persist(sessionId?: string, activityUpdatedAt?: string): Promise<void> {
    const sid = sessionId ?? this.state.activeSessionId;
    if (!sid) return;
    const r = this.runtimes.get(sid);
    if (!r) return;
    const persistRoot = r.workspaceRoot ?? this.state.workspace?.root;
    if (!persistRoot) return;
    const run = async () => {
      try {
        const meta = await saveSessionById(persistRoot, sid, buildSessionPersistPayload(r), activityUpdatedAt);
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
    return enqueueSessionPersist(r, run);
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
    await this.reloadProjectSkills();
    return info;
  }

  async deleteRule(name: string): Promise<void> {
    const ws = this.state.workspace;
    if (!ws) throw new Error(ERR_NO_WORKSPACE);
    await deleteRule(ws.root, name);
    await this.reloadProjectRules();
    await this.reloadProjectSkills();
  }

  // ── Skills ──────────────────────────────────────────────────────────────

  private disabledSkillIds(): Set<string> {
    return new Set(this.state.workflow.skills?.disabled ?? []);
  }

  /**
   * Re-scan the project + user + bundled skill directories and rebuild the
   * system-prompt catalog. Cheap (two small directory scans); called on
   * workspace switch, skill writes/deletes and skills config changes.
   */
  async reloadProjectSkills(): Promise<void> {
    const skillsConfig = this.state.workflow.skills;
    if (skillsConfig?.enabled === false) {
      this.skillsIndex = [];
      this.skillsCatalogText = "";
      return;
    }
    const ws = this.state.workspace;
    const { skills } = await discoverSkills({
      workspaceRoot: ws ? ws.root : null,
      userSkillsRoot: this.userSkillsRoot,
      bundled: BUNDLED_SKILLS,
      disabledIds: this.disabledSkillIds(),
    });
    this.skillsIndex = skills;
    this.skillsCatalogText = buildSkillsCatalogSection(
      skills.filter((s) => s.enabled),
      { projectDir: ws ? join(ws.root, SKILLS_DIR) : null, userDir: this.userSkillsRoot },
    );
  }

  getSkillsCatalogText(): string {
    return this.skillsCatalogText;
  }

  /** Skill loading API injected into the agent loop (backs the use_skill tool). */
  getSkillsApi(): SkillsApi {
    return {
      loadSkill: async (name: string) => {
        let meta = this.skillsIndex.find((s) => s.name === name);
        if (meta && !meta.enabled) return null;
        if (!meta) {
          // Cache miss: a skill file may have appeared since the last scan
          // (e.g. an agent just wrote one via the install-skill flow).
          // Re-scan once (cheap: two small directories) and retry.
          await this.reloadProjectSkills();
          meta = this.skillsIndex.find((s) => s.name === name);
        }
        if (!meta || !meta.enabled) return null;
        const bundledBody = meta.source === "bundled"
          ? BUNDLED_SKILLS.find((b) => b.name === meta.name)?.content
          : undefined;
        return loadSkillContent(meta, { bundledBody });
      },
      listNames: async () => this.skillsIndex.filter((s) => s.enabled).map((s) => s.name),
    };
  }

  /** All discovered skills (including disabled) for the settings UI. */
  async listSkills(): Promise<SkillMetadata[]> {
    return this.skillsIndex;
  }

  /** Raw SKILL.md document (frontmatter included) for the settings editor. */
  async readSkillRaw(name: string): Promise<{ meta: SkillMetadata; raw: string }> {
    const meta = this.skillsIndex.find((s) => s.name === name);
    if (!meta) throw new Error(`技能不存在：${name}`);
    if (meta.source === "bundled") throw new Error("内置技能不可编辑");
    const raw = await readSkillRaw(meta);
    return { meta, raw };
  }

  /**
   * Create or overwrite a skill. `raw` (a full SKILL.md document) takes
   * precedence over the structured fields; both paths validate that the
   * frontmatter name matches the skill name.
   */
  async writeSkill(input: {
    scope: "project" | "user";
    name: string;
    description: string;
    whenToUse?: string;
    body: string;
    raw?: string;
  }): Promise<SkillMetadata[]> {
    const ws = this.state.workspace;
    if (input.scope === "project" && !ws) throw new Error(ERR_NO_WORKSPACE);
    const root = input.scope === "project" ? join(ws!.root, SKILLS_DIR) : this.userSkillsRoot;
    if (!root) throw new Error("用户级技能目录不可用");
    const name = validateSkillName(input.name);
    if (input.raw !== undefined && input.raw.trim()) {
      const { frontmatter } = parseSkillMarkdown(input.raw);
      const fmName = frontmatter.name?.trim();
      if (!fmName) throw new Error("SKILL.md 的 frontmatter 必须包含 name 字段");
      if (fmName !== name) {
        throw new Error(`frontmatter 中的 name（${fmName}）与技能名（${name}）不一致`);
      }
      await writeSkillRaw(root, name, input.raw);
    } else {
      const structured: SkillWriteInput = {
        name,
        description: input.description,
        whenToUse: input.whenToUse,
        body: input.body,
      };
      await writeSkillFiles(root, structured);
    }
    await this.reloadProjectSkills();
    return this.skillsIndex;
  }

  async deleteSkill(name: string): Promise<SkillMetadata[]> {
    const meta = this.skillsIndex.find((s) => s.name === name);
    if (!meta) throw new Error(`技能不存在：${name}`);
    if (meta.source === "bundled") throw new Error("内置技能不可删除");
    const ws = this.state.workspace;
    if (meta.scope === "project" && !ws) throw new Error(ERR_NO_WORKSPACE);
    const root = meta.scope === "project" ? join(ws!.root, SKILLS_DIR) : this.userSkillsRoot;
    if (!root) throw new Error("用户级技能目录不可用");
    await deleteSkillDir(root, name);
    await this.reloadProjectSkills();
    return this.skillsIndex;
  }

  async restoreProjectContext(): Promise<{ rules: number; memories: number }> {
    const ws = this.state.workspace;
    if (!ws) throw new Error(ERR_NO_WORKSPACE);

    const rules = await this.listRules();
    await Promise.all(rules.map((rule) => deleteRule(ws.root, rule.name)));
    const memories = this.projectMemoryStore?.clear() ?? 0;
    await this.reloadProjectRules();
    await this.reloadProjectSkills();
    return { rules: rules.length, memories };
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
    return listPlans(this.plansHost, sessionId);
  }

  async readPlan(relPath: string): Promise<string> {
    return readPlan(this.plansHost, relPath);
  }

  async getActivePlan(sessionId?: string): Promise<ActivePlanMeta | null> {
    return getActivePlan(this.plansHost, sessionId);
  }

  async updateTask(taskId: string, status: TaskStatus, result?: string, sessionId?: string): Promise<ActivePlanMeta | null> {
    return updateTask(this.plansHost, taskId, status, result, sessionId);
  }

  async listCheckpoints(): Promise<
    Array<{ id: string; createdAt: string; touched: string[]; historyLen: number }>
  > {
    return listCheckpoints(this.plansHost);
  }

  async getPendingChanges(sessionId?: string): Promise<{
    checkpointId: string | null;
    files: ChangeFile[];
    /** True when this session had a checkpoint but it is gone from disk. */
    expired?: boolean;
  }> {
    return getPendingChanges(this.plansHost, sessionId);
  }

  /** Accept all pending file changes (keep on disk). */
  async keepAllChanges(sessionId?: string): Promise<void> {
    return keepAllChanges(this.plansHost, sessionId);
  }

  async keepChange(path: string, sessionId?: string): Promise<void> {
    return keepChange(this.plansHost, path, sessionId);
  }

  async undoChange(path: string, sessionId?: string): Promise<void> {
    return undoChange(this.plansHost, path, sessionId);
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
    return rollbackCheckpoint(this.plansHost, id, sessionId);
  }

  async approvePlan(opts?: {
    path?: string;
    content?: string;
    title?: string;
    tasks?: TaskItem[];
  }, sessionId?: string): Promise<SessionState> {
    return approvePlan(this.plansHost, opts, sessionId);
  }

  async clearActivePlan(sessionId?: string): Promise<SessionState> {
    return clearActivePlan(this.plansHost, sessionId);
  }

  // ── Spec 工作流（Kiro 风格 spec → design → tasks）────────────

  async listSpecs(sessionId?: string): Promise<SpecFeatureDto[]> {
    return listSpecFeatures(this.specsHost, sessionId);
  }

  async readSpec(feature: string, phase: SpecPhaseDto): Promise<string> {
    return readSpecDocument(this.specsHost, feature, phase);
  }

  async getSpecStatus(feature: string): Promise<SpecStatusDto> {
    return getSpecFeatureStatus(this.specsHost, feature);
  }

  async saveSpecDoc(
    feature: string,
    phase: SpecPhaseDto,
    content: string,
    sessionId?: string,
  ): Promise<SessionState> {
    return saveSpecDocument(this.specsHost, feature, phase, content, sessionId);
  }

  async approveSpec(feature: string, sessionId?: string): Promise<SessionState> {
    return approveSpecPhase(this.specsHost, feature, sessionId);
  }

  async rejectSpec(feature: string, feedback: string, sessionId?: string): Promise<SessionState> {
    return rejectSpecPhase(this.specsHost, feature, feedback, sessionId);
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
    if (!r) return this.getHistory(sessionId);
    const outcome = compactHistory(r.history, { recentWindow: 20, budgetBytes: 120 * 1024, reason: "manual" });
    if (!outcome.compacted) return this.getHistory(sessionId);
    r.history = outcome.history;
    if (r.taskRunState) {
      r.taskRunState = applyTaskEvent(r.taskRunState, {
        type: "observability",
        taskId: r.taskRunState.taskId,
        contextCompressions: 1,
      });
    }
    void this.persist(sessionId);
    return outcome.history.map((turn) => ({ ...turn }));
  }

  async sendMessage(
    text: string,
    onEvent?: (ev: TurnEvent) => void,
    sessionId?: string,
    attachments: import("@owncoder/llm").ChatAttachment[] = [],
    updateActivity = true,
  ): Promise<AgentLoopResult> {
    const trimmed = text.trim();
    if (!trimmed && !attachments.length) {
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
    const userTurn: ChatTurn = {
      role: "user",
      content: trimmed,
      turnId,
      ...(attachments.length ? { attachments } : {}),
    };
    await beginTurn(workspaceRoot, sid, userTurn, turnId);

    // beginTurn 成功后再写入 runtime + session JSON，保证并发 loadHistoryPage
    // 看到 store 已有行时会跳过 migrate，不会再复制一条 user。
    r.history = [...r.history, userTurn];
    await this.persist(sid, updateActivity ? new Date().toISOString() : undefined);

    // 通过协调器提交输入，传递 onEvent 上下文
    // 协调器会自动处理队列、串行化和 drain loop
    return await this.coordinator.admit(sid, trimmed, { turnId, onEvent, attachments });
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
    attachments: import("@owncoder/llm").ChatAttachment[] = [],
  ): Promise<AgentLoopResult> {
    const r = this.rt(sessionId);
    const ws = this.sessionWorkspace(sessionId);

    // 使用协调器的 AbortController 而不是自己创建
    const abortController = this.coordinator.getAbortController(sessionId);
    if (!abortController) {
      throw new Error(`No abort controller for session ${sessionId}`);
    }

    // 兼容：也更新 runtime 的 abort 引用（供其他代码使用）
    r.abort = abortController;

    // 实际的轮次执行与收尾逻辑见 turn-execution.ts；这里只负责
    // 把会话运行时、全局配置与宿主桥接组装成 AgentTurnContext。
    return executeAgentTurn({
      sessionId,
      text,
      turnId,
      onEvent,
      attachments,
      runtime: r,
      workspaceRoot: ws.root,
      abortController,
      workflow: this.state.workflow,
      checkpointEnabled: this.state.workflow.harness.checkpoint,
      index: this.sessionIndex(sessionId, ws.root),
      codemap: {
        search: (query, limit) => this.searchCodemapForAgent(query, limit),
        impact: (nodeId, depth) => this.impactCodemapForAgent(nodeId, depth),
      },
      llmApiKey: this.llmApiKey,
      projectRules: this.projectRules || null,
      skillsCatalog: this.skillsCatalogText || null,
      skills: this.getSkillsApi(),
      memoriesBlock: this.buildMemoriesBlock() || null,
      mcp: this.mcp,
      memoryStore: this.memoryStore,
      projectMemoryStore: this.projectMemoryStore,
      historyVector: this.historyVector,
      confirmDangerousBash: this.confirmDangerousBash
        ? (command: string) => this.confirmDangerousBash!(command, sessionId)
        : undefined,
      autoApproveDangerousBash: this.autoApproveDangerousBash,
      askUser: this.askUserHandler
        ? (req: AskUserRequest) => this.askUserHandler!(req, sessionId)
        : undefined,
      renderPage: this.renderPageHandler ?? undefined,
      sessionChanges: {
        getPendingChanges: () => this.getPendingChanges(sessionId),
        undoChange: (path: string) => this.undoChange(path, sessionId),
      },
      enqueueActivePlanUpdate: <T>(update: () => Promise<T>) => this.enqueueActivePlanUpdate(update, sessionId),
    });
  }
}

export function createSession(): SessionOrchestrator {
  return new SessionOrchestrator();
}
