import type { ChatEventDto, ChatEventInputDto } from "../../preload/index";

const BUFFERED_EVENT_TYPES = new Set<ChatEventDto["type"]>([
  "thinking_delta",
  "assistant_delta",
  "terminal",
  "minimum_context_decision",
  "minimum_context_read_follow_up",
]);

const FORCE_FLUSH_EVENT_TYPES = new Set<ChatEventDto["type"]>([
  "turn_complete",
  "error",
  "warning",
  "task_run_state",
]);

interface BufferedSessionState {
  events: ChatEventDto[];
  pendingChars: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ChatEventBufferOptions {
  charThreshold?: number;
  flushIntervalMs?: number;
  sendBatch: (sessionId: string | null, events: ChatEventDto[]) => void;
  sendSingle: (sessionId: string | null, ev: ChatEventDto) => void;
}

function stampChatEvent(sessionId: string | null, ev: ChatEventInputDto): ChatEventDto {
  const sid = ev.sessionId || sessionId;
  if (!sid) {
    throw new Error("ChatEvent requires a non-empty sessionId");
  }
  return ev.sessionId === sid ? (ev as ChatEventDto) : { ...ev, sessionId: sid };
}

function estimateEventChars(ev: ChatEventInputDto): number {
  if (ev.type === "thinking_delta" || ev.type === "assistant_delta") {
    return ev.text?.length ?? 0;
  }
  if (ev.type === "terminal") {
    const entry = ev.entry as unknown as { text?: string; output?: string } | undefined;
    return (entry?.text?.length ?? 0) + (entry?.output?.length ?? 0);
  }
  return 0;
}

export function createChatEventBuffer(options: ChatEventBufferOptions) {
  const { sendBatch, sendSingle } = options;
  const charThreshold = options.charThreshold ?? 800;
  const flushIntervalMs = options.flushIntervalMs ?? 3000;
  const buffers = new Map<string, BufferedSessionState>();

  function getState(sessionId: string | null): BufferedSessionState {
    const key = sessionId ?? "";
    const existing = buffers.get(key);
    if (existing) return existing;
    const state: BufferedSessionState = { events: [], pendingChars: 0, timer: null };
    buffers.set(key, state);
    return state;
  }

  function flushSession(sessionId: string | null): void {
    const key = sessionId ?? "";
    const state = buffers.get(key);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const pending = state.events.splice(0);
    state.pendingChars = 0;
    if (pending.length === 0) return;
    sendBatch(sessionId, pending);
  }

  function flushAll(): void {
    for (const sessionId of Array.from(buffers.keys())) {
      flushSession(sessionId === "" ? null : sessionId);
    }
  }

  function enqueue(sessionId: string | null, ev: ChatEventDto): void {
    const state = getState(sessionId);
    state.events.push(ev);
    state.pendingChars += estimateEventChars(ev);
    if (state.pendingChars >= charThreshold) {
      flushSession(sessionId);
      return;
    }
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        flushSession(sessionId);
      }, flushIntervalMs);
    }
  }

  function emitChatEvent(sessionId: string | null, ev: ChatEventInputDto): void {
    const stamped = stampChatEvent(sessionId, ev);
    const sid = stamped.sessionId;
    if (BUFFERED_EVENT_TYPES.has(stamped.type)) {
      enqueue(sid, stamped);
      return;
    }
    if (FORCE_FLUSH_EVENT_TYPES.has(stamped.type)) {
      flushSession(sid);
    }
    sendSingle(sid, stamped);
  }

  function removeSession(sessionId: string | null): void {
    const key = sessionId ?? "";
    const state = buffers.get(key);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    buffers.delete(key);
  }

  return { emitChatEvent, flushSession, flushAll, removeSession };
}
