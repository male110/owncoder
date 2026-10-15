import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentMode,
  IndexStatus,
  TaskDecompositionDto,
  ToolEndMetadataDto,
  WorkspaceInfo,
} from "@owncoder/shared";
import type { SystemWorkflowConfig, WorkflowOverlay, ModelSettingsOverlay } from "@owncoder/settings";

export interface SettingsSnapshotDto {
  effective: SystemWorkflowConfig;
  builtin: SystemWorkflowConfig;
  userOverlay: WorkflowOverlay | null;
  modelOverlay: ModelSettingsOverlay | null;
  fingerprint: string;
  paths: {
    userDir: string;
    userWorkflow: string;
    userModels: string;
  };
  hasUserOverride: boolean;
  matchesBuiltin: boolean;
}

export interface ChatAttachmentDto { name: string; mimeType: string; url: string; size?: number }

export type ChatTurnDto = {
  role: "user" | "assistant" | "tool" | "system";
  /** 会话内唯一 turn id（工具调用优先用 toolCallId；历史兼容可缺省） */
  id?: string;
  /** 所属对话轮次（用户输入+回复对）的持久化 turn id，用于整轮删除。 */
  turnId?: string;
  content: string;
  attachments?: ChatAttachmentDto[];
  parts?: MessagePartDto[];
  metadata?: MessageMetadataDto;
  toolName?: string;
  /** 工具调用参数（历史工具结果通过对应 tool_use 部件恢复） */
  toolArgs?: Record<string, unknown>;
  // 压缩相关字段
  isCompressed?: boolean;
  originalLength?: number;
  compressedAt?: string;
  compressionReason?: "context_limit" | "manual" | "auto" | "disk_save";
  importantSnippets?: string[]; // 压缩时保留的重要片段
};

export interface ChatHistoryPageDto {
  turns: ChatTurnDto[];
  beforeSeq: number | null;
  hasMore: boolean;
}
export type TerminalEntryDto = {
  id: string;
  command: string;
  cwd?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  status: "running" | "ok" | "error" | "denied" | "pending_confirm";
  at: string;
};

export interface DangerousCommandRequestDto {
  requestId: string;
  command: string;
  /** Owning chat session id; null when unknown (legacy/global request). */
  sessionId: string | null;
}

export interface AskUserOptionDto {
  label: string;
  value: string;
  description?: string;
}

/** A blocking question the agent asks the user; the UI returns the chosen answer. */
export interface AskUserRequestDto {
  requestId: string;
  question: string;
  options: AskUserOptionDto[];
  allowFreeText: boolean;
  placeholder?: string;
  /** Owning chat session id; null when unknown. */
  sessionId: string | null;
}

/** MessagePart - 结构化消息部件 DTO（镜像后端类型） */
export type MessagePartDto =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/** MessageMetadata - 消息元数据 DTO（镜像后端类型） */
export interface MessageMetadataDto {
  timestamp?: string;
  model?: string;
  stopReason?: string;
  tokens?: { input: number; output: number };
  isCompressed?: boolean;
  originalLength?: number;
  compressedAt?: string;
  compressionReason?: "context_limit" | "manual" | "auto" | "disk_save" | "retained";
  importantSnippets?: string[];
}

type ChatEventFields =
  | { type: "assistant_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_end"; id: string; name: string; ok: boolean; output: string; metadata?: ToolEndMetadataDto; skipped?: boolean }
  | { type: "turn_complete"; parts: MessagePartDto[]; metadata: MessageMetadataDto }
  | { type: "terminal"; entry: TerminalEntryDto }
  | { type: "stage_start"; id: string; nodeType: string; label: string }
  | { type: "stage_done"; id: string; nodeType: string; label: string }
  | ({ type: "task_decomposition" } & TaskDecompositionDto)
  | { type: "error"; message: string }
  | { type: "warning"; message: string }
  | { type: "done"; assistantText: string }
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
  | {
      type: "minimum_context_read_follow_up";
      action: "fresh_read" | "invalidated" | "invalidated_all";
      path?: string;
      startLine?: number;
      endLine?: number;
      totalLines?: number;
      affectedPaths?: number;
    }
  | { type: "task_update"; tasks: TaskItemDto[]; currentTaskId: string | null }
  | {
      type: "task_run_state";
      phase:
        | "planning"
        | "executing"
        | "verifying"
        | "repairing"
        | "completed"
        | "failed"
        | "blocked"
        | "interrupted";
      taskId: string;
      verificationStatus: "passed" | "failed" | "blocked" | "skipped" | "not_run";
      verificationPassed: boolean;
      verificationSummary: string;
      repairAttempts: number;
      maxRepairAttempts: number;
      label: string;
      metrics?: TaskRunMetricsDto;
      totalDurationMs?: number;
    };

