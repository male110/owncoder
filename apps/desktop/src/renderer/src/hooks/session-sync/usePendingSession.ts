/**
 * usePendingSession
 *
 * Deferred session creation (方案B).
 *
 * onNewSession only flips the UI into a "pending new" state; the backend
 * session is materialised lazily by createPendingSession on the first send.
 * This lets the user switch projects in the Composer picker before sending,
 * so the session is created under the correct project instead of being bound
 * to the one that happened to be active when "新建" was clicked.
 */
import { useCallback } from "react";
import { useSessionStore } from "../../store/session-store";
import { useChatStore } from "../../store/chat-store";
import { getFocusSessionId, syncFocusSession } from "../../store/focus-session";
import { PENDING_DRAFT_KEY, useUiStore } from "../../store/ui-store";
import { isDefaultSessionTitle } from "../../utils/sessionTitle";
import { sessionStateMachine } from "../../store/session-state-machine";
import type { SessionSyncContext } from "./types";

export function usePendingSession(
  ctx: SessionSyncContext,
  onAddProject: () => Promise<void>,
) {
  const {
    session,
    chat,
    workspaceRef,
    pendingNewSessionRef,
    pendingProjectRef,
    creatingPendingSessionRef,
    setPendingNewSession,
    suppressReapplyRef,
  } = ctx;

  // Internal helper: create a backend session for the pending-new flow.
  // Returns the new session id, or null if creation failed.
  const createPendingSession = useCallback(async (): Promise<string | null> => {
    if (creatingPendingSessionRef.current) return creatingPendingSessionRef.current;
    const run = (async (): Promise<string | null> => {
      // Snapshot the project chosen in the composer BEFORE clearing pending flags.
      // Clicking send then immediately switching project must not rewrite this
      // binding — the new session and its file lookup stay on the send-time root.
      const pendingRoot = pendingProjectRef.current ?? workspaceRef.current?.root ?? null;
      pendingNewSessionRef.current = false;
      setPendingNewSession(false);
      pendingProjectRef.current = null;
      // Suppress applyOpened (re-triggered by openWorkspacePath → workspace:restored)
      // until we have materialised the new session and updated activeSessionId.
      // Otherwise applySessionState reads the stale backend activeId and reverts
      // the UI to the previous project, and the refresh storm trips rate limiting.
      suppressReapplyRef.current = true;
      try {
        // pending 模式下选项目只会乐观更新前端 workspace，后端仍停在进入新建时的项目。
        // 这里不能拿 workspaceRef 判断是否需要切换——它在 onSelectProject 里已被改成目标项目，
        // 会导致跳过后端 switch，会话仍创建到旧项目下。
        // 发送后立刻再切项目也只改前端 workspaceRef，所以必须用上面的快照，
        // 不能再读 workspaceRef.current。
        if (pendingRoot) {
          const projects = useSessionStore.getState().projects;
          const targetWs = {
            root: pendingRoot,
            name: projects.find((p) => p.root === pendingRoot)?.name ?? pendingRoot,
          };
          session.setWorkspace(targetWs);
          workspaceRef.current = targetWs;
          // 检查项目是否已加载，使用轻量级切换避免清理正在运行的会话
          const alreadyLoaded = Object.prototype.hasOwnProperty.call(
            useSessionStore.getState().sessionsByProject,
            pendingRoot,
          );
          if (alreadyLoaded) {
            await window.owncoder.switchWorkspacePath(pendingRoot);
          } else {
            await window.owncoder.openWorkspacePath(pendingRoot);
          }
        }
        const res = await window.owncoder.createChatSession("新会话");
        const newId = res.meta.id;
        // Switch the chat-store focus to the new session
        syncFocusSession(newId);
        chat.setHistory(res.history, newId);
        chat.setTerminal([], newId);
        chat.resetTurnState(newId);
        chat.setErrorAlert(null, newId);
        // Add the new session only under the project it was created for.
        // `sessions` mirrors the current workspace; never prepend onto a stale
        // list left over from the previous project — that is the cross-project
        // sidebar leak (foreign / duplicate titles under the new project).
        const meta = res.meta;
        const root = pendingRoot ?? workspaceRef.current?.root;
        if (root) {
          const prevMap = useSessionStore.getState().sessionsByProject;
          const list = prevMap[root] ?? [];
          const nextList = list.some((s) => s.id === meta.id) ? list : [meta, ...list];
          if (nextList !== list) {
            session.setSessionsByProject((prev) => ({ ...prev, [root]: nextList }));
          }
          // Keep the focused-project mirror aligned with the owning cache.
          if (workspaceRef.current?.root === root) {
            session.setSessions(nextList);
          }
        } else if (workspaceRef.current?.root == null) {
          const curSessions = useSessionStore.getState().sessions;
          if (!curSessions.some((s) => s.id === meta.id)) {
            session.setSessions([meta, ...curSessions]);
          }
        }
        return newId;
      } catch (err) {
        // Creation failed — re-arm pending-new so the user can retry send
        // without losing the project they already picked in the composer.
        pendingNewSessionRef.current = true;
        pendingProjectRef.current = pendingRoot;
        setPendingNewSession(true);
        throw err;
      } finally {
        // Keep applyOpened suppressed for a short window after the synchronous
        // body finishes. The workspace:restored event triggered by
        // openWorkspacePath is delivered asynchronously through IPC and will
        // fire after this finally block, so we must hold the suppression long
        // enough for that callback to see it. A short setTimeout also lets any
        // queued refresh storm (refreshProjects/refreshSessions/refreshChanges
        // /refreshGit) that applySessionState kicks off settle, so it does not
        // race with the in-flight sendChat and trip the backend rate limiter.
        setTimeout(() => {
          suppressReapplyRef.current = false;
        }, 1000);
      }
    })();
    creatingPendingSessionRef.current = run;
    try {
      return await run;
    } finally {
      if (creatingPendingSessionRef.current === run) {
        creatingPendingSessionRef.current = null;
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onNewSession = useCallback(async () => {
    if (!workspaceRef.current) {
      await onAddProject();
      return;
    }

    // Guard: already in pending-new state — nothing to do.
    if (pendingNewSessionRef.current) {
      return;
    }

    // Guard: if the current active session is already an empty "新会话",
    // reuse it instead of creating a duplicate.
    const activeId = getFocusSessionId();
    const drafts = useUiStore.getState().drafts;

    if (activeId) {
      const activeMeta = useSessionStore.getState().sessions.find((s) => s.id === activeId);
      const activeRuntime = useChatStore.getState().bySession[activeId];
      const hasDraft = drafts[activeId]?.trim();

      // 修复：只有在会话真正为空且用户没有输入草稿时才重用
      // 如果用户已经输入了内容但历史被意外清空，也应该创建新会话
      if (
        isDefaultSessionTitle(activeMeta?.title) &&
        (!activeRuntime || activeRuntime.history.length === 0) &&
        !hasDraft &&
        !sessionStateMachine.isBusy(activeId)
      ) {
        return;
      }
    } else {
      // 如果没有 activeId 但有 pending draft，也应该创建新会话
      const hasPendingDraft = drafts[PENDING_DRAFT_KEY]?.trim();
      if (!hasPendingDraft) {
        // 既没有 active session 也没有输入，可能是初次使用，允许创建
        // 不做任何阻止
      }
    }

    // Defer actual session creation to send time (createPendingSession is
    // called inside onSend). This way the user can switch projects in the
    // Composer picker before sending, and the session will be created under
    // the correct project rather than being bound to the current one.
    pendingNewSessionRef.current = true;
    pendingProjectRef.current = null;
    setPendingNewSession(true);

    // Detach the chat-store focus so the Composer's `sending` prop reads
    // from a clean empty runtime. Without this, when session A still has
    // an in-flight turn, the chat-store top-level `sending` mirrors
    // bySession[A].sending === true, leaking the stop button into the
    // brand-new session's composer. Session A's background runtime in
    // bySession[A] is untouched so its real turn continues to run.
    syncFocusSession(null);
  }, [onAddProject, chat]); // eslint-disable-line react-hooks/exhaustive-deps

  return { createPendingSession, onNewSession };
}
