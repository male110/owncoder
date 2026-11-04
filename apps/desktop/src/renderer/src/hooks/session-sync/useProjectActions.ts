/**
 * useProjectActions
 *
 * Project-level actions: select (with fast/slow paths), add via dialog,
 * move order, toggle expand, remove. Selecting a project is navigation, so
 * every path is funneled through the serialized navigation queue and the
 * shared switchSessionInternalRef so the session-switch flow stays identical
 * to a manual click.
 */
import { useCallback } from "react";
import { useSessionStore } from "../../store/session-store";
import { syncFocusSession } from "../../store/focus-session";
import { t } from "../../../../shared/i18n/core";
import type { SessionSyncContext } from "./types";
import type { SyncRefreshers } from "./useSyncRefreshers";

export function useProjectActions(
  ctx: SessionSyncContext,
  refreshers: SyncRefreshers,
  applyOpened: (targetWorkspace?: import("@owncoder/shared").WorkspaceInfo, opts?: { sanitize?: boolean; navigationVersion?: number }) => Promise<unknown>,
  applyOpenedInternal: (targetWorkspace?: import("@owncoder/shared").WorkspaceInfo, opts?: { sanitize?: boolean; navigationVersion?: number }) => Promise<void>,
) {
  const {
    session,
    workspaceRef,
    gitSyncVersionRef,
    pendingNewSessionRef,
    pendingProjectRef,
    creatingPendingSessionRef,
    setPendingNewSession,
    switchSessionInternalRef,
    enqueueNavigation,
    isNavigationCurrent,
  } = ctx;
  const { refreshGit, refreshProjects } = refreshers;

  const onSelectProject = useCallback(
    (root: string, focusSessionId?: string) =>
      enqueueNavigation(async (navigationVersion) => {
        const projects = useSessionStore.getState().projects;
        if (workspaceRef.current?.root !== root) {
          ++gitSyncVersionRef.current;
          session.setGitStatus(null);
        }

        // In pending-new mode, just record the user's project choice without
        // switching the backend workspace or loading an existing session.
        // The actual switch + session creation happens in createPendingSession.
        // Still mirror the target project's cached session list into `sessions`
        // so AgentSidebar (which reads `sessions` for the current project) does
        // not keep showing the previous project's rows / duplicate titles.
        if (pendingNewSessionRef.current) {
          const targetWs = { root, name: projects.find((p) => p.root === root)?.name ?? root };
          pendingProjectRef.current = root;
          session.setWorkspace(targetWs);
          session.setExpanded((e) => ({ ...e, [root]: true }));
          workspaceRef.current = targetWs;
          const cached = useSessionStore.getState().sessionsByProject[root] ?? [];
          session.setSessions(cached);
          await refreshGit(root);
          return;
        }

        // A send-time session is still being created under the previously chosen
        // project. Wait for that bind to finish, then switch UI/backend to the
        // newly clicked project. Do not cancel the in-flight create.
        if (creatingPendingSessionRef.current) {
          await creatingPendingSessionRef.current;
          if (!isNavigationCurrent(navigationVersion)) return;
        } else {
          // Switching project cancels any pending-new state.
          pendingNewSessionRef.current = false;
          pendingProjectRef.current = null;
          setPendingNewSession(false);
        }

        const workspace = workspaceRef.current;

        // 点击的是当前项目 → 仅切换展开/折叠，不重新加载。
        // 若调用方同时指定了 focusSessionId（跨项目点会话的原子路径），则继续切会话。
        if (workspace?.root === root && !focusSessionId) {
          session.setExpanded((e) => ({ ...e, [root]: !(e[root] !== false) }));
          return;
        }

        const targetWs = { root, name: projects.find((p) => p.root === root)?.name ?? root };

        // 先检查项目是否已加载
        const alreadyLoaded = Object.prototype.hasOwnProperty.call(
          useSessionStore.getState().sessionsByProject,
          root,
        );

        if (alreadyLoaded) {
          // 快速路径：更新后端工作空间 + 前端缓存，跳过昂贵的 applyOpened。
          // 项目切换必须同时切换焦点会话；否则 activeSessionId 仍指向旧项目，
          // 旧项目的消息、计划和队列就会被错误地显示在当前项目下。
          const state = useSessionStore.getState();
          const cached = state.sessionsByProject[root] ?? [];
          const cachedActiveId = state.activeSessionIdByProject[root];
          // 侧栏跨项目点具体会话时，优先聚焦用户点击的会话，避免先切到缓存活跃会话
          // 再被后续 onSwitchSession 二次入队抬高 navigationVersion，把历史写入取消掉。
          const targetSessionId =
            focusSessionId && cached.some((item) => item.id === focusSessionId)
              ? focusSessionId
              : cachedActiveId && cached.some((item) => item.id === cachedActiveId)
                ? cachedActiveId
                : cached[0]?.id ?? null;

          // 先完成主进程的 workspace 绑定，再更新 renderer 的当前项目。
          // 在 IPC 完成前修改 workspaceRef 会让刷新请求以为已经在 B，
          // 但主进程仍在 A，从而把首次跨项目加载的状态串到错误项目。
          if (workspace?.root !== root) {
            await window.owncoder.switchWorkspacePath(root);
            if (!isNavigationCurrent(navigationVersion)) return;
          }
          session.setWorkspace(targetWs);
          session.setSessions(cached);
          session.setExpanded((e) => ({ ...e, [root]: true }));
          workspaceRef.current = targetWs;

          // 必须走完整会话切换：仅 syncFocusSession 只会更新左侧选中态，
          // 若 bySession 尚无该会话历史，右侧仍会显示空/新会话界面。
          // onSwitchSession 会通知后端、加载历史/标题/计划，并与侧栏选中态对齐。
          if (targetSessionId) {
            await switchSessionInternalRef.current(targetSessionId, navigationVersion, null);
          } else {
            syncFocusSession(null);
          }
          // 工作区已变，git 状态需按新项目刷新（onSwitchSession 不负责这项）。
          if (workspace?.root !== root) {
            await refreshGit(root);
          }
          return;
        }

        // 慢速路径：项目未加载，需要完整初始化
        const ws = await window.owncoder.openWorkspacePath(root);
        if (ws && isNavigationCurrent(navigationVersion)) {
          session.setWorkspace(targetWs);
          session.setExpanded((e) => ({ ...e, [root]: true }));
          workspaceRef.current = targetWs;
          await applyOpenedInternal(targetWs, { navigationVersion });
          if (focusSessionId && isNavigationCurrent(navigationVersion)) {
            await switchSessionInternalRef.current(focusSessionId, navigationVersion, null);
          }
        }
      }),
    [applyOpenedInternal, enqueueNavigation, isNavigationCurrent, refreshGit],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const onAddProject = useCallback(async () => {
    const ws = await window.owncoder.openWorkspaceDialog();
    if (!ws) return;
    if (pendingNewSessionRef.current) {
      // 与选择已有项目保持一致，覆盖草稿原先选择的项目归属。
      await onSelectProject(ws.root);
      await refreshProjects();
    } else {
      await applyOpened(ws);
    }
  }, [applyOpened, onSelectProject, refreshProjects]);

  const onMoveProject = useCallback(async (root: string, targetRoot: string, after: boolean) => {
    const projects = await window.owncoder.moveProject(root, targetRoot, after);
    // Invalidate an in-flight refresh so it cannot restore the previous order.
    ++ctx.projectsSyncVersionRef.current;
    session.setProjects(projects);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onToggleExpand = useCallback((root: string) => {
    session.setExpanded((e) => ({ ...e, [root]: !(e[root] !== false) }));
  }, []);

  const onRemoveProject = useCallback(
    async (root: string) => {
      // 存在运行中/未结束的会话时禁止删除
      const projectSessions = useSessionStore.getState().sessionsByProject[root] ?? [];
      const chatStore = ctx.chat;
      if (projectSessions.some((s) => chatStore.isSessionSending(s.id))) {
        alert(t("该项目存在运行中的会话，请等待会话结束后再删除。"));
        return;
      }
      // 删除前确定下一个要切换为当前项目的项目
      const projects = useSessionStore.getState().projects;
      const idx = projects.findIndex((p) => p.root === root);
      const nextProject = projects[idx + 1] ?? projects[idx - 1] ?? null;
      const wasCurrent = workspaceRef.current?.root === root;
      await window.owncoder.removeProject(root);
      await refreshProjects();
      // 删除的是当前项目时，切换到下一个项目
      if (wasCurrent && nextProject) {
        await onSelectProject(nextProject.root);
      }
    },
    [refreshProjects, onSelectProject],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  return { onSelectProject, onAddProject, onMoveProject, onToggleExpand, onRemoveProject };
}
