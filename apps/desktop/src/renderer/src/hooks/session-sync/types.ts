/**
 * Shared types for the useSessionSync split.
 *
 * useSessionSync is an aggregator over several sub-hooks (refreshers, state
 * apply, project actions, pending-new creation, session switch, session CRUD).
 * They all communicate through a single SessionSyncContext object that holds
 * the cross-cutting refs and stable store handles, so no module needs to reach
 * into another module's internals.
 */
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { WorkspaceInfo } from "@owncoder/shared";
import type { useSessionStore } from "../../store/session-store";
import type { useChatStore } from "../../store/chat-store";

/** Snapshot of the session store taken once per render; its actions are stable. */
export type SessionStoreApi = ReturnType<typeof useSessionStore.getState>;
/** Snapshot of the chat store taken once per render; its actions are stable. */
export type ChatStoreApi = ReturnType<typeof useChatStore.getState>;

/**
 * Everything the useSessionSync sub-hooks share. Refs keep callbacks stable
 * across renders; the version counters race-guard stale IPC responses.
 */
export interface SessionSyncContext {
  session: SessionStoreApi;
  chat: ChatStoreApi;
  /** Stable ref mirror of workspace so callbacks that close over it stay stable. */
  workspaceRef: MutableRefObject<WorkspaceInfo | null>;
  sessionListSyncVersionRef: MutableRefObject<number>;
  projectsSyncVersionRef: MutableRefObject<number>;
  gitSyncVersionRef: MutableRefObject<number>;
  navigationVersionRef: MutableRefObject<number>;
  navigationTailRef: MutableRefObject<Promise<void>>;
  /** onSelectProject 的快速路径需要复用 switchSessionInternal（加载历史/标题等），
   *  但它定义在后面；用 ref 避免声明顺序与循环依赖问题。 */
  switchSessionInternalRef: MutableRefObject<
    (id: string, version: number, rollbackId?: string | null, projectRoot?: string) => Promise<unknown>
  >;
  onSwitchSessionRef: MutableRefObject<(id: string) => Promise<unknown>>;
  previousSessionIdRef: MutableRefObject<string | null>;
  /** Serialized navigation queue: later navigations invalidate earlier ones. */
  enqueueNavigation: <T>(work: (version: number) => Promise<T>) => Promise<T>;
  isNavigationCurrent: (version: number) => boolean;
  // ── Deferred session creation (方案B) ──────────────────────────────────────
  pendingNewSessionRef: MutableRefObject<boolean>;
  pendingProjectRef: MutableRefObject<string | null>;
  creatingPendingSessionRef: MutableRefObject<Promise<string | null> | null>;
  pendingNewSession: boolean;
  setPendingNewSession: Dispatch<SetStateAction<boolean>>;
  /** While set, applyOpened is a no-op (see useApplySession for the race it guards). */
  suppressReapplyRef: MutableRefObject<boolean>;
}
