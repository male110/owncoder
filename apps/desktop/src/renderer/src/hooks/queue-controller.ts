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
import { t } from "../../../shared/i18n/core";

import type { ChatAttachmentDto } from "../../../preload/index";

export interface QueuedMessage { text: string; attachments?: ChatAttachmentDto[] }
const queues = new Map<string, QueuedMessage[]>();
const running = new Set<string>();
const stopRequested = new Set<string>();
/** 正在执行「立即发送」抢占的会话：防止重复点击重复中止当前轮次。 */
const preempting = new Set<string>();
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

/** A new send can clear a paused queue, but cannot undo a stop of the current run. */
export function clearStopRequest(sid: string): void {
  if (!running.has(sid)) stopRequested.delete(sid);
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

/**
 * 立即发送一条排队消息（手动提升）。
 *
 * 语义参考 ZCode-main 的 sendQueuedNow：正在执行其它轮次时，先中止当前
 * 轮次（用户通常是对当前任务的补充纠正），等它落盘收口、队列循环退出
 * 后，再把这条消息作为普通用户消息发送；空闲时直接插队发送。
 * 其余排队消息保持不动。
 */
export async function sendQueuedMessage(sid: string, index: number): Promise<void> {
  const q = queues.get(sid);
  if (!q || index < 0 || index >= q.length || !runner) return;
  if (preempting.has(sid)) return;
  // busy 要把 regenerate / spec 批次等没经过 runQueue 的发送也计入：
  // 它们同样持有后端「当前会话正在执行」锁，直接插队会撞车。
  const busy = running.has(sid) || useChatStore.getState().isSessionSending(sid);

  if (!busy) {
    preempting.add(sid);
    const [next] = q.splice(index, 1);
    queues.set(sid, [next!, ...q]);
    syncStore(sid);
    persist(sid);
    clearStopRequest(sid);
    void runner(sid, true);
    // 短暂抑制重复点击：runQueue 的同步序言（markQueueRunning → dequeue →
    // setSending）在本调用内就完成，但两次 click 事件之间仍可能有极窄窗口，
    // 用 400ms 软锁防止双击把刚发出的轮次又抢占一次。
    setTimeout(() => preempting.delete(sid), 400);
    return;
  }

  // 有在飞的轮次：抢占之。
  // 顺序很关键：必须先 requestStop 再移动条目。runQueue 在 await sendTurn 处
  // 挂起，requestStop 是同步操作，本函数到第一个 await 之间也是同步的，
  // 因此队列循环恢复时必然先看到 stopRequested 而退出，不会把被提升的条目
  // 当作普通下一条消费掉。
  preempting.add(sid);
  useChatStore.getState().setLiveStatus(t("正在停止当前任务，立即发送下一条…"), sid);
  try {
    requestStop(sid);
    const [next] = q.splice(index, 1);
    queues.set(sid, [next!, ...q]);
    syncStore(sid);
    persist(sid);
    // 与 Stop 按钮同一套机制：让后端中止当前轮次（保留剩余队列）。
    try {
      await window.owncoder.cancelChat(sid);
    } catch {
      // 忽略：cancelChat 只是触发中止，失败时下面的等待仍会兜底。
    }
    // 等待在飞轮次真正收口（sendChat resolve → sendTurn/onRegenerate 的
    // finally 清 sending，runQueue 的 finally 清 running）。
    const deadline = Date.now() + 15_000;
    while ((running.has(sid) || useChatStore.getState().isSessionSending(sid)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    clearStopRequest(sid);
    void runner(sid, true);
  } finally {
    preempting.delete(sid);
  }
}

/** 原地编辑一条排队消息（保位），附件保持不变。参考 ZCode-main editQueueItem。 */
export function editMessage(sid: string, index: number, text: string): boolean {
  const q = queues.get(sid);
  if (!q || index < 0 || index >= q.length) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const current = q[index]!;
  if (current.text === trimmed) return true;
  q[index] = current.attachments?.length
    ? { text: trimmed, attachments: current.attachments }
    : { text: trimmed };
  queues.set(sid, q);
  syncStore(sid);
  persist(sid);
  return true;
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
  preempting.delete(sid);
}

/** Continue executing a restored queue, if any and not already running. */
export function resumeQueue(sid: string): void {
  const q = queues.get(sid);
  if (!q || q.length === 0) return;
  if (running.has(sid)) return;
  if (runner) void runner(sid);
}