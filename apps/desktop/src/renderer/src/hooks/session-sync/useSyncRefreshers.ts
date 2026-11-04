/**
 * useSyncRefreshers
 *
 * Low-level IPC refreshers that pull server-side state into the stores:
 * git status, pending changes, plans, active plan, session list, project list.
 * Each one is version-guarded so a stale response can never overwrite newer
 * state (e.g. after a workspace switch or a newer refresh).
 */
import { useCallback } from "react";
import { useSessionStore } from "../../store/session-store";
import { getFocusSessionId } from "../../store/focus-session";
import { isDefaultSessionTitle } from "../../utils/sessionTitle";
import { toAppError } from "../../components/ErrorBanner";
import { t } from "../../../../shared/i18n/core";
import type { SessionSyncContext } from "./types";

/** Return type of useSyncRefreshers — the six version-guarded IPC refreshers. */
export type SyncRefreshers = ReturnType<typeof useSyncRefreshers>;

export function useSyncRefreshers(ctx: SessionSyncContext) {
  const { session, chat, workspaceRef, gitSyncVersionRef, sessionListSyncVersionRef, projectsSyncVersionRef } = ctx;

  const refreshGit = useCallback(
    async (expectedRoot?: string) => {
      const rootAtStart = expectedRoot ?? workspaceRef.current?.root ?? null;
      const version = ++gitSyncVersionRef.current;
      try {
        const status = await window.owncoder.getGitStatus(rootAtStart ?? undefined);
        if (version === gitSyncVersionRef.current && (workspaceRef.current?.root ?? null) === rootAtStart) {
          session.setGitStatus(status);
        }
      } catch {
        if (version === gitSyncVersionRef.current && (workspaceRef.current?.root ?? null) === rootAtStart) {
          session.setGitStatus(null);
        }
      }
    },
    [],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshChanges = useCallback(
    async (sessionId?: string) => {
      try {
        // 显式传入 sessionId，确保获取正确会话的变更
        const sid = sessionId ?? getFocusSessionId();
        if (!sid) {
          // 没有活跃会话时清空变更列表
          return;
        }
        const pending = await window.owncoder.getPendingChanges(sid);
        session.setChanges(sid, pending.files);
        // The session pointed at a checkpoint that is no longer on disk. Say so —
        // an empty change list would otherwise read as "nothing to undo".
        if (pending.expired) {
          chat.setErrorAlert(
            toAppError(t("本次会话的检查点已不在磁盘上，这些文件修改无法再通过「撤销」回滚。")),
            sid,
          );
        }
      } catch {
        const sid = sessionId ?? getFocusSessionId();
        if (sid) session.setChanges(sid, []);
      }
    },
    [],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshPlans = useCallback(
    async (sessionId?: string) => {
      try {
        // Plans are scoped to the chat session that saved them: pass the focus
        // session id so a new session does not surface other sessions' plans.
        const sid = sessionId ?? getFocusSessionId() ?? undefined;
        session.setPlans(await window.owncoder.listPlans(sid), sid);
      } catch {
        const sid = sessionId ?? getFocusSessionId() ?? undefined;
        session.setPlans([], sid);
      }
    },
    [],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshSpecs = useCallback(
    async (sessionId?: string) => {
      try {
        const sid = sessionId ?? getFocusSessionId() ?? undefined;
        session.setSpecs(await window.owncoder.listSpecs(sid), sid);
      } catch {
        const sid = sessionId ?? getFocusSessionId() ?? undefined;
        session.setSpecs([], sid);
      }
    },
    [],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshActivePlan = useCallback(
    async (sessionId?: string) => {
      const sid = sessionId ?? getFocusSessionId();
      try {
        if (!sid) {
          session.setActivePlanMeta(null);
          return null;
        }
        const meta = await window.owncoder.getActivePlan(sid);
        // 写到目标会话自己的缓存。切焦点后才回来的响应，不会污染当前会话。
        session.setActivePlanMetaBySession(sid, meta);
        return meta;
      } catch {
        if (sid) session.setActivePlanMetaBySession(sid, null);
        else session.setActivePlanMeta(null);
        return null;
      }
    },
    [],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshSessions = useCallback(async () => {
    const version = ++sessionListSyncVersionRef.current;
    const root = workspaceRef.current?.root;
    if (!root) {
      if (version === sessionListSyncVersionRef.current) {
        session.setSessions([]);
        session.setActiveSessionId(null);
      }
      return;
    }

    const list = await window.owncoder.listChatSessions(root);
    // A response that started before a newer refresh—or for a workspace that
    // is no longer active—must not overwrite the latest session metadata.
    if (version !== sessionListSyncVersionRef.current || workspaceRef.current?.root !== root) {
      return;
    }
    // Preserve in-memory provisional titles: if the user just sent a message in
    // a session whose backend title is still "新会话", keep the provisional title
    // we already applied in applyProvisionalTitleIfNeeded. Otherwise a pending
    // refreshSessions (e.g. from applySessionState inside onNewSession) would
    // overwrite the sidebar title back to "新会话" before the turn completes.
    // Prefer the project cache over the focused `sessions` mirror so a
    // mid-turn project switch does not lose the provisional title.
    const state = useSessionStore.getState();
    const prevByProject = state.sessionsByProject[root] ?? [];
    const titleSource = [...prevByProject, ...state.sessions];
    const merged = list.sessions.map((s) => {
      const prev = titleSource.find((p) => p.id === s.id);
      // 后端标题仍是默认占位时，保留内存中已应用的临时/固定标题，
      // 避免一次 refreshSessions 把侧栏标题打回"新会话"。
      if (prev && !isDefaultSessionTitle(prev.title) && isDefaultSessionTitle(s.title)) {
        return { ...s, title: prev.title };
      }
      return { ...s, projectRoot: s.projectRoot || root };
    });
    session.setSessions(merged);
    // Do NOT overwrite activeSessionId here. The backend index.activeId reflects
    // the last-saved session, not the user's current focus. Overwriting it when a
    // background session completes (applyChatResult → refreshSessions) would hijack
    // the focus, switching the UI to the just-finished session. The active session
    // is set explicitly by applySessionState / onSwitchSession / onNewSession.
    session.setSessionsByProject((prev) => ({ ...prev, [root]: merged }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshProjects = useCallback(async () => {
    const version = ++projectsSyncVersionRef.current;
    const rootAtStart = workspaceRef.current?.root ?? null;
    const list = await window.owncoder.listProjects();
    if (version !== projectsSyncVersionRef.current || workspaceRef.current?.root !== rootAtStart) {
      return [];
    }
    session.setProjects(list);
    session.setExpanded((prev) => {
      const next = { ...prev };
      const currentRoot = workspaceRef.current?.root;
      for (const p of list) {
        if (next[p.root] === undefined) next[p.root] = p.root === currentRoot;
      }
      return next;
    });
    const map: Record<string, import("../../../../preload/index").ChatSessionMetaDto[]> = {};
    await Promise.all(
      list.map(async (p) => {
        const res = await window.owncoder.listChatSessions(p.root);
        map[p.root] = res.sessions.map((item) => ({ ...item, projectRoot: item.projectRoot || p.root }));
      }),
    );
    if (version === projectsSyncVersionRef.current && workspaceRef.current?.root === rootAtStart) {
      session.setSessionsByProject(() => map);
    }
    return list;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    refreshGit,
    refreshChanges,
    refreshPlans,
    refreshSpecs,
    refreshActivePlan,
    refreshSessions,
    refreshProjects,
  };
}
