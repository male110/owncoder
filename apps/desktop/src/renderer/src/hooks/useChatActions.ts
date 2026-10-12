/**
 * useChatActions
 *
 * Owns the send / regenerate / slash-command / plan-approve / changes /
 * rollback logic that previously lived inline in App.tsx.
 * Reads from stores; dispatches IPC calls; writes back to stores.
 */
import { useCallback, useEffect, useRef } from "react";
import { customConfirm } from "../utils/customConfirm";
import { useChatStore } from "../store/chat-store";
import { useSessionStore } from "../store/session-store";
import { getFocusSessionId } from "../store/focus-session";
import { resolveComposerDraftText, useUiStore } from "../store/ui-store";
import { isVerificationGateError, toAppError } from "../components/ErrorBanner";
import {
  dequeueMessage,
  enqueueMessage,
  isQueueRunning,
  markQueueRunning,
  removeMessage,
  setQueueRunner,
  clearQueueRunner,
  isStopRequested,
  clearStopRequest,
  sendQueuedMessage,
} from "./queue-controller";
import type { ChatTurnDto, TaskStatusDto } from "../../../preload/index";
import { t } from "../../../shared/i18n/core";

// ── helpers ───────────────────────────────────────────────────────────────────

function chatTurnKey(turn: ChatTurnDto): string {
  return `${turn.role}:${turn.id ?? ""}:${turn.content}`;
}

function sameChatTurn(a: ChatTurnDto, b: ChatTurnDto): boolean {
  if (a.role !== b.role) return false;
  if (a.id && b.id) return a.id === b.id;
  // The optimistic user turn has no id. Match it to the persisted turn so
  // applying the send result replaces the optimistic row instead of appending
  // a second copy of the same round.
  return (a.role === "user" || a.role === "assistant") && a.content === b.content;
}

/** Keep prepended older turns and apply the backend tail (including the new reply). */
export function mergeIncomingHistory(current: ChatTurnDto[], incoming: ChatTurnDto[]): ChatTurnDto[] {
  if (current.length === 0) return incoming;
  if (incoming.length === 0) return current;

  for (let i = 0; i < incoming.length; i++) {
    const found = current.findIndex((turn) => sameChatTurn(turn, incoming[i]!));
    if (found >= 0) {
      return [...current.slice(0, found), ...incoming.slice(i)];
    }
  }

  const existing = new Set(current.map(chatTurnKey));
  const extra = incoming.filter(
    (turn) => !existing.has(chatTurnKey(turn)) && !current.some((item) => sameChatTurn(item, turn)),
  );
  return extra.length > 0 ? [...current, ...extra] : current;
}

type SendResult =
  | {
      ok: true;
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
    };

// 保留首条消息的完整标题，显示省略号由侧栏的可用宽度决定。
function provisionalTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// 仅当会话仍持有默认标题（"新会话"或空）时，立即用首条用户消息更新侧栏标题，
// 让"新建会话"在发送瞬间即反映主题，无需等待后端回合结束返回标题。
// 标题一旦被设置为非"新会话"后，不再自动更新，保持稳定以便用户查找历史会话。
function applyProvisionalTitleIfNeeded(sid: string, text: string) {
  const cur = useSessionStore.getState();
  const curSessions = useSessionStore.getState().sessions;
  const currentItem = curSessions.find((s) => s.id === sid);
  
  // 只在标题仍为"新会话"或空时更新，已设置的标题不再修改
  const shouldUpdate = !currentItem?.title || currentItem.title === "新会话";
  if (!shouldUpdate) return;

  const title = provisionalTitle(text);
  if (cur.activeSessionId === sid) cur.setSessionTitle(title);

  // `sessions` mirrors the CURRENT project only. Never insert a foreign
  // session here — a background turn from project A must not appear under
  // project B while the user has already switched. If the session belongs
  // to the current project it is already in the list (createPendingSession /
  // refreshSessions); update in place. Otherwise leave `sessions` alone.
  if (currentItem) {
    cur.setSessions(curSessions.map((it) => (it.id === sid ? { ...it, title } : it)));
  }

  // Update the session title in ALL projects that already contain this session.
  // Do NOT add the session to a project list if it doesn't already belong
  // there — that would cause a session from project A to appear in project
  // B's sidebar after the user switches projects during a running turn.
  cur.setSessionsByProject((projects) => {
    let changed = false;
    const next = { ...projects };
    for (const [r, list] of Object.entries(projects)) {
      const listItem = list.find((s) => s.id === sid);
      if (listItem && (!listItem.title || listItem.title === "新会话")) {
        next[r] = list.map((it) => (it.id === sid ? { ...it, title } : it));
        changed = true;
      }
    }
    return changed ? next : projects;
  });
}

