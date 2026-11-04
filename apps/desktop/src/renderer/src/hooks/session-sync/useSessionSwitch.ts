/**
 * useSessionSwitch
 *
 * Session switching: switchSessionInternal performs the full optimistic +
 * backend-backed switch (state-machine serialized, navigation-version
 * guarded), and onSwitchSession is its queue-serialized public wrapper.
 *
 * switchSessionInternal is also reused by the project fast path through
 * switchSessionInternalRef, so cross-project clicks load history exactly like
 * a manual session click.
 */
import { useCallback } from "react";
import { useChatStore } from "../../store/chat-store";
import { useSessionStore } from "../../store/session-store";
import { getFocusSessionId, syncFocusSession } from "../../store/focus-session";
import { dropQueue, hydrateQueue, resumeQueue } from "../queue-controller";
import { sessionStateMachine } from "../../store/session-state-machine";
import type { SessionSyncContext } from "./types";
import type { SyncRefreshers } from "./useSyncRefreshers";

export function useSessionSwitch(
  ctx: SessionSyncContext,
  refreshers: SyncRefreshers,
  applyHistory: (turns: import("../../../../preload/index").ChatTurnDto[], sid?: string) => void,
) {
  const {
    session,
    chat,
    workspaceRef,
    pendingNewSessionRef,
    pendingProjectRef,
    previousSessionIdRef,
    setPendingNewSession,
    enqueueNavigation,
    isNavigationCurrent,
  } = ctx;
  const { refreshChanges, refreshPlans, refreshSpecs, refreshActivePlan, refreshSessions } = refreshers;

  const switchSessionInternal = useCallback(
    async (
      id: string,
      navigationVersion: number,
      rollbackId = getFocusSessionId(),
      projectRoot?: string,
    ) => {
      previousSessionIdRef.current = rollbackId;
      // 取消 pending-new 状态
      pendingNewSessionRef.current = false;
      pendingProjectRef.current = null;
      setPendingNewSession(false);

      // 使用状态机确保串行执行，避免并发切换导致的状态混乱
      return sessionStateMachine.executeForSession(id, "switch", async () => {
        try {
          // 1. 立即更新 UI 状态（乐观更新）- 让用户感觉切换很快
          syncFocusSession(id);

          // 2. 检查缓存状态
          const existing = useChatStore.getState().bySession[id];
          const isFirstVisit = !existing?.history?.length;

          // 3. Always notify main so it can persist+unload the previous idle
          // runtime. Skipping this on cache hits was the multi-session OOM path:
          // renderer kept bySession forever and main never called unloadIdleRuntime.
          const targetRoot = projectRoot ?? workspaceRef.current?.root;
          if (targetRoot && workspaceRef.current?.root !== targetRoot) {
            await window.owncoder.switchWorkspacePath(targetRoot);
            if (!isNavigationCurrent(navigationVersion)) return;
            const targetProject = useSessionStore.getState().projects.find((p) => p.root === targetRoot);
            const targetWorkspace = { root: targetRoot, name: targetProject?.name ?? targetRoot };
            session.setWorkspace(targetWorkspace);
            session.setSessions(useSessionStore.getState().sessionsByProject[targetRoot] ?? []);
            workspaceRef.current = targetWorkspace;
          }
          const backendData = await window.owncoder.switchChatSession(id, targetRoot);
          // 导航版本过期则丢弃后端数据，防止竞态条件写入错误会话
          if (!isNavigationCurrent(navigationVersion)) return;
          // await 期间 applySessionState 可能读到后端尚未切换完的 A1；再次锁定 B1。
          syncFocusSession(id);
          // 即使后续导航版本已过期，也先把后端快照写入 bySession[id]。
          // 跨项目首次点历史会话时，乐观 syncFocusSession 会先露出空 runtime；
          // 若上面已因 navigationVersion 过期 return，则不会走到这里。
          if (isFirstVisit || !existing?.history?.length) {
            if (backendData.history?.length) {
              applyHistory(backendData.history, id);
            }
          }
          if (!existing?.terminal?.length) {
            chat.setTerminal(backendData.terminal, id);
          }
          if (!(existing?.queuedMessages?.length)) {
            hydrateQueue(id, backendData.state.queuedMessages ?? []);
          }

          // 3b. 刷新变更列表（总是刷新，因为可能在其他会话中修改了文件）
          await refreshChanges(id).catch((err) => {
            console.warn("[onSwitchSession] 刷新变更列表失败:", err);
          });
          if (!isNavigationCurrent(navigationVersion)) return;

          // 4. Apply backend snapshot. On cache hits prefer in-memory history
          // (may include newer sealed liveEvents) but still sync mode/title/plan.
          // getChatHistoryPage 负责分页游标；若 conversation store 暂空，保留上面
          // 已写入的 runtime history，避免空页把首屏消息盖掉。
          if (isFirstVisit || !existing?.history?.length) {
            const page = await window.owncoder.getChatHistoryPage(id, undefined, 10);
            if (!isNavigationCurrent(navigationVersion)) return;
            const currentHistory = useChatStore.getState().bySession[id]?.history ?? [];
            if (page.turns.length > 0 || currentHistory.length === 0) {
              applyHistory(page.turns, id);
            }
            chat.setHistoryPageState(
              { historyBeforeSeq: page.beforeSeq, historyHasMore: page.hasMore, historyLoading: false },
              id,
            );
          }
          session.setMode(backendData.state.mode);
          session.setSessionTitle(backendData.state.sessionTitle);
          session.setActivePlanPath(backendData.state.activePlanPath, id);
          if (useSessionStore.getState().llmConfigured && workspaceRef.current) {
            resumeQueue(id);
          }

          // Bound renderer heap: drop idle session runtimes with no in-flight work.
          const dropped = useChatStore.getState().pruneIdleSessions([id]);
          for (const droppedId of dropped) {
            dropQueue(droppedId);
            session.setChanges(droppedId, []);
            session.setActivePlanMetaBySession(droppedId, null);
            session.setActivePlanPath(null, droppedId);
            session.setPlans([], droppedId);
          }

          // 5. 后台刷新其他数据（不阻塞切换完成）
          // 这些操作失败不影响会话切换的成功
          // 显式传入会话ID，避免竞态条件导致获取到旧的activeSessionId
          if (!isNavigationCurrent(navigationVersion)) return;
          void Promise.all([
            refreshPlans(id).catch((err) => console.warn("[onSwitchSession] 刷新计划列表失败:", err)),
            refreshSpecs(id).catch((err) => console.warn("[onSwitchSession] 刷新 spec 列表失败:", err)),
            refreshActivePlan(id).catch((err) => console.warn("[onSwitchSession] 刷新活动计划失败:", err)),
            refreshSessions().catch((err) => console.warn("[onSwitchSession] 刷新会话列表失败:", err)),
          ]);
        } catch (error) {
          console.error("[onSwitchSession] 会话切换失败:", error);
          // 切换失败时，回滚 UI 状态
          const previousSessionId = previousSessionIdRef.current;
          if (!isNavigationCurrent(navigationVersion)) {
            throw error;
          }
          if (previousSessionId) {
            syncFocusSession(previousSessionId);
          } else {
            syncFocusSession(null);
          }
          throw error;
        }
      });
    },
    [applyHistory, isNavigationCurrent, refreshPlans, refreshActivePlan, refreshSessions, refreshChanges],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const onSwitchSession = useCallback(
    (id: string, projectRoot?: string) =>
      enqueueNavigation((navigationVersion) =>
        switchSessionInternal(id, navigationVersion, getFocusSessionId(), projectRoot),
      ),
    [enqueueNavigation, switchSessionInternal],
  );

  return { switchSessionInternal, onSwitchSession };
}
