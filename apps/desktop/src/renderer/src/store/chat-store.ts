/**
 * Chat store — history, streaming, pending tools, thinking blocks.
 *
 * Multi-session concurrent architecture: each session has its own runtime
 * (history/sending/queue/liveEvents/terminal/liveStatus/errorAlert)
 * stored in `bySession`. The top-level view fields mirror the focus session
 * (`activeSessionId`) so existing components keep reading `s.history`/`s.sending`
 * unchanged. Mutators accept an optional `sessionId` — when it targets a
 * background session they update `bySession[sid]` directly, leaving the focus
 * view untouched.
 */
import { create } from "zustand";
import type { AppError, TaskDecompositionDto } from "@owncoder/shared";
import type { ChatTurnDto, ChatAttachmentDto, DangerousCommandRequestDto, AskUserRequestDto, TerminalEntryDto } from "../../../preload/index";

export interface QueuedMessageDto {
  text: string;
  attachments?: ChatAttachmentDto[];
}

// ── Live-event types ──────────────────────────────────────────────────────────

export interface PendingTool {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error" | "skipped";
  output?: string;
}

/**
 * MessagePart - 结构化消息部件（镜像后端类型）
 */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/**
 * MessageMetadata - 消息元数据（镜像后端类型）
 */
export interface MessageMetadata {
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

function newLiveEventId(prefix = "le"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A single unit in the current-turn activity stream. */
export type LiveEvent =
  | { kind: "thinking"; id: string; text: string; streaming: boolean; stage?: "decompose" | "react" }
  | { kind: "tool";     tool: PendingTool }
  | { kind: "text";     id: string; text: string; streaming: boolean }
  /** Task-decomposition result from the task_decompose stage (one per turn). */
  | { kind: "decompose"; id: string; decomposition: DecompositionSnapshot }
  /** Explore 子智能体的工具流分组：内部工具只在该组内增删。 */
  | { kind: "subagent"; group: SubagentGroup }
  /** Complete structured message from turn_complete event (阶段三). */
  | { kind: "structured"; id: string; parts: MessagePart[]; metadata: MessageMetadata };

/** Explore 子智能体分组状态。 */
export interface SubagentGroup {
  /** 子智能体阶段 id（与 stage_start/stage_done 的 id 相同）。 */
  id: string;
  agentType: string;
  task: string;
  tools: PendingTool[];
  status: "running" | "done" | "error";
  /** stage_done 带回的节点文字报告（完成/失败摘要），展开卡片时展示。 */
  report?: string;
}

export type DecompositionSnapshot = TaskDecompositionDto;

// ── Per-session runtime ───────────────────────────────────────────────────────

/** Sidebar status icon state for a session. */
export type SessionStatus = "idle" | "running" | "completed" | "needs_confirmation";

/** 任务运行可观测性指标（阶段四）。 */
export interface TaskRunMetricsSnapshot {
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

/** Snapshot of unified TaskRunState mirrored from core via task_run_state events. */
export interface TaskRunSnapshot {
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
  metrics?: TaskRunMetricsSnapshot;
  totalDurationMs?: number;
}

export interface ChatSessionRuntime {
  history: ChatTurnDto[];
  historyBeforeSeq: number | null;
  historyHasMore: boolean;
  historyLoading: boolean;
  sending: boolean;
  queuedMessages: QueuedMessageDto[];
  liveEvents: LiveEvent[];
  terminal: TerminalEntryDto[];
  liveStatus: string;
  errorAlert: AppError | null;
  /** Latest task-run phase snapshot for this session (from task_run_state events). */
  taskRun: TaskRunSnapshot | null;
  /** Pending dangerous-command confirmation requests for this session. */
  dangerousConfirmations: DangerousCommandRequestDto[];
  /** Pending ask_user prompts awaiting the user's answer for this session. */
  askRequests: AskUserRequestDto[];
  /** Sidebar status icon state. `running` mirrors `sending` but is kept as a
   * separate field so the sidebar can read it without coupling to turn lifecycle. */
  status: SessionStatus;
  /** Current stage (task_decompose or react loop) for coloring thinking blocks. */
  currentStage: "decompose" | "react" | null;
  /**
   * True 表示用户已点击「停止」、主进程正在 abort 当前轮。此窗口内乐观
   * 用户行还没有 turnId，需要单独给出删除入口（正常发送中不显示删除）。
   */
  stopping: boolean;
  /**
   * True 表示当前 in-flight 轮已被用户在「正在停止…」窗口请求删除。
   * 主进程此刻正在把该轮以 cancelled 落盘，渲染端乐观行还没有 turnId；
   * 待 sendChat 返回、applyChatResult 拿到持久化 history 后，据此标志
   * 定位 turnId 并真正整轮删除（deleteTurnPair）。
   */
  pendingDelete: boolean;
}

function dedupeHistoryTurns(turns: ChatTurnDto[]): ChatTurnDto[] {
  const seen = new Set<string>();
  return turns.filter((turn) => {
    if (!turn.id) return true;
    const key = `${turn.role}:${turn.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyRuntime(): ChatSessionRuntime {
  return {
    history: [],
    historyBeforeSeq: null,
    historyHasMore: false,
    historyLoading: false,
    sending: false,
    queuedMessages: [],
    liveEvents: [],
    terminal: [],
    liveStatus: "",
    errorAlert: null,
    taskRun: null,
    dangerousConfirmations: [],
    askRequests: [],
    status: "idle",
    currentStage: null,
    stopping: false,
    pendingDelete: false,
  };
}

// ── Pure live-event helpers (operate on a LiveEvent[]) ────────────────────────

function pushThinkingFn(events: LiveEvent[], stage?: "decompose" | "react"): LiveEvent[] {
  return [...events, { kind: "thinking", id: newLiveEventId("think"), text: "", streaming: true, stage }];
}

function updateThinkingFn(events: LiveEvent[], text: string): LiveEvent[] {
  const out = events.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.kind === "thinking") {
      const prev = out[i] as Extract<LiveEvent, { kind: "thinking" }>;
      out[i] = { kind: "thinking", id: prev.id, text, streaming: true, stage: prev.stage };
      return out;
    }
  }
  return [...out, { kind: "thinking", id: newLiveEventId("think"), text, streaming: true }];
}

export function sealThinkingFn(events: LiveEvent[]): LiveEvent[] {
  const out = events.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i]!;
    if (e.kind === "thinking" && e.streaming) {
      out[i] = { ...e, streaming: false };
      return out;
    }
  }
  return out;
}

export function upsertThinkingFn(events: LiveEvent[], text: string, stage?: "decompose" | "react"): LiveEvent[] {
  const out = events.slice();
  const last = out[out.length - 1];
  if (last?.kind === "thinking") {
    out[out.length - 1] = { kind: "thinking", id: last.id, text, streaming: true, stage: last.stage || stage };
    return out;
  }
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i]!;
    if (e.kind === "text" && e.streaming) {
      out[i] = { ...e, streaming: false };
      break;
    }
  }
  out.push({ kind: "thinking", id: newLiveEventId("think"), text, streaming: true, stage });
  return out;
}

export function pushToolFn(events: LiveEvent[], tool: PendingTool): LiveEvent[] {
  return [...events, { kind: "tool", tool }];
}

export function updateToolFn(events: LiveEvent[], id: string, patch: Partial<PendingTool>): LiveEvent[] {
  return events.map((e) =>
    e.kind === "tool" && e.tool.id === id
      ? { ...e, tool: { ...e.tool, ...patch } }
      : e,
  );
}

// ── Subagent group helpers ────────────────────────────────────────────────────

/** 若对应分组尚不存在则创建（空工具、运行中）。 */
export function ensureSubagentGroupFn(
  events: LiveEvent[],
  input: { id: string; agentType: string; task: string },
): LiveEvent[] {
  if (events.some((e) => e.kind === "subagent" && e.group.id === input.id)) return events;
  return [
    ...events,
    {
      kind: "subagent",
      group: { id: input.id, agentType: input.agentType, task: input.task, tools: [], status: "running" },
    },
  ];
}

function mapSubagentGroup(
  events: LiveEvent[],
  id: string,
  map: (group: SubagentGroup) => SubagentGroup,
): LiveEvent[] {
  return events.map((e) =>
    e.kind === "subagent" && e.group.id === id ? { ...e, group: map(e.group) } : e,
  );
}

/** 向子智能体分组追加一个运行中的工具。 */
export function pushSubagentToolFn(
  events: LiveEvent[],
  groupId: string,
  tool: PendingTool,
): LiveEvent[] {
  return mapSubagentGroup(events, groupId, (group) => ({
    ...group,
    tools: [...group.tools, tool],
  }));
}

/** 更新子智能体分组内某个工具的状态/输出；工具失败时把分组标记为 error。 */
export function updateSubagentToolFn(
  events: LiveEvent[],
  groupId: string,
  toolId: string,
  patch: Partial<PendingTool>,
): LiveEvent[] {
  return mapSubagentGroup(events, groupId, (group) => {
    const tools = group.tools.map((tool) =>
      tool.id === toolId ? { ...tool, ...patch } : tool,
    );
    // 不因单个工具失败把整组标 error：工具失败后 LLM 下一步会自行修正再调，
    // 组的终态改由 stage_done（节点成败）决定。
    return { ...group, tools };
  });
}

/** 设置子智能体分组的整体状态（阶段结束时收口），可附带节点报告。 */
export function setSubagentGroupStatusFn(
  events: LiveEvent[],
  groupId: string,
  status: SubagentGroup["status"],
  report?: string,
): LiveEvent[] {
  return mapSubagentGroup(events, groupId, (group) => ({
    ...group,
    status,
    ...(report !== undefined ? { report } : {}),
  }));
}

export function upsertTextFn(events: LiveEvent[], text: string): LiveEvent[] {
  const out = events.slice();
  const last = out[out.length - 1];
  if (last?.kind === "text") {
    out[out.length - 1] = { kind: "text", id: last.id, text, streaming: true };
    return out;
  }
  return [...out, { kind: "text", id: newLiveEventId("text"), text, streaming: true }];
}

export function sealTextFn(events: LiveEvent[]): LiveEvent[] {
  const out = events.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i]!;
    if (e.kind === "text" && e.streaming) {
      out[i] = { ...e, streaming: false };
      return out;
    }
  }
  return out;
}

function sealAllStreamingFn(events: LiveEvent[]): LiveEvent[] {
  return events.map((e) => {
    if (e.kind === "thinking") return { ...e, streaming: false };
    if (e.kind === "text") return { ...e, streaming: false };
    return e;
  });
}

const MAX_LIVE_EVENTS = 120;
const MAX_LIVE_TEXT = 64 * 1024;
const MAX_TOOL_OUTPUT = 32 * 1024;

function boundLiveEvent(event: LiveEvent): LiveEvent {
  if (event.kind === "thinking" || event.kind === "text") {
    return event.text.length > MAX_LIVE_TEXT
      ? { ...event, text: event.text.slice(-MAX_LIVE_TEXT) }
      : event;
  }
  if (event.kind === "tool" && event.tool.output && event.tool.output.length > MAX_TOOL_OUTPUT) {
    return { ...event, tool: { ...event.tool, output: event.tool.output.slice(-MAX_TOOL_OUTPUT) } };
  }
  if (event.kind === "subagent") {
    const bounded = event.group.tools.some(
      (tool) => tool.output && tool.output.length > MAX_TOOL_OUTPUT,
    );
    if (!bounded) return event;
    return {
      ...event,
      group: {
        ...event.group,
        tools: event.group.tools.map((tool) =>
          tool.output && tool.output.length > MAX_TOOL_OUTPUT
            ? { ...tool, output: tool.output.slice(-MAX_TOOL_OUTPUT) }
            : tool,
        ),
      },
    };
  }
  return event;
}

function boundLiveEvents(events: LiveEvent[]): LiveEvent[] {
  const normalized = events.map(boundLiveEvent);
  if (normalized.length <= MAX_LIVE_EVENTS) return normalized;
  const keep = normalized.slice(-MAX_LIVE_EVENTS);
  // Keep the decomposition card even when the stream is truncated.
  const decomposition = normalized.find((event) => event.kind === "decompose");
  if (decomposition && !keep.some((event) => event.kind === "decompose")) {
    keep[0] = decomposition;
  }
  return keep;
}


export interface ChatState {
  // Focus-session view (mirrors bySession[activeSessionId])
  history: ChatTurnDto[];
  historyBeforeSeq: number | null;
  historyHasMore: boolean;
  historyLoading: boolean;
  sending: boolean;
  queuedMessages: QueuedMessageDto[];
  liveEvents: LiveEvent[];
  terminal: TerminalEntryDto[];
  liveStatus: string;
  errorAlert: AppError | null;
  taskRun: TaskRunSnapshot | null;
  dangerousConfirmations: DangerousCommandRequestDto[];
  askRequests: AskUserRequestDto[];
  currentStage: "decompose" | "react" | null;
  /** 与 bySession[focus].stopping/pendingDelete 同步的焦点镜像。 */
  stopping: boolean;
  pendingDelete: boolean;
  status: SessionStatus;

  // Per-session storage + focus pointer
  activeSessionId: string | null;
  bySession: Record<string, ChatSessionRuntime>;

  // Focus/session management
  setActiveSession: (id: string | null) => void;
  ensureSession: (id: string) => void;
  isSessionSending: (id: string) => boolean;
  /** Drop a session's runtime (e.g. after deletion). */
  dropSession: (id: string) => void;
  /**
   * Drop idle session runtimes to bound multi-session heap growth.
   * Always keeps `activeSessionId` and any ids in `keepIds`.
   * Sessions that are still sending / awaiting user input / queued are retained.
   */
  pruneIdleSessions: (keepIds?: string[]) => string[];
}

export interface ChatActions {
  setHistory: (turns: ChatTurnDto[] | ((prev: ChatTurnDto[]) => ChatTurnDto[]), sessionId?: string) => void;
  /** Remove every ChatTurn row belonging to one durable turn (user input + reply pair). */
  removeTurnFromHistory: (turnId: string, sessionId?: string) => void;
  prependHistory: (turns: ChatTurnDto[], beforeSeq: number | null, hasMore: boolean, sessionId?: string) => void;
  setHistoryPageState: (patch: Partial<Pick<ChatSessionRuntime, "historyBeforeSeq" | "historyHasMore" | "historyLoading">>, sessionId?: string) => void;
  setSending: (v: boolean, sessionId?: string) => void;
  /** 标记「正在停止…」窗口：此窗口内允许删除尚无 turnId 的乐观用户行。 */
  setStopping: (v: boolean, sessionId?: string) => void;
  /**
   * 用户在「正在停止…」窗口删除本轮：立即本地移除乐观用户行与已流出的
   * liveEvents，并挂起 pendingDelete，待 sendChat 返回后物理删除落盘轮。
   */
  discardInflightTurn: (sessionId?: string) => void;
  /** abort 收尾、落盘轮处理完毕后复位 pendingDelete / stopping。 */
  clearPendingDelete: (sessionId?: string) => void;
  setQueuedMessages: (msgs: QueuedMessageDto[], sessionId?: string) => void;

  setLiveEvents: (events: LiveEvent[] | ((prev: LiveEvent[]) => LiveEvent[]), sessionId?: string) => void;
  /** Apply multiple live-turn fields in one Zustand transaction. */
  patchLiveState: (patch: Partial<Pick<ChatSessionRuntime, "liveEvents" | "liveStatus" | "terminal" | "currentStage">> | ((prev: ChatSessionRuntime) => Partial<Pick<ChatSessionRuntime, "liveEvents" | "liveStatus" | "terminal" | "currentStage">>), sessionId?: string) => void;

  /** Append structured message from turn_complete event (阶段三). */
  pushStructuredMessage: (parts: MessagePart[], metadata: MessageMetadata, sessionId?: string) => void;

  /** Append the turn's task-decomposition snapshot to the live event stream. */
  pushDecompose: (decomposition: DecompositionSnapshot, sessionId?: string) => void;

  setTerminal: (entries: TerminalEntryDto[] | ((prev: TerminalEntryDto[]) => TerminalEntryDto[]), sessionId?: string) => void;

  setLiveStatus: (status: string, sessionId?: string) => void;
  setErrorAlert: (err: AppError | null, sessionId?: string) => void;
  /** Mirror latest task_run_state event into the session runtime. */
  setTaskRun: (snapshot: TaskRunSnapshot | null, sessionId?: string) => void;

  pushThinking: (sessionId?: string) => void;
  updateThinking: (text: string, sessionId?: string) => void;
  sealThinking: (sessionId?: string) => void;
  upsertThinking: (text: string, sessionId?: string) => void;

  pushTool: (tool: PendingTool, sessionId?: string) => void;
  updateTool: (id: string, patch: Partial<PendingTool>, sessionId?: string) => void;

  upsertText: (text: string, sessionId?: string) => void;
  sealText: (sessionId?: string) => void;

  resetTurnState: (sessionId?: string) => void;
  sealAllStreaming: (sessionId?: string) => void;
  clearAfterDone: (sessionId?: string) => void;

  // ── Dangerous-command confirmation (per-session) ──
  /** Enqueue a dangerous-command confirmation request for a session. */
  pushDangerousConfirmation: (request: DangerousCommandRequestDto, sessionId?: string) => void;
  /** Remove a confirmation request after the user responds. */
  removeDangerousConfirmation: (requestId: string, sessionId?: string) => void;
  /** Enqueue an ask_user prompt for a session. */
  pushAskRequest: (request: AskUserRequestDto, sessionId?: string) => void;
  /** Remove an ask_user prompt after the user answers. */
  removeAskRequest: (requestId: string, sessionId?: string) => void;

  // ── Sidebar status icon (per-session) ──
  /** Mark a session as completed (turn finished). Clears on next turn start. */
  markSessionCompleted: (sessionId?: string) => void;
  /** Mark a session as needing confirmation (dangerous command pending). */
  markSessionNeedsConfirmation: (sessionId?: string) => void;
  /** Clear a non-running status icon (user clicked completed/needs_confirmation). */
  clearSessionStatus: (sessionId?: string) => void;
  /** Read a session's status without subscribing (for sidebar imperative reads). */
  getSessionStatus: (id: string) => SessionStatus;
  /** Reset all sessions to a clean state on app startup. Clears stale
   * `running`/`needs_confirmation` statuses, `sending` flags, and pending
   * dangerous-command confirmations — a freshly opened app cannot have
   * in-flight turns. `completed`/`idle` statuses are preserved. */
  sanitizeAllSessionStatuses: () => void;
}

// ── Store implementation ──────────────────────────────────────────────────────

/** Read the target runtime for a mutator. */
function readRuntime(s: ChatState & ChatActions, sid?: string): ChatSessionRuntime {
  const id = sid ?? s.activeSessionId;
  if (!id || id === s.activeSessionId) {
    return {
      history: s.history,
      historyBeforeSeq: s.historyBeforeSeq,
      historyHasMore: s.historyHasMore,
      historyLoading: s.historyLoading,
      sending: s.sending,
      queuedMessages: s.queuedMessages,
      liveEvents: s.liveEvents,
      terminal: s.terminal,
      liveStatus: s.liveStatus,
      errorAlert: s.errorAlert,
      taskRun: s.taskRun,
      dangerousConfirmations: s.dangerousConfirmations,
      askRequests: s.askRequests,
      currentStage: s.currentStage,
      status: s.status,
      stopping: s.stopping,
      pendingDelete: s.pendingDelete,
    };
  }
  return s.bySession[id] ?? emptyRuntime();
}

/** Build the state patch for a runtime update. When targeting the focus session,
 * update both the view fields and bySession[focus]; otherwise only bySession[sid]. */
function applyRuntime(s: ChatState & ChatActions, sid: string | undefined, patch: Partial<ChatSessionRuntime>): Partial<ChatState & ChatActions> {
  const id = sid ?? s.activeSessionId;
  const boundedPatch = patch.liveEvents ? { ...patch, liveEvents: boundLiveEvents(patch.liveEvents) } : patch;
  if (!id || id === s.activeSessionId) {
    const bySession = s.activeSessionId
      ? { ...s.bySession, [s.activeSessionId]: { ...readRuntime(s, s.activeSessionId), ...boundedPatch } }
      : s.bySession;
    return { ...boundedPatch, bySession };
  }
  const existing = s.bySession[id] ?? emptyRuntime();
  return { bySession: { ...s.bySession, [id]: { ...existing, ...boundedPatch } } };
}

export const useChatStore = create<ChatState & ChatActions>()((set, get) => ({
  history: [],
  historyBeforeSeq: null,
  historyHasMore: false,
  historyLoading: false,
  sending: false,
  queuedMessages: [],
  liveEvents: [],
  terminal: [],
  liveStatus: "",
  errorAlert: null,
  taskRun: null,
  dangerousConfirmations: [],
  askRequests: [],
  currentStage: null,
  stopping: false,
  pendingDelete: false,
  status: "idle",

  activeSessionId: null,
  bySession: {},

  setActiveSession: (id) =>
    set((s) => {
      if (s.activeSessionId === id) return {};
      if (!id) {
        const empty = emptyRuntime();
        return { activeSessionId: null, ...empty };
      }
      const existing = s.bySession[id];
      const rt = existing ?? emptyRuntime();
      return {
        activeSessionId: id,
        history: rt.history,
        historyBeforeSeq: rt.historyBeforeSeq,
        historyHasMore: rt.historyHasMore,
        historyLoading: rt.historyLoading,
        sending: rt.sending,
        queuedMessages: rt.queuedMessages,
        liveEvents: rt.liveEvents,
        terminal: rt.terminal,
        liveStatus: rt.liveStatus,
        errorAlert: rt.errorAlert,
        taskRun: rt.taskRun,
        dangerousConfirmations: rt.dangerousConfirmations,
        askRequests: rt.askRequests,
        currentStage: rt.currentStage,
        stopping: rt.stopping,
        pendingDelete: rt.pendingDelete,
        status: rt.status,
        bySession: existing ? s.bySession : { ...s.bySession, [id]: rt },
      };
    }),

  ensureSession: (id) =>
    set((s) => {
      if (s.bySession[id]) return {};
      return { bySession: { ...s.bySession, [id]: emptyRuntime() } };
    }),

  isSessionSending: (id) => {
    const s = get();
    if (id === s.activeSessionId) return s.sending;
    return s.bySession[id]?.sending ?? false;
  },

  dropSession: (id) =>
    set((s) => {
      const bySession = { ...s.bySession };
      delete bySession[id];
      return { bySession };
    }),

  pruneIdleSessions: (keepIds = []) => {
    const dropped: string[] = [];
    set((s) => {
      const keep = new Set(keepIds.filter(Boolean));
      if (s.activeSessionId) keep.add(s.activeSessionId);
      const bySession = { ...s.bySession };
      for (const [id, rt] of Object.entries(bySession)) {
        if (keep.has(id)) continue;
        // Keep sessions that still have in-flight work or pending user input.
        if (
          rt.sending ||
          rt.status === "running" ||
          rt.status === "needs_confirmation" ||
          (rt.queuedMessages?.length ?? 0) > 0 ||
          (rt.dangerousConfirmations?.length ?? 0) > 0 ||
          (rt.askRequests?.length ?? 0) > 0
        ) {
          continue;
        }
        delete bySession[id];
        dropped.push(id);
      }
      return { bySession };
    });
    return dropped;
  },

  setHistory: (turns, sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      const history = typeof turns === "function" ? turns(rt.history) : turns;
      return applyRuntime(s, sid, { history: dedupeHistoryTurns(history) });
    }),

  removeTurnFromHistory: (turnId, sid) =>
    set((s) => {
      if (!turnId) return {};
      const rt = readRuntime(s, sid);
      // Only the user row carries turnId; its assistant/tool rows follow up
      // to the next user row. Remove by that round boundary.
      const start = rt.history.findIndex((h) => h.role === "user" && h.turnId === turnId);
      if (start < 0) return {};
      let end = start + 1;
      while (end < rt.history.length && rt.history[end]!.role !== "user") end++;
      const history = [...rt.history.slice(0, start), ...rt.history.slice(end)];
      return applyRuntime(s, sid, { history });
    }),

  prependHistory: (turns, beforeSeq, hasMore, sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      const existing = new Set(rt.history.map((t) => `${t.role}:${t.id ?? ""}:${t.content}`));
      const unique = turns.filter((t) => !existing.has(`${t.role}:${t.id ?? ""}:${t.content}`));
      return applyRuntime(s, sid, {
        history: [...unique, ...rt.history],
        historyBeforeSeq: beforeSeq,
        historyHasMore: hasMore,
        historyLoading: false,
      });
    }),

  setHistoryPageState: (patch, sid) => set((s) => applyRuntime(s, sid, patch)),

  setSending: (sending, sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      const patch: Partial<ChatSessionRuntime> = { sending };
      if (sending) {
        // Starting a new turn clears any stale completed/needs_confirmation icon.
        patch.status = "running";
      } else if (rt.status === "running" || rt.status === "needs_confirmation") {
        // Turn finished: correct a stale "running" icon (e.g. done event never
        // arrived) or a lingering "needs_confirmation" badge from an unhandled
        // dangerous-command prompt. Now that sending flips to false, show the
        // completed icon and drop any stale confirmations.
        patch.status = "completed";
        if (rt.dangerousConfirmations.length > 0) {
          patch.dangerousConfirmations = [];
        }
        if (rt.askRequests.length > 0) {
          patch.askRequests = [];
        }
      }
      return applyRuntime(s, sid, patch);
    }),
  setStopping: (stopping, sid) => set((s) => applyRuntime(s, sid, { stopping })),

  discardInflightTurn: (sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      // 定位本轮乐观用户行：最后一条尚无 turnId 的 user（停止窗口里它还没
      // 被持久化行替换）。从该行起的尾部都属于本轮，一并本地移除。
      let start = -1;
      for (let i = rt.history.length - 1; i >= 0; i--) {
        const h = rt.history[i]!;
        if (h.role === "user" && !h.turnId) {
          start = i;
          break;
        }
      }
      const history = start >= 0 ? rt.history.slice(0, start) : rt.history;
      // 立即从界面清除：乐观输入、已流出的 liveEvents、状态与转圈全部清掉，
      // 同时挂起 pendingDelete —— 待 sendChat 返回拿到持久化 turnId 后再
      // 由 applyChatResult 物理删除已落盘的 cancelled 轮，保证刷新无残留。
      return applyRuntime(s, sid, {
        history,
        liveEvents: [],
        liveStatus: "",
        sending: false,
        stopping: true,
        pendingDelete: true,
      });
    }),

  clearPendingDelete: (sid) =>
    set((s) => applyRuntime(s, sid, { pendingDelete: false, stopping: false })),

  setQueuedMessages: (queuedMessages, sid) => set((s) => applyRuntime(s, sid, { queuedMessages })),

  setLiveEvents: (events, sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      const liveEvents = typeof events === "function" ? events(rt.liveEvents) : events;
      return applyRuntime(s, sid, { liveEvents });
    }),

  patchLiveState: (patch, sid) => set((s) => {
    const next = typeof patch === "function" ? patch(readRuntime(s, sid)) : patch;
    return applyRuntime(s, sid, next);
  }),

  pushStructuredMessage: (parts, metadata, sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      return applyRuntime(s, sid, {
        liveEvents: [...rt.liveEvents, { kind: "structured", id: newLiveEventId("structured"), parts, metadata }],
      });
    }),

  pushDecompose: (decomposition, sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      // Replace any existing decomposition so only one card is shown at a time.
      const withoutOld = rt.liveEvents.filter((e) => e.kind !== "decompose");
      return applyRuntime(s, sid, {
        liveEvents: [...withoutOld, { kind: "decompose", id: newLiveEventId("decompose"), decomposition }],
      });
    }),

  setTerminal: (entries, sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      const terminal = typeof entries === "function" ? entries(rt.terminal) : entries;
      return applyRuntime(s, sid, { terminal });
    }),

  setLiveStatus: (liveStatus, sid) => set((s) => applyRuntime(s, sid, { liveStatus })),
  setErrorAlert: (errorAlert, sid) => set((s) => applyRuntime(s, sid, { errorAlert })),
  setTaskRun: (taskRun, sid) => set((s) => applyRuntime(s, sid, { taskRun })),

  // ── Thinking ──

  pushThinking: (sid) =>
    set((s) => applyRuntime(s, sid, { liveEvents: pushThinkingFn(readRuntime(s, sid).liveEvents) })),

  updateThinking: (text, sid) =>
    set((s) => applyRuntime(s, sid, { liveEvents: updateThinkingFn(readRuntime(s, sid).liveEvents, text) })),

  sealThinking: (sid) =>
    set((s) => applyRuntime(s, sid, { liveEvents: sealThinkingFn(readRuntime(s, sid).liveEvents) })),

  upsertThinking: (text, sid) =>
    set((s) => applyRuntime(s, sid, { liveEvents: upsertThinkingFn(readRuntime(s, sid).liveEvents, text) })),

  // ── Tool ──

  pushTool: (tool, sid) =>
    set((s) => applyRuntime(s, sid, { liveEvents: pushToolFn(readRuntime(s, sid).liveEvents, tool) })),

  updateTool: (id, patch, sid) =>
    set((s) => applyRuntime(s, sid, { liveEvents: updateToolFn(readRuntime(s, sid).liveEvents, id, patch) })),

  // ── Text ──

  upsertText: (text, sid) =>
    set((s) => applyRuntime(s, sid, { liveEvents: upsertTextFn(readRuntime(s, sid).liveEvents, text) })),

  sealText: (sid) =>
    set((s) => applyRuntime(s, sid, { liveEvents: sealTextFn(readRuntime(s, sid).liveEvents) })),

  // ── Lifecycle ──

  resetTurnState: (sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      // Preserve decomposition cards so they survive session resets.
      // They'll be replaced when a new task_decomposition event fires.
      const decompositions = rt.liveEvents.filter((e) => e.kind === "decompose");
      return applyRuntime(s, sid, { liveEvents: decompositions, liveStatus: "", errorAlert: null, taskRun: null });
    }),

  sealAllStreaming: (sid) =>
    set((s) => applyRuntime(s, sid, { liveEvents: sealAllStreamingFn(readRuntime(s, sid).liveEvents), liveStatus: "" })),

  clearAfterDone: (sid) => {
    get().sealAllStreaming(sid);
  },

  // ── Dangerous-command confirmation (per-session) ──

  pushDangerousConfirmation: (request, sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      return applyRuntime(s, sid, {
        dangerousConfirmations: [...rt.dangerousConfirmations, request],
      });
    }),

  removeDangerousConfirmation: (requestId, sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      const dangerousConfirmations = rt.dangerousConfirmations.filter((r) => r.requestId !== requestId);
      // If no more confirmations remain and the session isn't running, revert
      // the sidebar icon to completed (the turn finished but was awaiting user
      // input). If still running, stay in needs_confirmation.
      const status: SessionStatus =
        dangerousConfirmations.length === 0
          ? rt.sending ? "running" : "completed"
          : "needs_confirmation";
      return applyRuntime(s, sid, { dangerousConfirmations, status });
    }),

  // ── ask_user prompts (per-session) ──

  pushAskRequest: (request, sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      return applyRuntime(s, sid, {
        askRequests: [...rt.askRequests, request],
      });
    }),

  removeAskRequest: (requestId, sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      const askRequests = rt.askRequests.filter((r) => r.requestId !== requestId);
      return applyRuntime(s, sid, { askRequests });
    }),

  // ── Sidebar status icon (per-session) ──

  markSessionCompleted: (sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      // The "done" event has arrived — the turn is finished. Set the status to
      // "completed" immediately regardless of the `sending` flag. Previously we
      // kept "running" when sending was still true (waiting for setSending(false)
      // to correct it), but that created a window where a completed session
      // showed a spinning icon if the user switched away before setSending(false)
      // ran. The `sending` flag is managed independently by setSending(false).
      const patch: Partial<ChatSessionRuntime> = {
        status: "completed",
      };
      // Any still-pending dangerous-command confirmations are now stale (the
      // main process auto-rejects them on timeout/turn end), so clear them.
      if (rt.dangerousConfirmations.length > 0) {
        patch.dangerousConfirmations = [];
      }
      if (rt.askRequests.length > 0) {
        patch.askRequests = [];
      }
      return applyRuntime(s, sid, patch);
    }),

  markSessionNeedsConfirmation: (sid) =>
    set((s) => applyRuntime(s, sid, { status: "needs_confirmation" })),

  clearSessionStatus: (sid) =>
    set((s) => {
      const rt = readRuntime(s, sid);
      // Only clear non-running statuses; running is managed by setSending.
      if (rt.status === "running") return {};
      return applyRuntime(s, sid, { status: rt.sending ? "running" : "idle" });
    }),

  getSessionStatus: (id) => {
    const s = get();
    if (id === s.activeSessionId) return s.status;
    return s.bySession[id]?.status ?? "idle";
  },

  sanitizeAllSessionStatuses: () =>
    set((s) => {
      let changed = false;
      const bySession: Record<string, ChatSessionRuntime> = {};
      for (const [id, rt] of Object.entries(s.bySession)) {
        if (rt.status === "running" || rt.status === "needs_confirmation" || rt.sending || rt.dangerousConfirmations.length > 0 || rt.askRequests.length > 0) {
          changed = true;
          bySession[id] = {
            ...rt,
            status: "idle",
            sending: false,
            dangerousConfirmations: [],
            askRequests: [],
          };
        } else {
          bySession[id] = rt;
        }
      }
      if (!changed) return {};
      // Also sanitize the focus-session view fields if they were stale.
      const focusId = s.activeSessionId;
      const focus = focusId ? bySession[focusId] : undefined;
      return {
        bySession,
        ...(focus ? { status: focus.status, sending: focus.sending, dangerousConfirmations: focus.dangerousConfirmations, askRequests: focus.askRequests } : {}),
      };
    }),
}));
