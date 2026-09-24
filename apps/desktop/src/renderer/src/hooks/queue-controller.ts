/**
 * queue-controller
 *
 * Module-level singleton for the per-session pending-message queues
 * ("待执行条目"). Shared by useChatActions (producer/consumer) and
 * useSessionSync (restore) because the two hooks cannot reference each other.
 *
 * Every mutation (enqueue / dequeue / drop) is mirrored to the chat store for
 * display and fire-and-forget persisted through the main process so queued
 * messages survive app restarts or renderer reloads.
 */
import { useChatStore } from "../store/chat-store";

import type { ChatAttachmentDto } from "../../../preload/index";

export interface QueuedMessage { text: string; attachments?: ChatAttachmentDto[] }
const queues = new Map<string, QueuedMessage[]>();
const running = new Set<string>();
const stopRequested = new Set<string>();
let runner: ((sid: string, oneOnly?: boolean) => Promise<void>) | null = null;
let runnerOwner: symbol | null = null;

function snapshot(sid: string): QueuedMessage[] {
  return [...(queues.get(sid) ?? [])];
}

function syncStore(sid: string): void {
  useChatStore.getState().setQueuedMessages(snapshot(sid), sid);
}

function persist(sid: string): void {
  void window.owncoder.setQueuedMessages(snapshot(sid), sid).catch(() => undefined);
}

export function setQueueRunner(fn: (sid: string, oneOnly?: boolean) => Promise<void>): symbol {
  const owner = Symbol("queue-runner");
  runner = fn;
  runnerOwner = owner;
  return owner;
}

export function clearQueueRunner(owner: symbol): void {
  if (runnerOwner !== owner) return;
  runner = null;
  runnerOwner = null;
}

export function isQueueRunning(sid: string): boolean {
  return running.has(sid);
}

export function markQueueRunning(sid: string, v: boolean): void {
  if (v) running.add(sid);
  else running.delete(sid);
}

/**
 * Whether a stop has been requested for this session. The queue runner checks
 * this before dequeuing the next message so it can break out of the drain loop
 * WITHOUT clearing the remaining queued messages.
 */
export function isStopRequested(sid: string): boolean {
  return stopRequested.has(sid);
}

/**
 * Request a stop for a session. The running queue loop (if any) will break
 * after the in-flight turn settles, leaving remaining queued messages intact.
 */
export function requestStop(sid: string): void {
  stopRequested.add(sid);
}

/** Clear the stop flag (e.g. when a new send kicks off the queue again). */
export function clearStopRequest(sid: string): void {
  stopRequested.delete(sid);
}

/** Append a message and persist immediately ("每次发送也要保存"). */
export function enqueueMessage(sid: string, text: string, attachments?: QueuedMessage["attachments"]): void {
  const q = queues.get(sid) ?? [];
  q.push(attachments?.length ? { text, attachments } : { text });
  queues.set(sid, q);
  syncStore(sid);
  persist(sid);
}

/** Pop the next message and persist immediately so a restart never re-runs it. */
export function dequeueMessage(sid: string): QueuedMessage | undefined {
  const q = queues.get(sid);
  if (!q || q.length === 0) return undefined;
  const next = q[0]!;
  queues.set(sid, q.slice(1));
  syncStore(sid);
  persist(sid);
  return next;
}

/** Move one queued message to the front for manual sending. */
export function sendQueuedMessage(sid: string, index: number): void {
  const q = queues.get(sid);
  if (!q || index < 0 || index >= q.length || !runner || running.has(sid)) return;
  const [next] = q.splice(index, 1);
  queues.set(sid, [next!, ...q]);
  syncStore(sid);
  persist(sid);
  clearStopRequest(sid);
  void runner(sid, true);
}

function isAttachment(value: unknown): value is NonNullable<QueuedMessage["attachments"]>[number] {
  if (!value || typeof value !== "object") return false;
  const row = value as { name?: unknown; mimeType?: unknown; url?: unknown; size?: unknown };
  return typeof row.name === "string" && typeof row.mimeType === "string" && typeof row.url === "string";
}

function normalizeQueuedMessage(value: unknown): QueuedMessage | null {
  if (typeof value === "string") {
    return value.length > 0 ? { text: value } : null;
  }
  if (!value || typeof value !== "object") return null;
  const row = value as { text?: unknown; attachments?: unknown };
  const text = typeof row.text === "string" ? row.text : "";
  const attachments = Array.isArray(row.attachments)
    ? row.attachments.filter(isAttachment).map((item) => ({
        name: item.name,
        mimeType: item.mimeType,
        url: item.url,
        ...(typeof item.size === "number" ? { size: item.size } : {}),
      }))
    : undefined;
  if (!text && !(attachments && attachments.length > 0)) return null;
  return attachments && attachments.length > 0 ? { text, attachments } : { text };
}

/** Restore a queue from persisted state (session switch / app startup). */
export function hydrateQueue(sid: string, messages: unknown): void {
  const msgs = Array.isArray(messages)
    ? messages.map(normalizeQueuedMessage).filter((m): m is QueuedMessage => m !== null)
    : [];
  queues.set(sid, msgs);
  syncStore(sid);
}

/** Remove a specific message by index and persist immediately. */
export function removeMessage(sid: string, index: number): void {
  const q = queues.get(sid);
  if (!q || index < 0 || index >= q.length) return;
  q.splice(index, 1);
  queues.set(sid, q);
  syncStore(sid);
  persist(sid);
}

/** Forget a session's queue (session deleted). */
export function dropQueue(sid: string): void {
  queues.delete(sid);
  running.delete(sid);
  stopRequested.delete(sid);
}

/**
 * Drop every queued message for a session without deleting the queue slot.
 * Used when the user clicks 停止 — after the in-flight turn aborts the
 * drain loop would otherwise immediately dequeue the next message and
 * spin up a new sendChat, making stop appear to do nothing.
 */
export function clearQueue(sid: string): void {
  const q = queues.get(sid);
  if (!q || q.length === 0) return;
  queues.set(sid, []);
  syncStore(sid);
  persist(sid);
}

/** Continue executing a restored queue, if any and not already running. */
export function resumeQueue(sid: string): void {
  const q = queues.get(sid);
  if (!q || q.length === 0) return;
  if (running.has(sid)) return;
  if (runner) void runner(sid);
}