/** 任务运行可观测性指标（与 core TaskRunMetrics 对齐）。 */
export interface TaskRunMetricsDto {
  startedAt: string;
  phaseStartedAtMs: number;
  phaseDurationsMs: Partial<Record<string, number>>;
  modelSampleCount: number;
  toolCallCount: number;
  retryCount: number;
  contextCompressionCount: number;
  verificationFailureReasons: string[];
  repairCompletedCount: number;
  repairResolvedCount: number;
  repairSuccessRate: number | null;
  terminalReason: string | null;
}

/** Chat event as emitted before the IPC stamp (sessionId may still be missing). */
export type ChatEventInputDto = ChatEventFields & { sessionId?: string };

/** Every chat event carries the owning session id after the IPC stamp. */
export type ChatEventDto = ChatEventFields & { sessionId: string };

export interface PlanInfoDto {
  path: string;
  title: string;
  mtimeMs: number;
  size: number;
  kind: "plan" | "document";
  /** Owning chat session id; null when unknown. */
  sessionId?: string | null;
}

export type TaskStatusDto = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export type PlanStatusDto = "pending_approval" | "approved" | "executing" | "completed";

export interface TaskItemDto {
  id: string;
  description: string;
  status: TaskStatusDto;
  acceptance?: string;
  dependsOn: string[];
  result?: string;
  retryCount: number;
  maxRetries: number;
}

export interface ActivePlanMetaDto {
  path: string;
  approvedAt: string;
  title?: string;
  tasks: TaskItemDto[];
  currentTaskId: string | null;
  status?: PlanStatusDto;
}

export interface CheckpointInfoDto {
  id: string;
  createdAt: string;
  touched: string[];
  historyLen: number;
}

export interface ChangeFileDto {
  path: string;
  kind: "added" | "modified" | "deleted";
  before: string;
  after: string;
  /** 
   * Legacy unified-style diff preview (kept for backward compatibility).
   * The UI now uses before/after with Monaco DiffEditor instead.
   */
  preview: string;
}

export interface PendingChangesDto {
  checkpointId: string | null;
  files: ChangeFileDto[];
  /** The session's checkpoint is gone from disk — undo is no longer possible. */
  expired?: boolean;
}

export interface GitStatusDto {
  isRepo: boolean;
  branch: string | null;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
  summary: string;
}

export interface McpToolDto {
  serverId: string;
  name: string;
  qualifiedName: string;
  description?: string;
}

export interface SessionStateDto {
  mode: AgentMode;
  workspace: WorkspaceInfo | null;
  index: IndexStatus;
  workflowFingerprint: string;
  matchesBuiltin: boolean;
  activePlanPath: string | null;
  lastPlanPath: string | null;
  todoAnchor: string | null;
  lastCheckpointId: string | null;
  sessionRestored: boolean;
  activeSessionId: string | null;
  sessionTitle: string | null;
  queuedMessages: Array<{ text: string; attachments?: ChatAttachmentDto[] }>;
}

export interface ChatSessionMetaDto {
  id: string;
  /** 会话所属项目根目录。由 IPC 列表边界注入，不写入单项目索引文件。 */
  projectRoot: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  pinned?: boolean;
}

export interface ProjectDto {
  root: string;
  name: string;
  openedAt: string;
}

/** One entry from workspace:listDir (paths relative to project root). */
export interface WorkspaceDirEntryDto {
  name: string;
  path: string;
  kind: "file" | "dir";
}

