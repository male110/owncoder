/**
 * useSessionSync
 *
 * Owns all IPC calls that read/sync server-side session state into the stores:
 *   - workspace open/switch
 *   - session list / create / switch / delete / pin
 *   - session state (mode, plan, git, models…)
 *   - changes, plans, git refresh
 *   - project management
 *
 * Components call the returned action functions; they never call IPC directly
 * for state-affecting operations.
 *
 * This file is the aggregation entry point. The implementation lives in the
 * session-sync/ sub-hooks, which share state through a SessionSyncContext
 * (cross-cutting refs, navigation version counters, stable store handles):
 *   - useSyncRefreshers  low-level IPC refreshers (git/changes/plans/sessions/projects)
 *   - useApplySession    full state sync (applySessionState / applyHistory / applyOpened)
 *   - useProjectActions  project select/add/move/expand/remove
 *   - usePendingSession  deferred "新建" creation (方案B)
 *   - useSessionSwitch   session switching (state-machine serialized)
 *   - useSessionCrud     session delete/pin/rename + idle prune timer
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionStore } from "../store/session-store";
import { useChatStore } from "../store/chat-store";
import { useSyncRefreshers } from "./session-sync/useSyncRefreshers";
import { useApplySession } from "./session-sync/useApplySession";
import { useProjectActions } from "./session-sync/useProjectActions";
import { usePendingSession } from "./session-sync/usePendingSession";
import { useSessionSwitch } from "./session-sync/useSessionSwitch";
import { useSessionCrud } from "./session-sync/useSessionCrud";
import type { SessionSyncContext } from "./session-sync/types";

export function useSessionSync() {
  // Subscribe only to the local pending-new flag. Store actions are stable and
  // all server state is read imperatively at the point of use.
  const session = useSessionStore.getState();
  const chat = useChatStore.getState();

  // Stable ref mirror of workspace so callbacks that close over it stay stable.
  const workspaceRef = useRef(useSessionStore.getState().workspace);
  const sessionListSyncVersionRef = useRef(0);
  const projectsSyncVersionRef = useRef(0);
  const gitSyncVersionRef = useRef(0);
  const navigationVersionRef = useRef(0);
  const navigationTailRef = useRef<Promise<void>>(Promise.resolve());
  const switchSessionInternalRef = useRef<
    (id: string, version: number, rollbackId?: string | null, projectRoot?: string) => Promise<unknown>
  >(async () => {});
  const previousSessionIdRef = useRef<string | null>(null);

  // ── Navigation serialization ──────────────────────────────────────────────
  // Later navigations invalidate earlier ones: a queued callback whose version
  // no longer matches bails out instead of writing stale state.
  const enqueueNavigation = useCallback(<T,>(work: (version: number) => Promise<T>): Promise<T> => {
    const version = ++navigationVersionRef.current;
    const run = navigationTailRef.current.then(() => {
      if (version !== navigationVersionRef.current) return undefined as T;
      return work(version);
    });
    navigationTailRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);
  const isNavigationCurrent = useCallback(
    (version: number) => version === navigationVersionRef.current,
    [],
  );
  useEffect(() => {
    const unsub = useSessionStore.subscribe((s) => {
      workspaceRef.current = s.workspace;
    });
    return unsub;
  }, []);

  // ── Deferred session creation (方案B) ──────────────────────────────────────
  // When true, onNewSession puts the UI in a "pending new" state instead of
  // immediately creating a backend session. The actual session is created on
  // the first onSend call.
  const pendingNewSessionRef = useRef(false);
  const [pendingNewSession, setPendingNewSession] = useState(false);
  // Tracks which project root the user selected while in pending-new state.
  // createPendingSession uses this to create the backend session under the
  // correct project rather than the project that was active when "新建" was clicked.
  const pendingProjectRef = useRef<string | null>(null);
  // While createPendingSession is in flight, later project clicks must not
  // switch the backend workspace — that would bind the new session's file
  // lookup to the post-send project instead of the send-time one.
  const creatingPendingSessionRef = useRef<Promise<string | null> | null>(null);
  // onSelectProject 的快速路径需要复用 onSwitchSession（加载历史/标题等），
  // 但 onSwitchSession 定义在后面；用 ref 避免声明顺序与循环依赖问题。
  const onSwitchSessionRef = useRef<(id: string) => Promise<unknown>>(async () => {});
  // While a pending-new session is being materialised, the main process emits a
  // workspace:restored event that would race with the in-flight creation.
  // See useApplySession for the full rationale.
  const suppressReapplyRef = useRef(false);

  // Shared context handed to every sub-hook: refs + version counters + store
  // handles, so no sub-hook needs to reach into another sub-hook's internals.
  const ctx: SessionSyncContext = {
    session,
    chat,
    workspaceRef,
    sessionListSyncVersionRef,
    projectsSyncVersionRef,
    gitSyncVersionRef,
    navigationVersionRef,
    navigationTailRef,
    switchSessionInternalRef,
    onSwitchSessionRef,
    previousSessionIdRef,
    enqueueNavigation,
    isNavigationCurrent,
    pendingNewSessionRef,
    pendingProjectRef,
    creatingPendingSessionRef,
    pendingNewSession,
    setPendingNewSession,
    suppressReapplyRef,
  };

  // ── Sub-hooks (order matters: later ones depend on earlier outputs) ────────
  const refreshers = useSyncRefreshers(ctx);
  const { applySessionState, applyHistory, applyOpened, applyOpenedInternal } = useApplySession(ctx, refreshers);
  const { onSelectProject, onAddProject, onToggleExpand, onRemoveProject, onMoveProject } = useProjectActions(
    ctx,
    refreshers,
    applyOpened,
    applyOpenedInternal,
  );
  const { createPendingSession, onNewSession } = usePendingSession(ctx, onAddProject);
  const { switchSessionInternal, onSwitchSession } = useSessionSwitch(ctx, refreshers, applyHistory);
  const { onDeleteSession, onPinSession, onRenameSession } = useSessionCrud(ctx, onSwitchSession);

  // Wire the forward references: the project fast path and the pending-new
  // flow call into session switching before it is defined above.
  onSwitchSessionRef.current = onSwitchSession;
  switchSessionInternalRef.current = switchSessionInternal;

  return {
    // Refreshers (used by chat hook after a turn)
    refreshGit: refreshers.refreshGit,
    refreshChanges: refreshers.refreshChanges,
    refreshPlans: refreshers.refreshPlans,
    refreshSpecs: refreshers.refreshSpecs,
    refreshActivePlan: refreshers.refreshActivePlan,
    refreshSessions: refreshers.refreshSessions,
    // Full sync
    applySessionState,
    applyHistory,
    applyOpened,
    // Actions
    onAddProject,
    onSelectProject,
    onToggleExpand,
    onRemoveProject,
    onMoveProject,
    onNewSession,
    onSwitchSession,
    onDeleteSession,
    onPinSession,
    onRenameSession,
    // Deferred session creation (方案B)
    pendingNewSession,
    pendingNewSessionRef,
    createPendingSession,
  };
}