export function useChatActions(deps: {
  applySessionState: () => Promise<import("../../../preload/index").SessionStateDto | null>;
  refreshChanges: (sessionId?: string) => Promise<void>;
  refreshGit: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshPlans: (sessionId?: string) => Promise<void>;
  refreshActivePlan: (sessionId?: string) => Promise<import("../../../preload/index").ActivePlanMetaDto | null>;
  // 方案B: deferred session creation
  pendingNewSessionRef: React.MutableRefObject<boolean>;
  createPendingSession: () => Promise<string | null>;
  // Used by onSend when the active session was just removed — Enter on a non-empty
  // composer should materialise a new session on first send rather than
  // silently no-op (the composer would otherwise appear stuck on top).
  onNewSession: () => Promise<void>;
}) {
  // Subscribe only to actions. Zustand actions are stable; all mutable values
  // are read with getState at call time so background updates do not rebuild
  // this hook or its queue runner.
  const chat = useChatStore.getState();
  const session = useSessionStore.getState();
  const ui = useUiStore.getState();
  const depsRef = useRef(deps);
  depsRef.current = deps;


  // ── Error helper ─────────────────────────────────────────────────────────

  const showError = useCallback((raw: unknown, sid?: string) => {
    // 验证门禁失败只在 LLM 正文区提示，不弹顶部「出错了」条。
    if (isVerificationGateError(raw)) return;
    chat.setErrorAlert(toAppError(raw), sid);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Post-send ─────────────────────────────────────────────────────────────

  const applyChatResult = useCallback(async (res: SendResult, sid: string) => {
    console.log(`[applyChatResult] sid=${sid} ok=${res.ok} incoming.length=${res.history.length}`);
    
    // The durable history returned by sendChat is authoritative. Clear the
    // streamed turn before applying it; otherwise a late turn_complete event
    // can leave the old assistant text beside the committed reply.
    chat.setLiveEvents(() => [], sid);
    // History-protection: never let `applyChatResult` wipe a non-empty
    // conversation. The backend is expected to return the full session
    // history in `res.history`, but if it returns a shorter list (backend
    // regression, race with the previous turn resolving concurrently, or
    // a partial result) the naive `setHistory(res.history)` would replace
    // the visible history with the truncated result — a silent, irreversible
    // data loss for the user. Only accept the backend's history when it is
    // at least as complete as what we currently have; otherwise keep the
    // existing history (the assistant's streamed response is still visible
    // in the just-sealed liveEvents on the caller side).
    const incoming = res.history.filter(
      (t) => !(t.role === "assistant" && t.content.startsWith("Error:")),
    );
    const currentHistory = useChatStore.getState().bySession[sid]?.history ?? [];
    const merged = mergeIncomingHistory(currentHistory, incoming);
    console.log(`[applyChatResult] current.length=${currentHistory.length} incoming.length=${incoming.length} merged.length=${merged.length}`);
    chat.setHistory(merged, sid);

    // Refresh pagination metadata from the durable conversation store. Live
    // turns append to runtime history without updating historyHasMore; without
    // this, the "加载更早消息" control stays hidden after the conversation grows
    // past the first page (or after a truncated first-page seed).
    void window.owncoder.getChatHistoryPage(sid, undefined, 10).then((page) => {
      const rt = useChatStore.getState().bySession[sid];
      // User may have already scrolled up and loaded older pages; never move
      // the cursor forward or clear hasMore in that case. If the UI still only
      // has about one page, a new turn may have crossed the page boundary and
      // should reveal "加载更早消息". If older turns are already prepended,
      // keep the existing hasMore flag (already-loaded-all stays hidden).
      if (rt?.historyBeforeSeq != null && page.beforeSeq != null && rt.historyBeforeSeq < page.beforeSeq) {
        const uiHasOlderPages = (rt.history?.length ?? 0) > page.turns.length + 2;
        if (!rt.historyHasMore && page.hasMore && !uiHasOlderPages) {
          useChatStore.getState().setHistoryPageState({ historyHasMore: true }, sid);
        }
        return;
      }
      useChatStore.getState().setHistoryPageState(
        {
          historyBeforeSeq: rt?.historyBeforeSeq ?? page.beforeSeq,
          historyHasMore: Boolean(rt?.historyHasMore) || page.hasMore,
          historyLoading: false,
        },
        sid,
      );
    }).catch((error) => {
      console.warn("[applyChatResult] 刷新历史分页状态失败", error);
    });
    if (!res.ok) {
      if (isVerificationGateError(res.error)) {
        chat.setLiveStatus("", sid);
      } else {
        showError(res.error, sid);
      }
    } else {
      chat.setLiveStatus("", sid);
    }
    // The main process persists the title before returning. Apply that exact
    // session result immediately instead of waiting for slower list/project
    // refreshes, which may still contain the temporary "新会话" title.
    // 标题固定策略：只在当前标题为"新会话"时才接受后端的标题更新
    if (res.sessionId && res.sessionTitle) {
      const current = useSessionStore.getState();
      const curSessions = useSessionStore.getState().sessions;
      const currentItem = curSessions.find((item) => item.id === res.sessionId);
      
      // 检查是否应该更新标题：仅当标题仍为"新会话"或空时
      const shouldUpdateTitle = !currentItem?.title || currentItem.title === "新会话";
      
      if (shouldUpdateTitle) {
        if (current.activeSessionId === res.sessionId) {
          current.setSessionTitle(res.sessionTitle);
        }
        // Only rewrite the current-project mirror when this session already
        // belongs there. Never insert a foreign session into `sessions`.
        if (curSessions.some((item) => item.id === res.sessionId)) {
          current.setSessions(
            curSessions.map((item) =>
              item.id === res.sessionId ? { ...item, title: res.sessionTitle! } : item,
            ),
          );
        }
        // Update every project cache that already owns this session. Using the
        // current workspace root alone would miss the owning project after the
        // user switches mid-turn, and could no-op the final title sync.
        current.setSessionsByProject((projects) => {
          let changed = false;
          const next = { ...projects };
          for (const [r, list] of Object.entries(projects)) {
            const listItem = list.find((item) => item.id === res.sessionId);
            if (listItem && (!listItem.title || listItem.title === "新会话")) {
              next[r] = list.map((item) =>
                item.id === res.sessionId ? { ...item, title: res.sessionTitle! } : item,
              );
              changed = true;
            }
          }
          return changed ? next : projects;
        });
      }
    }

    // Fire-and-forget: refreshSessions runs in the background so it doesn't
    // delay setSending(false) or the immediately-following refreshChanges.
    void depsRef.current.refreshSessions().catch(() => {});
    // **REMOVED**: No longer call applySessionState() after applyChatResult.
    // The backend has already returned the authoritative history in res.history,
    // which we applied above with history-protection. Calling applySessionState
    // immediately after creates a race: if the backend's persist queue hasn't
    // flushed yet, getChatHistory() reads stale (empty) data and overwrites the
    // just-applied history. Leave session-state reconciliation to user-driven
    // events (session switch, app restore) where staleness is acceptable; here
    // we already have the fresh result in hand.
    //
    // if (useSessionStore.getState().activeSessionId === sid) {
    //   await deps.applySessionState();
    // }
  }, [showError]); // eslint-disable-line react-hooks/exhaustive-deps

  const injectPlanNotification = useCallback(async (planPath: string, sid: string) => {
    try {
      const content = await window.owncoder.readPlan(planPath);
      const fileName = planPath.split("/").pop() ?? planPath;
      const preview = content.slice(0, 300).trim();
      const summary = preview.length < content.length ? `${preview}…` : preview;
      chat.setHistory((h) => [
        ...h,
        { role: "assistant", content: `📋 **${t("计划已生成：{{name}}", { name: fileName })}**\n\n${summary}\n\n<!--plan_saved:${planPath}-->` },
      ], sid);
    } catch {
      const fileName = planPath.split("/").pop() ?? planPath;
      chat.setHistory((h) => [
        ...h,
        { role: "assistant", content: `📋 ${t("计划已生成：{{name}}", { name: fileName })}\n\n<!--plan_saved:${planPath}-->` },
      ], sid);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Slash commands ────────────────────────────────────────────────────────

  const runSlash = useCallback(async (text: string, sid: string): Promise<boolean> => {
    const cmd = text.trim().toLowerCase();
    if (cmd === "/compact") {
      chat.setHistory(await window.owncoder.compactHistory(sid), sid);
      chat.setLiveStatus(t("已保留原始历史；下次请求将由模型生成任务摘要"), sid);
      ui.clearSentDrafts(sid);
      return true;
    }
    if (cmd === "/clear") {
      await window.owncoder.clearChat(sid);
      chat.setHistory([], sid);
      chat.resetTurnState(sid);
      chat.setErrorAlert(null, sid);
      chat.setLiveStatus("", sid);
      ui.clearSentDrafts(sid);
      return true;
    }
    if (cmd === "/plan") {
      session.setMode(await window.owncoder.setMode("plan", sid));
      ui.clearSentDrafts(sid);
      chat.setLiveStatus(t("已切换到 Plan 模式"), sid);
      return true;
    }
    if (cmd === "/agent") {
      session.setMode(await window.owncoder.setMode("agent", sid));
      ui.clearSentDrafts(sid);
      chat.setLiveStatus(t("已切换到 Agent 模式"), sid);
      return true;
    }
    if (cmd === "/undo") {
      await onRollback(sid);
      ui.clearSentDrafts(sid);
      return true;
    }
    if (cmd === "/help") {
      chat.setHistory((h) => [
        ...h,
        {
          role: "assistant",
          content:
            t("可用命令：\n/compact — 压缩历史\n/clear — 清空对话\n/plan — Plan 模式\n/agent — Agent 模式\n/undo — 撤销上次改动\n/help — 显示帮助"),
        },
      ], sid);
      ui.clearSentDrafts(sid);
      return true;
    }
    return false;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Queue runner ──────────────────────────────────────────────────────────

  const runQueue = useCallback(async (sid: string, oneOnly = false) => {
    console.log("[runQueue] called, sid=", sid, "isRunning=", isQueueRunning(sid));
    if (isQueueRunning(sid)) return;
    markQueueRunning(sid, true);
    try {
      while (true) {
        // Stop requested by the user: break out of the drain loop WITHOUT
        // clearing the remaining queued messages, so they survive the stop.
        if (isStopRequested(sid)) {
          clearStopRequest(sid);
          break;
        }
        const next = dequeueMessage(sid);
        if (!next) break;
        chat.setSending(true, sid);
        chat.resetTurnState(sid);
        // Immediate user-facing feedback BEFORE the IPC roundtrip so the user
        // sees "正在分解任务…" / "正在运行中…" even when the backend hasn't
        // emitted its first stage event yet. Subsequent `stage_start` /
        // `thinking_delta` / `tool_start` events will overwrite this with
        // more specific text via `setLiveStatus`.
        chat.setLiveStatus(t("正在分解任务…"), sid);
        chat.setHistory(
          (h) => [
            ...h,
            {
              role: "user",
              content: next.text,
              ...(next.attachments?.length ? { attachments: next.attachments } : {}),
            },
          ],
          sid,
        );
        applyProvisionalTitleIfNeeded(sid, next.text);
        try {
          await new Promise((r) => setTimeout(r, 0));
          const res = await window.owncoder.sendChat(next.text, sid, next.attachments);
          // Kick off refreshChanges IMMEDIATELY — don't wait for applyChatResult.
          // The backend has finished writing files by now, so the changes panel
          // can start populating while history/title updates settle.
          if (getFocusSessionId() === sid) {
            depsRef.current.refreshChanges(sid).catch(() => {});
          }
          await applyChatResult(res, sid);
          // Mark session completed immediately so the sidebar shows "已结束"
          // without waiting for the (potentially slow) changes/git refreshes.
          chat.setSending(false, sid);
          // Fire-and-forget: remaining refreshes run in the background.
          if (getFocusSessionId() === sid) {
            depsRef.current.refreshGit().catch(() => {});
          }
          if (res.ok && res.lastPlanPath) void injectPlanNotification(res.lastPlanPath, sid);
        } catch (e) {
          showError(e, sid);
          chat.setSending(false, sid);
        }
        if (oneOnly) break;
        // Do NOT resetTurnState() here - sealAllStreaming() (triggered by the
        // IPC "turn_complete" event) has already sealed the liveEvents in place
        // so the user can review the trace. The next iteration's resetTurnState()
        // call at the top of the loop will clear them before the new turn.
      }
    } finally {
      markQueueRunning(sid, false);
    }
  }, [applyChatResult, injectPlanNotification, showError]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendQueued = useCallback((sid: string, index: number) => {
    sendQueuedMessage(sid, index);
  }, []);

  useEffect(() => {
    const owner = setQueueRunner(runQueue);
    return () => clearQueueRunner(owner);
  }, [runQueue]);

  const onSend = useCallback(async (attachments?: import("../../../preload/index").ChatAttachmentDto[]) => {
    try {
      console.log("[onSend] called");
      let sid = getFocusSessionId();
    // No active session (e.g. the user just deleted the last session, or
    // deleted one while another was in-flight). The composer must still be
    // usable: typing + Enter should materialise a new session on first send
    // (create-on-first-input). When the composer is empty we still no-op,
    // so deletion itself never auto-spawns anything.
    // Drafts are keyed by sessionId or PENDING_DRAFT_KEY. Composer display
    // and handleDraft must use the same resolution as here — otherwise the
    // box shows text while onSend silently returns on empty text.
    const draftsSnap = useUiStore.getState().drafts;
    const pendingNew = depsRef.current.pendingNewSessionRef.current;
    let text = resolveComposerDraftText(draftsSnap, sid, pendingNew);
    console.log("[onSend] sid=", sid, "pendingNew=", pendingNew, "text.length=", text?.length);

    // ── ask_user routing ─────────────────────────────────────────────────
    // Only when ALL of the following hold:
    //   1. There is an active session (sid is set) — the focus mirror
    //      `chatState.askRequests` is stale when activeSessionId is null,
    //      so we MUST NOT consult it there. A pending-new session must
    //      never have its first send routed to ask_user.
    //   2. That session's per-session array has a non-empty head (a real,
    //      locally-known ask_user request).
    //   3. The session is actively sending — a turn is in progress and
    //      blocked on the ask_user. This is the only case where the
    //      composer's draft is plausibly the user's answer. Without this
    //      guard, stale ask_requests left over from a previous turn (e.g.
    //      the model called ask_user during plan-mode doc generation and
    //      the renderer never received a cleanup when the backend settled
    //      with empty / the user already dismissed it) would intercept
    //      every subsequent send: the draft gets eaten by respondAskUser,
    //      no LLM turn starts, the user sees "no response".
    //   4. The pending ask explicitly allows free-text answers
    //      (allowFreeText === true). With this strict check, ask_user
    //      prompts that present a fixed list of options don't accidentally
    //      capture arbitrary user text.
    if (text && sid) {
      const chatState = useChatStore.getState();
      const pendingAsk = chatState.bySession[sid]?.askRequests?.[0] ?? null;
      const isSending = chatState.isSessionSending(sid);
      console.log("[onSend] ask_user check: pendingAsk=", !!pendingAsk, "allowFreeText=", pendingAsk?.allowFreeText, "isSending=", isSending);
      if (
        pendingAsk &&
        pendingAsk.allowFreeText === true &&
        isSending
      ) {
        console.log("[onSend] intercepted by ask_user routing → return");
        ui.clearSentDrafts(sid);
        chatState.removeAskRequest(pendingAsk.requestId, sid);
        try {
          window.owncoder.respondAskUser(pendingAsk.requestId, text);
        } catch {
          /* respondAskUser is a fire-and-forget IPC send; swallow errors */
        }
        return;
      }
      if (pendingAsk && !isSending) {
        console.log("[onSend] removing stale ask_request");
        chatState.removeAskRequest(pendingAsk.requestId, sid);
      }
    }

    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (!sid) {
      if (!text && !hasAttachments) { console.log("[onSend] no sid, no text → return"); return; }
      await depsRef.current.onNewSession();
      // onNewSession detaches the active session and arms `pendingNewSessionRef`
      // (it deliberately leaves `activeSessionId` null so the new session's
      // focus is materialised on first send). If it couldn't arm the
      // pending-new state — typically because there is no workspace and
      // onNewSession fell through to `onAddProject` — there's nothing we can
      // send to, so bail out.
      if (!depsRef.current.pendingNewSessionRef.current) return;
      // Fall through to the `pendingNewSessionRef.current` branch below to
      // actually create the backend session and send.
    }
    // 二次读取：onNewSession / 异步间隙后 drafts 可能只剩 pending 键或旧 sid 键。
    if (!text) {
      text = resolveComposerDraftText(
        useUiStore.getState().drafts,
        sid,
        depsRef.current.pendingNewSessionRef.current,
      );
    }
    if (!text && !hasAttachments) { console.log("[onSend] text still empty after re-read → return"); return; }
    text = text ?? "";

    // 方案B: if a new-session click is pending, create the real session now.
    const currentSession = useSessionStore.getState();
    console.log("[onSend] pendingNewSession=", depsRef.current.pendingNewSessionRef.current, "sid=", sid, "workspace=", !!currentSession.workspace, "llmConfigured=", currentSession.llmConfigured);
    if (depsRef.current.pendingNewSessionRef.current) {
      // Save the text before switching sessions (draft keyed to old sid).
      const oldSid = sid as string | null;
      let newSid: string | null = null;
      try {
        newSid = await depsRef.current.createPendingSession();
      } catch (err) {
        console.error("[onSend] createPendingSession threw:", err);
        showError(err, sid ?? undefined);
        return;
      }
      console.log("[onSend] createPendingSession result: newSid=", newSid);
      if (!newSid) {
        // Creation failed — restore pending flag and abort.
        depsRef.current.pendingNewSessionRef.current = true;
        console.log("[onSend] createPendingSession failed → return");
        return;
      }
      // 发送即消费草稿：旧会话、新会话、pending 键都不再保留。
      if (oldSid) ui.clearSentDrafts(oldSid);
      ui.clearSentDrafts(newSid);
      sid = newSid;
      // text is already captured; fall through to the normal send path.
    }

    // After the new-session block above, `sid` is guaranteed non-null:
    // either it was already non-null entering this callback, or it was
    // assigned `newSid` from createPendingSession() above.
    if (!sid) return;

    console.log("[onSend] after sid check, text=", text?.substring(0, 50), "session=", session);
    // 只匹配单斜杠开头的命令（如 /clear），不匹配双斜杠（如 // 注释）
    if (text && text.startsWith("/") && !text.startsWith("//")) { void runSlash(text, sid); return; }
    console.log("[onSend] checking workspace...");
    const sendSession = useSessionStore.getState();
    if (!sendSession.workspace) { console.log("[onSend] workspace not ready → return"); chat.setLiveStatus(t("工作区尚未就绪，请稍候…"), sid); return; }
    console.log("[onSend] checking llmConfigured...");
    if (!sendSession.llmConfigured) { console.log("[onSend] LLM not configured → return"); showError(t("未配置 LLM API Key"), sid); return; }

    try {
      console.log("[onSend] past all checks, clearing draft...");
      // 立即清空输入框并丢掉持久化草稿，避免关闭重开后把已发送内容恢复回来。
      ui.clearSentDrafts(sid);
      console.log("[onSend] draft cleared, checking plan...");

      // 计划已全部完成时，用户新发对话视为开启新任务，先清除原活动计划再发送，
      // 避免后续 applySessionState 从后端重新加载已完成的计划。
      const store = useSessionStore.getState();
      const meta = store.getActivePlanMetaForSession(sid);
      console.log("[onSend] meta=", meta ? `${meta.tasks.length} tasks` : "null");
      if (
        meta &&
        meta.tasks.length > 0 &&
        meta.tasks.every((t) => t.status === "completed" || t.status === "skipped")
      ) {
        try {
          const res = await window.owncoder.clearActivePlan(sid);
          store.setActivePlanPath(res.activePlanPath, sid);
          store.setActivePlanMetaBySession(sid, null);
        } catch {
          // 清除失败不阻塞发送
        }
      }

      console.log("[onSend] enqueueing message, sid=", sid);
      enqueueMessage(sid, text, attachments);
      // 消息实际入队后才更新排序时间。
      useSessionStore.getState().touchSessionUpdatedAt(sid);
      // 用户主动发送新消息，清除可能残留的停止标志，确保队列能正常执行。
      clearStopRequest(sid);
      console.log("[onSend] running queue...");
      void runQueue(sid);
    } catch (err) {
      console.error("[onSend] INNER ERROR:", err);
    }
  } catch (err) {
    console.error("[onSend] OUTER ERROR:", err);
    // 确保在出错时也能看到错误信息
    const sid = getFocusSessionId();
    if (sid) {
      showError(err, sid);
    }
  }
  }, [runSlash, runQueue, showError]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRegenerate = useCallback(async () => {
    const sid = getFocusSessionId();
    const currentSession = useSessionStore.getState();
    if (!sid) return;
    if (chat.isSessionSending(sid)) return;
    if (!currentSession.workspace) return;
    if (!currentSession.llmConfigured) { showError(t("未配置 LLM API Key"), sid); return; }
    chat.setSending(true, sid);
    chat.resetTurnState(sid);
    // Same immediate-feedback rationale as runQueue(): show something the
    // user can read while the IPC roundtrip + first stage event arrive.
    chat.setLiveStatus(t("正在分解任务…"), sid);
    chat.setErrorAlert(null, sid);
    chat.setHistory((h) => {
      let lastUser = -1;
      for (let i = h.length - 1; i >= 0; i--) {
        if (h[i]?.role === "user") { lastUser = i; break; }
      }
      return lastUser >= 0 ? h.slice(0, lastUser + 1) : h;
    }, sid);
    try {
      await new Promise((r) => setTimeout(r, 0));
      const res = await window.owncoder.regenerateChat(sid);
      // Kick off refreshChanges IMMEDIATELY — same pattern as runQueue.
      depsRef.current.refreshChanges(sid).catch(() => {});
      await applyChatResult(res, sid);
      chat.setSending(false, sid);
      depsRef.current.refreshGit().catch(() => {});
      if (res.ok && res.lastPlanPath) void injectPlanNotification(res.lastPlanPath, sid);
    } catch (e) {
      showError(e, sid);
      chat.setSending(false, sid);
    }
    // Same as runQueue: do NOT reset here; sealAllStreaming() already ran.
  }, [applyChatResult, injectPlanNotification, showError]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Plan actions ──────────────────────────────────────────────────────────

  const onApprovePlan = useCallback(async (path?: string) => {
    const sid = getFocusSessionId();
    if (!sid) return;
    ui.setBusy(true);
    try {
      // 批准前先 keepAll：将 Plan 模式生成的文档文件（PRD/TDD 等）标记为已保留，
      // 清除 checkpoint 引用，防止后续回滚时因 existed=false 而删除这些文件。
      await window.owncoder.keepAllChanges(sid).catch(() => undefined);

      const res = await window.owncoder.approvePlan(path ? { path } : undefined, sid);
      session.setMode(res.mode);
      session.setActivePlanPath(res.activePlanPath, sid);

      // 追加而非替换：用后端最新历史合并，保留 injectPlanNotification 注入的前端专属消息。
      // 策略：取后端历史，但保留前端中含 <!--plan_saved:--> 标记的通知消息（仅存在于前端）。
      const backendHistory = await window.owncoder.getChatHistory(sid);
      chat.setHistory((frontHistory) => {
        const planNotices = frontHistory.filter(
          (t) => t.role === "assistant" && t.content.includes("<!--plan_saved:"),
        );
        // 后端历史里已有的内容不重复添加
        const merged = [...backendHistory];
        for (const notice of planNotices) {
          if (!merged.some((t) => t.content === notice.content)) {
            merged.push(notice);
          }
        }
        return merged;
      }, sid);

      await depsRef.current.refreshPlans(sid);
      const meta = await depsRef.current.refreshActivePlan(sid);
      if (meta && meta.tasks.length > 0) {
        // 批准即执行：自动发送一条消息触发 Agent 的任务 step-driver，
        // loop 会在同一轮内顺序执行完全部任务（无需用户再手动发消息）。
        const currentSession = useSessionStore.getState();
        if (!currentSession.workspace || !currentSession.llmConfigured) {
          chat.setLiveStatus(t("计划已批准。请先配置 LLM，再发送消息开始执行。"), sid);
        } else {
          enqueueMessage(sid, t("开始执行"));
          clearStopRequest(sid);
          chat.setLiveStatus(t("计划已批准，自动开始执行 {{count}} 个任务…", { count: meta.tasks.length }), sid);
          void runQueue(sid);
        }
      }
    } catch (e) {
      showError(e, sid);
    } finally {
      ui.setBusy(false);
    }
  }, [showError, runQueue]); // eslint-disable-line react-hooks/exhaustive-deps


  const onUpdateTask = useCallback(async (taskId: string, status: TaskStatusDto) => {
    const sid = getFocusSessionId();
    if (!sid) return;
    ui.setBusy(true);
    try {
      const meta = await window.owncoder.updateTask(taskId, status, undefined, sid);
      session.setActivePlanMetaBySession(sid, meta);
    } catch (e) {
      showError(e, sid);
    } finally {
      ui.setBusy(false);
    }
  }, [showError]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Changes / rollback ────────────────────────────────────────────────────

  const onRollback = useCallback(async (sidOverride?: string) => {
    const sid = sidOverride ?? getFocusSessionId();
    if (!sid) return;
    if (!(await customConfirm(t("撤销上次 Agent 改动？将恢复文件与对话到检查点。")))) return;
    ui.setBusy(true);
    try {
      const res = await window.owncoder.undoAllChanges(sid);
      chat.setHistory(res.history, sid);
      session.setChanges(sid, res.changes.files);
      await depsRef.current.applySessionState();
    } catch (e) {
      chat.setLiveStatus(e instanceof Error ? e.message : String(e), sid);
    } finally {
      ui.setBusy(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeepAll = useCallback(async () => {
    const sid = getFocusSessionId();
    if (!sid) return;
    ui.setKeepAllBusy(true);
    try {
      const pending = await window.owncoder.keepAllChanges(sid);
      session.setChanges(sid, pending.files);
    } finally {
      ui.setKeepAllBusy(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeepFile = useCallback(async (path: string) => {
    const sid = getFocusSessionId();
    if (!sid) return;
    const pending = await window.owncoder.keepChange(path, sid);
    session.setChanges(sid, pending.files);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onUndoFile = useCallback(async (path: string) => {
    const sid = getFocusSessionId();
    if (!sid) return;
    const pending = await window.owncoder.undoChange(path, sid);
    session.setChanges(sid, pending.files);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Model selection ───────────────────────────────────────────────────────

  const onSelectModel = useCallback(async (modelId: string, providerId: string) => {
    const snap = await window.owncoder.getSettings();
    const config = { ...snap.effective };
    const available = useSessionStore.getState().availableModels;
    const model = available.find((m) => m.providerId === providerId && m.id === modelId);
    if (model) {
      const others = available.filter(
        (m) => m.providerId !== model.providerId || m.id !== model.id,
      );
      config.selectedModels = [model, ...others];
      await window.owncoder.saveSettings(config);
      session.setModelLabel(model.name);
      session.setAvailableModels(config.selectedModels);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onMode = useCallback(async (next: import("@owncoder/shared").AgentMode) => {
    const sid = getFocusSessionId() ?? undefined;
    session.setMode(await window.owncoder.setMode(next, sid));
    ui.setModeMenuOpen(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onSelectThinkingEffort = useCallback(async (effort: import("@owncoder/settings").ThinkingEffort) => {
    const snap = await window.owncoder.getSettings();
    const config = { ...snap.effective };
    if (!config.thinking) {
      config.thinking = { defaultEffort: effort };
    } else {
      config.thinking.defaultEffort = effort;
    }
    await window.owncoder.saveSettings(config);
    session.setThinkingEffort(effort);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onSelectReactThinkingEffort = useCallback(async (effort: import("@owncoder/settings").ThinkingEffort) => {
    const snap = await window.owncoder.getSettings();
    const config = { ...snap.effective };
    config.harness = {
      ...config.harness,
      reactThinkingEffort: effort
    };
    await window.owncoder.saveSettings(config);
    session.setReactThinkingEffort(effort);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onRemoveQueueMessage = useCallback((index: number) => {
    const sid = getFocusSessionId();
    if (!sid) return;
    removeMessage(sid, index);
  }, []);

  return {
    onSend,
    onRegenerate,
    onApprovePlan,

    onUpdateTask,
    onRollback,
    onKeepAll,
    onKeepFile,
    onUndoFile,
    onSelectModel,
    onMode,
    onSelectThinkingEffort,
    onSelectReactThinkingEffort,
    onRemoveQueueMessage,
    sendQueued,
    showError,
  };
}
