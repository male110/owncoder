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
import type { AppError } from "@owncoder/shared";
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
  /** Complete structured message from turn_complete event (阶段三). */
  | { kind: "structured"; id: string; parts: MessagePart[]; metadata: MessageMetadata };

export interface DecompositionSnapshot {
  intent: string;
  userConstraints: string[];
  tasks: Array<{
    id: string;
    description: string;
    steps: Array<{
      id: string;
      description: string;
      dependsOn: string[];
      informationNeeds: Array<{ id: string; question: string }>;
    }>;
  }>;
  fallback: boolean;
}

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
  prependHistory: (turns: ChatTurnDto[], beforeSeq: number | null, hasMore: boolean, sessionId?: string) => void;
  setHistoryPageState: (patch: Partial<Pick<ChatSessionRuntime, "historyBeforeSeq" | "historyHasMore" | "historyLoading">>, sessionId?: string) => void;
  setSending: (v: boolean, sessionId?: string) => void;
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
      status: s.status,
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
