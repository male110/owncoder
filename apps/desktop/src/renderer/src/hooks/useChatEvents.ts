/**
 * useChatEvents
 *
 * Subscribes to the "chat:event" IPC stream and updates the chat store.
 * Must be mounted once at the app root; all streaming state flows through here.
 *
 * Event apply logic lives in `applyChatEvent` (single source of truth).
 * This hook only owns IPC subscription + non-chat request routing
 * (dangerous-command / ask_user).
 */
import { useEffect } from "react";
import { useChatStore } from "../store/chat-store";
import { useSessionStore } from "../store/session-store";
import { applyChatEvent, toolStatusLabel as toolStatusLabelImpl } from "./apply-chat-event";
import type { ChatEventDto, DangerousCommandRequestDto, AskUserRequestDto } from "../../../preload/index";

/** Re-export for callers that historically imported from this hook module. */
export function toolStatusLabel(
  status: "running" | "done" | "error" | "skipped",
  name: string,
  args?: Record<string, unknown>,
): string {
  return toolStatusLabelImpl(status, name, args);
}

export function useChatEvents() {
  useEffect(() => {
    // preload 未注入时跳过订阅，避免 onChatEvent 读 undefined 直接白屏
    if (!window.owncoder?.onChatEvent) return;

    const offChat = window.owncoder.onChatEvent(({ sessionId, ev }: { sessionId: string | null; ev: ChatEventDto }) => {
      applyChatEvent(useChatStore.getState(), useSessionStore.getState(), sessionId, ev);
    });

    // ── Dangerous-command confirmation requests (per-session routing) ──────
    // The main process sends { requestId, command, sessionId }. We route the
    // request to the owning session's confirmation queue. When sessionId is
    // null/unknown, fall back to the active session so the user still sees it.
    const offDanger = window.owncoder.onDangerousCommandRequest((request: DangerousCommandRequestDto) => {
      const chat = useChatStore.getState();
      const targetSid = request.sessionId ?? chat.activeSessionId ?? undefined;
      if (targetSid) {
        chat.ensureSession(targetSid);
        chat.pushDangerousConfirmation(request, targetSid);
        // Only show the red "!" icon when the session is actively running.
        // If the turn already finished (sending===false), the confirmation
        // request is stale — enqueue it but don't flip the status icon,
        // otherwise it gets stuck with no done/setSending to clear it.
        if (chat.isSessionSending(targetSid)) {
          chat.markSessionNeedsConfirmation(targetSid);
        }
      }
    });

    // ── ask_user prompts (per-session routing) ───────────────────────────
    // Same routing as dangerous-command requests. The turn blocks on the main
    // side until the user answers, so we only enqueue and let AskUserCard show
    // the head of the queue.
    const offAsk = window.owncoder.onAskUserRequest((request: AskUserRequestDto) => {
      const chat = useChatStore.getState();
      const targetSid = request.sessionId ?? chat.activeSessionId ?? undefined;
      if (targetSid) {
        chat.ensureSession(targetSid);
        chat.pushAskRequest(request, targetSid);
      }
    });

    return () => {
      offChat();
      offDanger();
      offAsk();
    };
  }, []);
}