export interface RuleFileDto {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

export interface SecretsDto {
  llmApiKey: string | null;
}

export type RedactionPreviewDto =
  | { status: "cancelled" }
  | { status: "error"; message: string }
  | {
      status: "success";
      fileName: string;
      filePath: string;
      content: string;
      reasons: string[];
      redacted: boolean;
      redactionScope: "whole-file" | "value-only";
      fileRuleMatched: boolean;
      truncated: boolean;
    };

export interface LlmAuthStatusDto {
  configured: boolean;
  local: boolean;
}

export interface UserMemoryDto {
  id: string;
  title: string;
  content: string;
  category: string;
  keywords: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UpdateInfoDto {
  /** 规范化后的版本号（已去掉 v 前缀）。 */
  version: string;
  /** 发布时的原始 tag（用于构造附件下载地址）。 */
  tagName: string;
  /** Release 名称（通常等于版本号）。 */
  name: string;
  /** 发布说明（截断后的纯文本预览）。 */
  notes?: string;
  /** 安装包直链（Windows .exe，浏览器回退用）。 */
  downloadUrl: string;
  /** 最新发布页地址。 */
  releaseUrl: string;
  publishedAt?: string;
  /** 当前环境是否支持应用内自动下载/静默安装（打包版 Windows）。 */
  canAutoUpdate: boolean;
}

export type UpdateDownloadStatusDto =
  | { state: "downloading"; /** 0-100；服务端没给总大小时为 -1（未知进度） */ percent: number }
  | { state: "downloaded" }
  | { state: "failed"; message: string };

export type UpdateCheckOutcomeDto =
  | { status: "update-available"; currentVersion: string; info: UpdateInfoDto }
  | { status: "up-to-date"; currentVersion: string }
  | { status: "error"; currentVersion: string; message: string };

export interface DesktopApi {
  openWorkspaceDialog: () => Promise<WorkspaceInfo | null>;
  openWorkspacePath: (root: string) => Promise<WorkspaceInfo | null>;
  /** 轻量级切换工作区，不清理会话（用于已加载项目之间的快速切换） */
  switchWorkspacePath: (root: string) => Promise<WorkspaceInfo | null>;
  reopenLastWorkspace: () => Promise<WorkspaceInfo | null>;
  getRecentWorkspace: () => Promise<{
    lastWorkspace: (WorkspaceInfo & { openedAt?: string }) | null;
    projects?: ProjectDto[];
  }>;
  listProjects: () => Promise<ProjectDto[]>;
  moveProject: (root: string, targetRoot: string, after: boolean) => Promise<ProjectDto[]>;
  removeProject: (root: string) => Promise<ProjectDto[]>;
  getWorkspace: () => Promise<WorkspaceInfo | null>;
  /** Current app version (from package.json), shown in the titlebar. */
  getAppVersion: () => Promise<string>;
  getSessionState: () => Promise<SessionStateDto>;
  listChatSessions: (root?: string) => Promise<{ activeId: string | null; sessions: ChatSessionMetaDto[] }>;
  createChatSession: (title?: string) => Promise<{
    meta: ChatSessionMetaDto;
    history: ChatTurnDto[];
  }>;
  switchChatSession: (id: string, projectRoot?: string) => Promise<{
    history: ChatTurnDto[];
    terminal: TerminalEntryDto[];
    state: SessionStateDto;
  }>;
  deleteChatSession: (id: string, projectRoot?: string) => Promise<{
    activeId: string | null;
    history: ChatTurnDto[];
    list: { activeId: string | null; sessions: ChatSessionMetaDto[] };
  }>;
  pinChatSession: (id: string) => Promise<{
    sessions: ChatSessionMetaDto[];
    list: { activeId: string | null; sessions: ChatSessionMetaDto[] };
  }>;
  setMode: (mode: AgentMode, sessionId?: string) => Promise<AgentMode>;
  /** Persist queued (not yet executed) messages for a session so they survive restarts. */
  setQueuedMessages: (messages: Array<{ text: string; attachments?: ChatAttachmentDto[] }>, sessionId?: string) => Promise<Array<{ text: string; attachments?: ChatAttachmentDto[] }>>;
  approvePlan: (opts?: {
    path?: string;
    content?: string;
    title?: string;
    tasks?: TaskItemDto[];
  }, sessionId?: string) => Promise<{
    mode: AgentMode;
    activePlanPath: string | null;
    lastPlanPath: string | null;
  }>;
  clearActivePlan: (sessionId?: string) => Promise<{ activePlanPath: string | null }>;
  getActivePlan: (sessionId?: string) => Promise<ActivePlanMetaDto | null>;
  updateTask: (taskId: string, status: TaskStatusDto, result?: string, sessionId?: string) => Promise<ActivePlanMetaDto | null>;
  setTodoAnchor: (todo: string | null) => Promise<unknown>;
  compactHistory: (sessionId?: string) => Promise<ChatTurnDto[]>;
  wipeSession: () => Promise<{ history: ChatTurnDto[]; terminal: TerminalEntryDto[] }>;
  listCheckpoints: () => Promise<CheckpointInfoDto[]>;
  rollbackCheckpoint: (id?: string, sessionId?: string) => Promise<{
    restored: string[];
    checkpointId: string;
    history: ChatTurnDto[];
  }>;
  getPendingChanges: (sessionId?: string) => Promise<PendingChangesDto>;
  keepAllChanges: (sessionId?: string) => Promise<PendingChangesDto>;
  keepChange: (path: string, sessionId?: string) => Promise<PendingChangesDto>;
  undoChange: (path: string, sessionId?: string) => Promise<PendingChangesDto>;
  undoAllChanges: (sessionId?: string) => Promise<{
    restored: string[];
    checkpointId: string;
    history: ChatTurnDto[];
    changes: PendingChangesDto;
  }>;
  getGitStatus: (workspaceRoot?: string) => Promise<GitStatusDto>;
  listMcpTools: () => Promise<McpToolDto[]>;
  listPlans: (sessionId?: string) => Promise<PlanInfoDto[]>;
  readPlan: (path: string) => Promise<string>;
  listRules: () => Promise<RuleFileDto[]>;
  readRule: (name: string) => Promise<string>;
  writeRule: (name: string, content: string) => Promise<RuleFileDto>;
  deleteRule: (name: string) => Promise<boolean>;
  getCombinedRules: () => Promise<string>;
  restoreProjectContext: () => Promise<{ rules: number; memories: number }>;
  getTerminalLog: (sessionId?: string) => Promise<TerminalEntryDto[]>;
  clearTerminal: () => Promise<boolean>;
  /** Spawn an interactive PTY; resolves to a terminal id. */
  createTerminal: (opts?: { cols?: number; rows?: number }) => Promise<string>;
  writeTerminal: (id: string, data: string) => void;
  resizeTerminal: (id: string, cols: number, rows: number) => void;
  killTerminal: (id: string) => void;
  onTerminalData: (handler: (ev: { id: string; data: string }) => void) => () => void;
  onTerminalExit: (handler: (ev: { id: string; code: number }) => void) => () => void;
  getIndexStatus: () => Promise<IndexStatus>;
  getRepoMap: () => Promise<string>;
  rebuildIndex: () => Promise<IndexStatus>;
  openPath: (path: string) => Promise<string>;
  getSettings: () => Promise<SettingsSnapshotDto>;
  saveSettings: (config: SystemWorkflowConfig) => Promise<SettingsSnapshotDto>;
  exportModelSettings: () => Promise<{ status: "success" | "cancelled"; filePath?: string; count?: number }>;
  importModelSettings: () => Promise<
    | { status: "cancelled" }
    | { status: "success"; added: number; skipped: number; invalid: number; snapshot: SettingsSnapshotDto }
    | { status: "error"; added: number; skipped: number; invalid: number; message: string }
  >;
  restoreFactorySettings: () => Promise<SettingsSnapshotDto>;
  restorePipelineSettings: (mode: "plan" | "agent") => Promise<SettingsSnapshotDto>;
  /** Translate a system prompt to English for runtime use. */
  translatePrompt: (text: string, target?: "en" | "zh") => Promise<string>;
  getSecrets: () => Promise<SecretsDto>;
  setLlmApiKey: (apiKey: string | null) => Promise<SecretsDto>;
  pickAndPreviewRedaction: () => Promise<RedactionPreviewDto>;
  searchWorkspaceFiles: (query: string) => Promise<string[]>;
  /** List one directory under a project root. Paths are relative to root. */
  listWorkspaceDir: (root: string, relPath?: string) => Promise<WorkspaceDirEntryDto[]>;
  showWorkspacePathInFolder: (root: string, relPath: string) => Promise<void>;
  readWorkspaceFile: (path: string) => Promise<string>;
  writeWorkspaceFile: (path: string, content: string) => Promise<{ path: string }>;
  getLlmAuthStatus: () => Promise<LlmAuthStatusDto>;
  getChatHistory: (sessionId?: string) => Promise<ChatTurnDto[]>;
  getChatHistoryPage: (sessionId: string, beforeSeq?: number, limit?: number) => Promise<ChatHistoryPageDto>;
  clearChat: (sessionId?: string) => Promise<boolean>;
  cancelChat: (sessionId?: string) => Promise<boolean>;
  /** Delete one complete turn (user input + its reply) from a session. */
  deleteChatTurn: (turnId: string, sessionId?: string) => Promise<boolean>;
  uploadFile: (input: { name: string; type: string; data: Uint8Array; provider?: string }) => Promise<{
    url: string;
    name: string;
    size: number;
    provider: string;
  }>;
  sendChat: (text: string, sessionId?: string, attachments?: ChatAttachmentDto[]) => Promise<
    | {
        ok: true;
        assistantText: string;
        history: ChatTurnDto[];
        lastPlanPath?: string;
        lastCheckpointId?: string | null;
        sessionId: string | null;
        sessionTitle: string | null;
      }
    | {
        ok: false;
        error: string;
        history: ChatTurnDto[];
        sessionId: string | null;
        sessionTitle: string | null;
      }
  >;
  regenerateChat: (sessionId?: string) => Promise<
    | {
        ok: true;
        assistantText: string;
        history: ChatTurnDto[];
        lastPlanPath?: string;
        lastCheckpointId?: string | null;
        sessionId: string | null;
        sessionTitle: string | null;
      }
    | {
        ok: false;
        error: string;
        history: ChatTurnDto[];
        sessionId: string | null;
        sessionTitle: string | null;
      }
  >;
  onChatEvent: (handler: (payload: { sessionId: string | null; ev: ChatEventDto }) => void) => () => void;
  respondDangerousCommand: (requestId: string, allowed: boolean) => void;
  onDangerousCommandRequest: (handler: (request: DangerousCommandRequestDto) => void) => () => void;
  /** Return the user's answer (selected option value or free text; empty = cancelled) for an ask_user prompt. */
  respondAskUser: (requestId: string, answer: string) => void;
  onAskUserRequest: (handler: (request: AskUserRequestDto) => void) => () => void;
  onWorkspaceRestored: (
    handler: (ev: { root: string; name: string; sessionRestored: boolean }) => void,
  ) => () => void;
  /** Fetch available models from a provider endpoint. */
  fetchModelList: (
    baseUrl: string,
    apiKey?: string,
    apiFormat?: "openai-chat" | "openai-responses" | "anthropic-messages" | "google-gemini",
  ) => Promise<{ ok: true; models: { id: string; name: string }[] } | { ok: false; error: string }>;
  /** Notify the main process that the settings panel opened/closed. */
  setSettingsPanelOpen: (open: boolean) => void;
  /** Sync frameless window chrome (titleBarOverlay / background) with UI theme. */
  setChromeTheme: (theme: "dark" | "codex") => Promise<void>;
  /** 界面语言信息：系统区域设置 + 用户偏好（"system" 跟随系统）。 */
  getLocaleInfo: () => Promise<{ osLocale: string; pref: "system" | "zh" | "en" }>;
  /** 设置界面语言偏好；主进程对话框文案同步生效。 */
  setLocaleOverride: (pref: "system" | "zh" | "en") => Promise<void>;
  /** Ask the main process to focus and raise this window (restores OS focus). */
  focusWindow: () => void;
  /** Subscribe to a request from main to close the settings panel. */
  onCloseSettingsPanel: (callback: () => void) => () => void;
  listMemories: (scope?: string) => Promise<UserMemoryDto[]>;
  addMemory: (m: { title: string; content: string; category?: string; keywords?: string[] }, scope?: string) => Promise<UserMemoryDto | null>;
  updateMemory: (id: string, patch: Partial<{ title: string; content: string; category: string; keywords: string[] }>, scope?: string) => Promise<UserMemoryDto | null>;
  deleteMemory: (id: string, scope?: string) => Promise<boolean>;
  /** 检查 Gitee 上是否有新版本（可手动触发；请求由主进程发出）。 */
  checkForUpdate: () => Promise<UpdateCheckOutcomeDto>;
  /** 用系统默认浏览器打开更新地址（安装包直链或发布页）。 */
  openUpdateDownload: (url: string) => void;
  /** 订阅主进程"发现新版本"的推送。返回取消订阅函数。 */
  onUpdateAvailable: (handler: (info: UpdateInfoDto) => void) => () => void;
  /** 后台下载新版本安装包（仅打包版 Windows 可用）；成功返回 true。 */
  startUpdateDownload: () => Promise<boolean>;
  /** 静默安装已下载的更新并重启应用；未下载完成时忽略。 */
  installUpdate: () => void;
  /** 订阅下载进度/完成/失败状态。返回取消订阅函数。 */
  onUpdateDownloadStatus: (handler: (status: UpdateDownloadStatusDto) => void) => () => void;
  getCodemapStatus: () => Promise<CodemapStatusDto>;
  buildCodemap: () => Promise<CodemapStatusDto>;
  searchCodemap: (query: string, limit?: number) => Promise<CodemapSearchHitDto[]>;
  analyzeCodemapImpact: (query: string, depth?: number) => Promise<CodemapImpactDto>;
}

const api: DesktopApi = {
  openWorkspaceDialog: () => ipcRenderer.invoke("workspace:openDialog"),
  openWorkspacePath: (root) => ipcRenderer.invoke("workspace:openPath", root),
  switchWorkspacePath: (root) => ipcRenderer.invoke("workspace:switchPath", root),
  reopenLastWorkspace: () => ipcRenderer.invoke("workspace:reopenLast"),
  getRecentWorkspace: () => ipcRenderer.invoke("workspace:getRecent"),
  listProjects: () => ipcRenderer.invoke("workspace:listProjects"),
  moveProject: (root, targetRoot, after) => ipcRenderer.invoke("workspace:moveProject", root, targetRoot, after),
  removeProject: (root: string) => ipcRenderer.invoke("workspace:removeProject", root),
  getWorkspace: () => ipcRenderer.invoke("workspace:get"),
  getAppVersion: () => ipcRenderer.invoke("app:version"),
  getSessionState: () => ipcRenderer.invoke("session:getState"),
  listChatSessions: (root?) => ipcRenderer.invoke("sessions:list", root),
  createChatSession: (title) => ipcRenderer.invoke("sessions:create", title),
  switchChatSession: (id, projectRoot) => ipcRenderer.invoke("sessions:switch", id, projectRoot),
  deleteChatSession: (id, projectRoot) => ipcRenderer.invoke("sessions:delete", id, projectRoot),
  pinChatSession: (id) => ipcRenderer.invoke("sessions:pin", id),
  setMode: (mode, sessionId) => ipcRenderer.invoke("session:setMode", mode, sessionId),
  setQueuedMessages: (messages, sessionId) => ipcRenderer.invoke("session:setQueuedMessages", messages, sessionId),
  approvePlan: (opts, sessionId) => ipcRenderer.invoke("session:approvePlan", opts, sessionId),
  clearActivePlan: (sessionId) => ipcRenderer.invoke("session:clearActivePlan", sessionId),
  getActivePlan: (sessionId?: string) => ipcRenderer.invoke("session:getActivePlan", sessionId),
  updateTask: (taskId, status, result, sessionId) => ipcRenderer.invoke("session:updateTask", taskId, status, result, sessionId),
  setTodoAnchor: (todo) => ipcRenderer.invoke("session:setTodoAnchor", todo),
  compactHistory: (sessionId) => ipcRenderer.invoke("session:compact", sessionId),
  wipeSession: () => ipcRenderer.invoke("session:wipe"),
  listCheckpoints: () => ipcRenderer.invoke("session:listCheckpoints"),
  rollbackCheckpoint: (id, sessionId) => ipcRenderer.invoke("session:rollback", id, sessionId),
  getPendingChanges: (sessionId) => ipcRenderer.invoke("changes:pending", sessionId),
  keepAllChanges: (sessionId) => ipcRenderer.invoke("changes:keepAll", sessionId),
  keepChange: (path, sessionId) => ipcRenderer.invoke("changes:keep", path, sessionId),
  undoChange: (path, sessionId) => ipcRenderer.invoke("changes:undo", path, sessionId),
  undoAllChanges: (sessionId) => ipcRenderer.invoke("changes:undoAll", sessionId),
  getGitStatus: (workspaceRoot?: string) => ipcRenderer.invoke("git:status", workspaceRoot),
  listMcpTools: () => ipcRenderer.invoke("mcp:listTools"),
  listPlans: (sessionId?: string) => ipcRenderer.invoke("plans:list", sessionId),
  readPlan: (path) => ipcRenderer.invoke("plans:read", path),
  listRules: () => ipcRenderer.invoke("rules:list"),
  readRule: (name) => ipcRenderer.invoke("rules:read", name),
  writeRule: (name, content) => ipcRenderer.invoke("rules:write", name, content),
  deleteRule: (name) => ipcRenderer.invoke("rules:delete", name),
  getCombinedRules: () => ipcRenderer.invoke("rules:combined"),
  restoreProjectContext: () => ipcRenderer.invoke("project:restoreContext"),
  getTerminalLog: (sessionId?) => ipcRenderer.invoke("terminal:log", sessionId),
  clearTerminal: () => ipcRenderer.invoke("terminal:clear"),
  createTerminal: (opts) => ipcRenderer.invoke("pty:create", opts),
  writeTerminal: (id, data) => ipcRenderer.send("pty:input", id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send("pty:resize", id, cols, rows),
  killTerminal: (id) => ipcRenderer.send("pty:kill", id),
  onTerminalData: (handler) => {
    const listener = (_: Electron.IpcRendererEvent, ev: { id: string; data: string }) => handler(ev);
    ipcRenderer.on("pty:data", listener);
    return () => ipcRenderer.removeListener("pty:data", listener);
  },
  onTerminalExit: (handler) => {
    const listener = (_: Electron.IpcRendererEvent, ev: { id: string; code: number }) => handler(ev);
    ipcRenderer.on("pty:exit", listener);
    return () => ipcRenderer.removeListener("pty:exit", listener);
  },
  getIndexStatus: () => ipcRenderer.invoke("index:status"),
  getRepoMap: () => ipcRenderer.invoke("index:repoMap"),
  rebuildIndex: () => ipcRenderer.invoke("index:rebuild"),
  openPath: (path) => ipcRenderer.invoke("shell:openPath", path),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (config) => ipcRenderer.invoke("settings:save", config),
  exportModelSettings: () => ipcRenderer.invoke("settings:exportModels"),
  importModelSettings: () => ipcRenderer.invoke("settings:importModels"),
  restoreFactorySettings: () => ipcRenderer.invoke("settings:restoreFactory"),
  restorePipelineSettings: (mode) => ipcRenderer.invoke("settings:restorePipeline", mode),
  translatePrompt: (text, target) => ipcRenderer.invoke("llm:translatePrompt", text, target),
  getSecrets: () => ipcRenderer.invoke("secrets:get"),
  setLlmApiKey: (apiKey) => ipcRenderer.invoke("secrets:setLlmApiKey", apiKey),
  pickAndPreviewRedaction: () => ipcRenderer.invoke("security:pickAndPreview"),
  searchWorkspaceFiles: (query) => ipcRenderer.invoke("workspace:searchFiles", query),
  listWorkspaceDir: (root, relPath) => ipcRenderer.invoke("workspace:listDir", root, relPath ?? ""),
  showWorkspacePathInFolder: (root, relPath) => ipcRenderer.invoke("workspace:showInFolder", root, relPath),
  readWorkspaceFile: (path) => ipcRenderer.invoke("workspace:readFile", path),
  writeWorkspaceFile: (path, content) => ipcRenderer.invoke("workspace:writeFile", path, content),
  getLlmAuthStatus: () => ipcRenderer.invoke("llm:authStatus"),
  getChatHistory: (sessionId) => ipcRenderer.invoke("chat:history", sessionId),
  getChatHistoryPage: (sessionId, beforeSeq, limit) => ipcRenderer.invoke("chat:historyPage", sessionId, beforeSeq, limit),
  clearChat: (sessionId) => ipcRenderer.invoke("chat:clear", sessionId),
  cancelChat: (sessionId) => ipcRenderer.invoke("chat:cancel", sessionId),
  deleteChatTurn: (turnId, sessionId) => ipcRenderer.invoke("chat:deleteTurn", turnId, sessionId),
  fetchModelList: (baseUrl: string, apiKey?: string, apiFormat?: "openai-chat" | "openai-responses" | "anthropic-messages" | "google-gemini") =>
    ipcRenderer.invoke("models:fetchList", baseUrl, apiKey, apiFormat),
  setSettingsPanelOpen: (open: boolean) => ipcRenderer.send("app:settingsPanelState", open),
  setChromeTheme: (theme) => ipcRenderer.invoke("app:setChromeTheme", theme),
  getLocaleInfo: () => ipcRenderer.invoke("app:getLocaleInfo"),
  setLocaleOverride: (pref) => ipcRenderer.invoke("app:setLocaleOverride", pref),
  focusWindow: () => ipcRenderer.send("app:focusWindow"),
  onCloseSettingsPanel: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("app:closeSettingsPanel", handler);
    return () => ipcRenderer.removeListener("app:closeSettingsPanel", handler);
  },
  uploadFile: (input) => ipcRenderer.invoke("upload:file", input),
  sendChat: (text, sessionId, attachments) => ipcRenderer.invoke("chat:send", text, attachments, sessionId),
  regenerateChat: (sessionId) => ipcRenderer.invoke("chat:regenerate", sessionId),
  onChatEvent: (handler) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { sessionId: string | null; ev?: ChatEventDto; events?: ChatEventDto[] }) => {
      if (Array.isArray(payload.events)) {
        for (const ev of payload.events) handler({ sessionId: payload.sessionId, ev });
        return;
      }
      if (payload.ev) handler({ sessionId: payload.sessionId, ev: payload.ev });
    };
    ipcRenderer.on("chat:event", listener);
    return () => ipcRenderer.removeListener("chat:event", listener);
  },
  respondDangerousCommand: (requestId, allowed) => {
    ipcRenderer.send("security:dangerousCommandResponse", requestId, allowed);
  },
  onDangerousCommandRequest: (handler) => {
    const listener = (_: Electron.IpcRendererEvent, request: DangerousCommandRequestDto) => handler(request);
    ipcRenderer.on("security:dangerousCommandRequest", listener);
    return () => ipcRenderer.removeListener("security:dangerousCommandRequest", listener);
  },
  respondAskUser: (requestId, answer) => {
    ipcRenderer.send("ask:response", requestId, answer);
  },
  onAskUserRequest: (handler) => {
    const listener = (_: Electron.IpcRendererEvent, request: AskUserRequestDto) => handler(request);
    ipcRenderer.on("ask:request", listener);
    return () => ipcRenderer.removeListener("ask:request", listener);
  },
  onWorkspaceRestored: (handler) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      ev: { root: string; name: string; sessionRestored: boolean },
    ) => handler(ev);
    ipcRenderer.on("workspace:restored", listener);
    return () => ipcRenderer.removeListener("workspace:restored", listener);
  },
  listMemories: (scope) => ipcRenderer.invoke("memories:list", scope),
  addMemory: (m, scope) => ipcRenderer.invoke("memories:add", m, scope),
  updateMemory: (id, patch, scope) => ipcRenderer.invoke("memories:update", id, patch, scope),
  deleteMemory: (id, scope) => ipcRenderer.invoke("memories:delete", id, scope),
  checkForUpdate: () => ipcRenderer.invoke("updates:check"),
  openUpdateDownload: (url) => ipcRenderer.send("updates:open", url),
  onUpdateAvailable: (handler) => {
    const listener = (_: Electron.IpcRendererEvent, info: UpdateInfoDto) => handler(info);
    ipcRenderer.on("updates:available", listener);
    return () => ipcRenderer.removeListener("updates:available", listener);
  },
  startUpdateDownload: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.send("updates:install"),
  onUpdateDownloadStatus: (handler) => {
    const listener = (_: Electron.IpcRendererEvent, status: UpdateDownloadStatusDto) => handler(status);
    ipcRenderer.on("updates:downloadStatus", listener);
    return () => ipcRenderer.removeListener("updates:downloadStatus", listener);
  },
  getCodemapStatus: () => ipcRenderer.invoke("index:codemapStatus"),
  buildCodemap: () => ipcRenderer.invoke("index:codemapBuild"),
  searchCodemap: (query: string, limit = 20) => ipcRenderer.invoke("index:codemapSearch", query, limit),
  analyzeCodemapImpact: (query: string, depth = 3) => ipcRenderer.invoke("index:codemapImpact", query, depth),
};

contextBridge.exposeInMainWorld("owncoder", api);

export type CodemapStatusDto = {
  root?: string;
  databasePath?: string;
  ready: boolean;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  lastBuildMs?: number;
  message: string;
};

export type CodemapNodeDto = {
  id: string;
  name: string;
  qualifiedName?: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  language: string;
  exported?: boolean;
  depth?: number;
};

export type CodemapSearchHitDto = { node: CodemapNodeDto; score: number; summary?: string };

export type CodemapImpactDto = {
  focal: CodemapNodeDto;
  callers: CodemapNodeDto[];
  callees: CodemapNodeDto[];
  likelyTests: CodemapNodeDto[];
  directCallers: number;
  transitiveCallers: number;
  riskLevel: "low" | "medium" | "high";
  riskScore: number;
  explanation: string;
};

/** Codemap 方法通过声明合并并入 DesktopApi（与上方主接口共存）。 */
export interface DesktopApi {
  getCodemapStatus: () => Promise<CodemapStatusDto>;
  buildCodemap: () => Promise<CodemapStatusDto>;
  searchCodemap: (query: string, limit?: number) => Promise<CodemapSearchHitDto[]>;
  analyzeCodemapImpact: (query: string, depth?: number) => Promise<CodemapImpactDto>;
}
