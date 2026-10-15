/**
 * IPC handlers: chat send/regenerate/history/clear/cancel, and streaming events.
 *
 * Streaming events are broadcast as `{ sessionId, ev }` so the renderer can route
 * them to the correct per-session store even when multiple sessions run concurrently.
 */
import { ipcMain } from "electron";
import { classifyError, serializeError } from "@owncoder/shared";
import type { TurnEventInput } from "@owncoder/core";
import { sendToRenderer } from "../renderer-send";
import type { IpcContext } from "./types";
import { createChatEventBuffer } from "./chat-event-buffer";
import type { ChatEventInputDto } from "../../preload/index";

export function registerChatHandlers(ctx: IpcContext): void {
  const { session, getWindow, isRendererReady } = ctx;

  const buffer = createChatEventBuffer({
    charThreshold: 800,
    flushIntervalMs: 3000,
    sendBatch(sessionId, events) {
      sendToRenderer({ getWindow, isRendererReady }, "chat:event", { sessionId, events });
    },
    sendSingle(sessionId, ev) {
      sendToRenderer({ getWindow, isRendererReady }, "chat:event", { sessionId, ev });
    },
  });

  ctx.chatBuffer = {
    removeSession(sessionId) { buffer.removeSession(sessionId); },
    flushAll() { buffer.flushAll(); },
  };
  if (ctx.chatBufferRef) {
    ctx.chatBufferRef.removeSession = (sessionId) => buffer.removeSession(sessionId);
    ctx.chatBufferRef.flushAll = () => buffer.flushAll();
  }

  function emitChat(sessionId: string | null, ev: TurnEventInput): void {
    const sid = ev.sessionId || sessionId;
    if (!sid) {
      throw new Error("ChatEvent requires a non-empty sessionId");
    }
    if (ev.type === "context_warning") {
      buffer.emitChatEvent(sid, { type: "warning", message: ev.message, sessionId: sid });
      return;
    }
    buffer.emitChatEvent(sid, { ...(ev as ChatEventInputDto), sessionId: sid });
  }

  ipcMain.handle("chat:history", (_e, sessionId?: string) => session.getHistory(sessionId));
  ipcMain.handle("chat:historyPage", (_e, sessionId: string, beforeSeq?: number, limit?: number) =>
    session.loadHistoryPage(sessionId, beforeSeq, limit));

  ipcMain.handle("chat:clear", async (_e, sessionId?: string) => {
    session.clearHistory(sessionId);
    await session.persist(sessionId);
    return true;
  });

  ipcMain.handle("chat:deleteTurn", async (_e, turnId: string, sessionId?: string) =>
    session.deleteTurnPair(turnId, sessionId));

  ipcMain.handle("chat:cancel", (_e, sessionId?: string) => {
    session.cancelTurn(sessionId);
    return true;
  });

  ipcMain.handle("chat:send", async (_e, text: string, attachments: import("@owncoder/llm").ChatAttachment[] = [], sessionId?: string) => {
    const sid = sessionId ?? session.getState().activeSessionId ?? undefined;
    const t0 = Date.now();
    const ts = (label: string) => `[chat:send +${Date.now() - t0}ms] ${label}`;
    try {
      console.log(ts(`enter mode=${session.getState(sid).mode} text="${text.slice(0, 80)}"`));
      const result = await session.sendMessage(
        text,
        (ev: TurnEventInput) => emitChat(sid ?? null, ev),
        sid,
        attachments,
      );
      console.log(ts(`ok historyLen=${result.history.length} planPath=${result.lastPlanPath ?? "null"}`));
      console.log(ts(`DETAILED history:`) + ' ' + result.history.map((h, i) => `[${i}] ${h.role}: ${h.content.substring(0, 50)}...`).join(' | '));
      const state = session.getState(sid);
      return {
        ok: true as const,
        assistantText: result.assistantText,
        history: result.history,
        lastPlanPath: result.lastPlanPath,
        lastCheckpointId: state.lastCheckpointId,
        // Use the explicit sid, not state.activeSessionId — the workspace may
        // have switched during sendMessage, making activeSessionId point to a
        // different project's session.
        sessionId: sid ?? null,
        sessionTitle: state.sessionTitle,
      };
    } catch (err) {
      const appErr = classifyError(err);
      console.error(ts(`ERROR ${appErr.code}: ${appErr.message}`));
      if (sid) emitChat(sid, { type: "error", message: serializeError(appErr), sessionId: sid });
      const state = session.getState(sid);
      return {
        ok: false as const,
        error: serializeError(appErr),
        history: session.getHistory(sid),
        sessionId: sid ?? null,
        sessionTitle: state.sessionTitle,
      };
    }
  });

  ipcMain.handle("chat:regenerate", async (_e, sessionId?: string) => {
    const sid = sessionId ?? session.getState().activeSessionId ?? undefined;
    try {
      const result = await session.regenerateLastReply(
        (ev: TurnEventInput) => emitChat(sid ?? null, ev),
        sid,
      );
      const state = session.getState(sid);
      return {
        ok: true as const,
        assistantText: result.assistantText,
        history: result.history,
        lastPlanPath: result.lastPlanPath,
        lastCheckpointId: state.lastCheckpointId,
        sessionId: sid ?? null,
        sessionTitle: state.sessionTitle,
      };
    } catch (err) {
      const appErr = classifyError(err);
      console.error("[chat:regenerate] ERROR:", appErr.code, appErr.message);
      if (sid) emitChat(sid, { type: "error", message: serializeError(appErr), sessionId: sid });
      const state = session.getState(sid);
      return {
        ok: false as const,
        error: serializeError(appErr),
        history: session.getHistory(sid),
        sessionId: sid ?? null,
        sessionTitle: state.sessionTitle,
      };
    }
  });
}
