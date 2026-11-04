/**
 * useSessionCrud
 *
 * Session-level mutations: delete (with cross-project handling, focus
 * hand-off to the adjacent session, and full store cleanup), pin, rename.
 * Delete and switch share the session state machine so concurrent mutations
 * on the same session are serialized.
 *
 * Also owns the periodic idle-session prune timer: pruneIdleSessions was only
 * called on session switch, so sessions opened without switching would keep
 * their full runtime (history, terminal, liveEvents) forever. The sweep bounds
 * renderer heap growth.
 */
import { useCallback, useEffect } from "react";
import { useChatStore } from "../../store/chat-store";
import { useSessionStore } from "../../store/session-store";
import { getFocusSessionId, syncFocusSession } from "../../store/focus-session";
import { useUiStore } from "../../store/ui-store";
import { dropQueue } from "../queue-controller";
import { sessionStateMachine } from "../../store/session-state-machine";
import type { SessionSyncContext } from "./types";

export function useSessionCrud(
  ctx: SessionSyncContext,
  onSwitchSession: (id: string, projectRoot?: string) => Promise<unknown>,
) {
  const { session, workspaceRef, sessionListSyncVersionRef, projectsSyncVersionRef } = ctx;

  const onDeleteSession = useCallback(
    async (id: string, projectRoot?: string) => {
      const ws = workspaceRef.current;
      const isCrossProject = projectRoot && ws?.root && projectRoot !== ws.root;

      // 使用状态机确保删除操作串行执行
      return sessionStateMachine.executeForSession(id, "delete", async () => {
        try {
          if (isCrossProject) {
            // Deleting from another project: remove from local store and delete file in backend.
            await window.owncoder.deleteChatSession(id, projectRoot);
            session.setSessionsByProject((prev) => {
              const list = prev[projectRoot!]?.filter((s) => s.id !== id) ?? [];
              return { ...prev, [projectRoot!]: list };
            });
            return;
          }

          // 记住删除前的当前选中会话，用于判断是否需要保持选中状态
          const currentFocusId = getFocusSessionId();
          const isDeletingCurrentSession = id === currentFocusId;

          const res = await window.owncoder.deleteChatSession(id);

          // Drop the deleted session's runtime from the chat store.
          ctx.chat.dropSession(id);
          dropQueue(id);
          // 清除该会话的变更列表和计划元数据，防止内存无限增长
          session.setChanges(id, []);
          session.setActivePlanMetaBySession(id, null);
          session.setActivePlanPath(null, id);
          session.setPlans([], id);
          // 清除该会话的草稿（含 localStorage）
          useUiStore.getState().clearDraft(id);

          // 清理状态机中的会话状态
          sessionStateMachine.cleanup(id);

          if (res.activeId) {
            // 如果删除的是当前选中的会话，切换到后端返回的相邻会话；
            // 删除其他会话时保持当前选中状态不变。
            const targetSessionId = isDeletingCurrentSession ? res.activeId : currentFocusId;

            if (targetSessionId !== currentFocusId && targetSessionId !== null) {
              // 必须走与手动切换完全相同的加载流程（switchChatSession +
              // getChatHistoryPage 分页历史）。不能直接用 res.history：
              // 它来自主进程 getHistory()，只是受 RECENT_LIMIT 截断的 runtime
              // 尾部历史，直接 setHistory 会导致界面只剩最后一轮回复。
              await onSwitchSession(targetSessionId);
            }
            // 如果保持当前会话不变，不需要切换或重新加载历史
          } else {
            // No sessions left: clear every session-derived field in both stores so
            // the UI doesn't end up with mismatched pointers or a stale title from
            // the deleted session lingering above the composer. Match the backend,
            // which now clears state.sessionTitle on last-session delete.
            syncFocusSession(null);
            session.setSessionTitle(null);
            // 清空变更列表中被删除会话的数据
            session.setChanges(id, []);
            session.setActivePlanPath(null, id);
            session.setActivePlanMeta(null);
            session.setPlans([], id);
          }

          // 本地从当前 store 数组里去掉该项；不要用 hook 闭包里的 session.sessions（会过期）
          const prevSessions = useSessionStore.getState().sessions;
          const nextSessions = prevSessions.filter((s) => s.id !== id);
          session.setSessions(nextSessions);
          if (ws?.root) {
            session.setSessionsByProject((prev) => ({
              ...prev,
              [ws.root]: (prev[ws.root] ?? prevSessions).filter((s) => s.id !== id),
            }));
          }

          // 删除后聚焦窗口
          window.owncoder.focusWindow();
        } catch (error) {
          console.error("[onDeleteSession] 删除会话失败:", error);
          // 删除失败时，确保状态机清理（避免死锁）
          sessionStateMachine.reset(id);
          throw error;
        }
      });
    },
    [onSwitchSession],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const onPinSession = useCallback(async (id: string, projectRoot: string) => {
    const res = await window.owncoder.pinChatSession(id, projectRoot);
    if (workspaceRef.current?.root === projectRoot) session.setSessions(res.list.sessions);
    session.setSessionsByProject((prev) => ({ ...prev, [projectRoot]: res.list.sessions }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onRenameSession = useCallback(async (id: string, title: string, projectRoot: string) => {
    const meta = await window.owncoder.renameChatSession(id, title, projectRoot);
    // 重命名前发出的列表请求可能携带旧名称，不能再覆盖保存成功的结果。
    ++sessionListSyncVersionRef.current;
    ++projectsSyncVersionRef.current;
    const current = useSessionStore.getState();
    if (workspaceRef.current?.root === projectRoot) {
      session.setSessions(current.sessions.map((s) => (s.id === id ? meta : s)));
      if (current.activeSessionId === id) session.setSessionTitle(meta.title);
    }
    session.setSessionsByProject((prev) => ({
      ...prev,
      [projectRoot]: (prev[projectRoot] ?? []).map((s) => (s.id === id ? meta : s)),
    }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Periodic idle-session prune ───────────────────────────────────────────
  // pruneIdleSessions was only called on session switch. If the user opens
  // many sessions without switching (e.g. sidebar clicks, command palette),
  // each session's full runtime (history, terminal, liveEvents) stays in
  // the bySession map indefinitely. Run a sweep every 2 minutes to drop
  // idle runtimes and bound renderer heap growth.
  useEffect(() => {
    const INTERVAL_MS = 2 * 60 * 1000;
    const timer = setInterval(() => {
      const activeId = useChatStore.getState().activeSessionId;
      if (!activeId) return;
      const dropped = useChatStore.getState().pruneIdleSessions([activeId]);
      for (const droppedId of dropped) {
        dropQueue(droppedId);
        useSessionStore.getState().setChanges(droppedId, []);
        useSessionStore.getState().setActivePlanMetaBySession(droppedId, null);
        useSessionStore.getState().setActivePlanPath(null, droppedId);
        useSessionStore.getState().setPlans([], droppedId);
      }
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { onDeleteSession, onPinSession, onRenameSession };
}
