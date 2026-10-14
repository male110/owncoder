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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionStore } from "../store/session-store";
import { useChatStore } from "../store/chat-store";
import { getFocusSessionId, syncFocusSession } from "../store/focus-session";
import { PENDING_DRAFT_KEY, useUiStore } from "../store/ui-store";
import { extractHistoryError, toAppError } from "../components/ErrorBanner";
import { dropQueue, hydrateQueue, resumeQueue } from "./queue-controller";
import { sessionStateMachine } from "../store/session-state-machine";
import type { ChatTurnDto } from "../../../preload/index";
import { t, type LocalePref } from "../../../shared/i18n/core";
import { setLocalePref } from "../i18n";

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
  const switchSessionInternalRef = useRef<(id: string, version: number, rollbackId?: string | null, projectRoot?: string) => Promise<unknown>>(
    async () => {},
  );
  const previousSessionIdRef = useRef<string | null>(null);
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
    const unsub = useSessionStore.subscribe((s) => { workspaceRef.current = s.workspace; });
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

  // ── Low-level refreshers ──────────────────────────────────────────────────

  const refreshGit = useCallback(async (expectedRoot?: string) => {
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshChanges = useCallback(async (sessionId?: string) => {
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshPlans = useCallback(async (sessionId?: string) => {
    try {
      // Plans are scoped to the chat session that saved them: pass the focus
      // session id so a new session does not surface other sessions' plans.
      const sid = sessionId ?? getFocusSessionId() ?? undefined;
      session.setPlans(await window.owncoder.listPlans(sid), sid);
    } catch {
      const sid = sessionId ?? getFocusSessionId() ?? undefined;
      session.setPlans([], sid);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshActivePlan = useCallback(async (sessionId?: string) => {
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (
      version !== sessionListSyncVersionRef.current ||
      workspaceRef.current?.root !== root
    ) {
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
      if (prev && prev.title !== "新会话" && s.title === "新会话") {
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
    if (
      version !== projectsSyncVersionRef.current ||
      workspaceRef.current?.root !== rootAtStart
    ) {
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
    const map: Record<string, import("../../../preload/index").ChatSessionMetaDto[]> = {};
    await Promise.all(
      list.map(async (p) => {
        const res = await window.owncoder.listChatSessions(p.root);
        map[p.root] = res.sessions.map((item) => ({ ...item, projectRoot: item.projectRoot || p.root }));
      }),
    );
    if (
      version === projectsSyncVersionRef.current &&
      workspaceRef.current?.root === rootAtStart
    ) {
      session.setSessionsByProject(() => map);
    }
    return list;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Full state sync (called on open/switch/restore) ───────────────────────

  const applySessionState = useCallback(async (
    targetWorkspace?: import("@owncoder/shared").WorkspaceInfo,
    navigationVersion?: number,
  ): Promise<import("../../../preload/index").SessionStateDto | null> => {
    const state = await window.owncoder.getSessionState();
    if (navigationVersion !== undefined && !isNavigationCurrent(navigationVersion)) return null;
    const ws = targetWorkspace ?? state.workspace;
    session.setMode(state.mode);
    workspaceRef.current = ws;
    session.setWorkspace(ws);
    // 用户刚切到 B1 时，后端 getSessionState 可能仍报告 A1。
    // renderer 已有明确焦点时，禁止用后端旧 id 把 UI/读写路径拽回去。
    // pending-new / suppressReapply 窗口里同样只对齐 renderer 当前焦点。
    const rendererFocus = getFocusSessionId();
    if (pendingNewSessionRef.current || suppressReapplyRef.current) {
      if (rendererFocus) syncFocusSession(rendererFocus);
    } else if (rendererFocus) {
      syncFocusSession(rendererFocus);
    } else {
      syncFocusSession(state.activeSessionId);
    }
    const focusAfterSync = getFocusSessionId();
    // 后端焦点仍停在 A1 时，不要把 A1 的标题/计划写到已经展示 B1 的界面上。
    if (!focusAfterSync || focusAfterSync === state.activeSessionId) {
      session.setSessionTitle(state.sessionTitle);
    }
    // 计划路径按后端会话写入缓存；非焦点会话不会盖住当前 PlansBar。
    if (state.activeSessionId) {
      session.setActivePlanPath(state.activePlanPath, state.activeSessionId);
    }

    const snap = await window.owncoder.getSettings();
    if (navigationVersion !== undefined && !isNavigationCurrent(navigationVersion)) return null;
    setLocalePref((snap.effective.harness.locale ?? "system") as LocalePref);
    const sel = snap.effective.selectedModels ?? [];
    session.setAvailableModels(sel);
    session.setProviders(snap.effective.providers ?? []);
    session.setModelLabel(sel.length > 0 ? sel[0]!.name : t("未配置"));
    session.setThinkingEffort(snap.effective.thinking?.defaultEffort ?? "high");
    
    // 同步执行阶段单独配置（向后兼容旧配置）
    const separateEnabled = snap.effective.harness?.separateStageModels ?? false;
    session.setSeparateStageModels(separateEnabled);
    
    // 向后兼容：如果启用执行阶段单独配置但字段为空，从统一配置回退
    const unifiedModelName = sel.length > 0 ? sel[0]!.name : null;
    const unifiedEffort = snap.effective.thinking?.defaultEffort ?? "high";
    
    const reactModel = snap.effective.harness?.reactModel ?? (separateEnabled ? unifiedModelName : null);
    const reactProviderId = snap.effective.harness?.reactProviderId
      ?? sel.find((model) => model.name === reactModel || model.id === reactModel)?.providerId
      ?? null;
    const reactEffort = snap.effective.harness?.reactThinkingEffort ?? (separateEnabled ? unifiedEffort : "medium");
    
    session.setReactModelId(reactModel);
    session.setReactProviderId(reactProviderId);
    session.setReactThinkingEffort(reactEffort);

    const auth = await window.owncoder.getLlmAuthStatus();
    if (navigationVersion !== undefined && !isNavigationCurrent(navigationVersion)) return null;
    session.setLlmConfigured(auth.configured);

    // 用 renderer 当前焦点，而不是后端可能过期的 activeSessionId。
    const sid = getFocusSessionId();
    await refreshChanges(sid ?? undefined);
    if (navigationVersion !== undefined && !isNavigationCurrent(navigationVersion)) return null;
    if (ws) {
      // 显式传入 sessionId 避免竞态条件
      await Promise.all([
        refreshPlans(sid ?? undefined),
        refreshActivePlan(sid ?? undefined),
        refreshGit(ws.root),
      ]);
    } else {
      session.setPlans([]);
      session.setActivePlanMeta(null);
      session.setGitStatus(null);
    }
    await refreshProjects();
    if (navigationVersion !== undefined && !isNavigationCurrent(navigationVersion)) return null;
    if (ws) await refreshSessions();
    else session.setSessions([]);
    return state;
  }, [refreshChanges, refreshPlans, refreshActivePlan, refreshGit, refreshProjects, refreshSessions]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyHistory = useCallback((turns: ChatTurnDto[], sid?: string) => {
    chat.setHistory(turns, sid);
    const histErr = extractHistoryError(turns);
    if (histErr) chat.setErrorAlert(histErr, sid);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // While a pending-new session is being materialised, the main process emits a
  // workspace:restored event as soon as openWorkspacePath runs. That callback
  // would race with the in-flight createPendingSession → sendChat pipeline and:
  //   (a) call applySessionState which reads the backend's stale activeId and
  //       overwrites the freshly-created session's activeSessionId, so the UI
  //       visibly reverts from project B back to project A; and
  //   (b) kick off a flood of refresh IPCs (changes/git/plans/sessions) that
  //       race with the just-issued sendChat and trip the backend rate limiter.
  // suppressReapplyRef makes applyOpened a no-op while set.
  const suppressReapplyRef = useRef(false);

  const applyOpenedInternal = useCallback(async (
    targetWorkspace?: import("@owncoder/shared").WorkspaceInfo,
    opts?: { sanitize?: boolean; navigationVersion?: number },
  ) => {
    const navigationVersion = opts?.navigationVersion ?? ++navigationVersionRef.current;
    // 新建草稿期间只选择项目，不恢复后端已有会话的焦点和历史。
    if (suppressReapplyRef.current || pendingNewSessionRef.current) return;
    
    try {
      const state = await applySessionState(targetWorkspace, navigationVersion);
      if (!state) return;
      if (!isNavigationCurrent(navigationVersion)) return;
      const sid = getFocusSessionId() ?? undefined;

      // When switching projects, a background session may still be sending
      // (its IPC sendChat is in-flight). Don't overwrite its in-memory
      // history with potentially stale backend data — the IPC result will
      // update bySession[sid] via applyChatResult when it completes.
      const existingRt = sid ? useChatStore.getState().bySession[sid] : undefined;
      const hasExistingHistory = existingRt?.history && existingRt.history.length > 0;
      const isActiveSession = existingRt?.sending || (existingRt?.liveEvents?.length ?? 0) > 0;
      
      if (!isActiveSession) {
        const historyPage = sid ? await window.owncoder.getChatHistoryPage(sid, undefined, 10) : null;
        if (!isNavigationCurrent(navigationVersion)) return;
        const initialHistory = historyPage?.turns ?? [];
        
        // 防御：如果前端有历史但后端返回空，不要覆盖（可能是竞态条件或后端异常）
        // 只有在以下情况才更新历史：
        // 1. 后端有历史数据（正常情况）
        // 2. 前端也没有历史（初次加载或确实是空会话）
        // 3. 明确要求清理状态（sanitize=true，应用启动时）
        const shouldUpdate = initialHistory.length > 0 || !hasExistingHistory || opts?.sanitize;
        const shouldWarn = hasExistingHistory && initialHistory.length === 0 && !opts?.sanitize;
        
        if (shouldWarn) {
          console.warn('[applyOpened] 前端有历史但后端返回空，保留前端历史以防止数据丢失');
        } else if (shouldUpdate) {
          applyHistory(initialHistory, sid);
          if (historyPage) {
            chat.setHistoryPageState({ historyBeforeSeq: historyPage.beforeSeq, historyHasMore: historyPage.hasMore, historyLoading: false }, sid);
          }
          chat.setTerminal(await window.owncoder.getTerminalLog(sid), sid);
          chat.resetTurnState(sid);
          chat.setErrorAlert(null, sid);
        }
      }

      // sanitizeAllSessionStatuses clears stale running/needs_confirmation
      // flags from a previous app run. Only call it on true startup/restore,
      // NOT during live project switches — those may have genuinely in-flight
      // sessions whose sending flag must be preserved.
      if (opts?.sanitize) {
        chat.sanitizeAllSessionStatuses();
      }

      // Restore persisted pending messages ("待执行条目") and continue running
      // them when the LLM is ready; otherwise they stay visible until the user
      // sends the next message (which drains the queue).
      if (sid) {
        hydrateQueue(sid, state?.queuedMessages ?? []);
        if (useSessionStore.getState().llmConfigured && workspaceRef.current) {
          resumeQueue(sid);
        }
      }

      const meta = await window.owncoder.getActivePlan(sid);
      if (!isNavigationCurrent(navigationVersion)) return;
      if (meta && meta.tasks.length > 0) {
        const done = meta.tasks.filter(
          (t) => t.status === "completed" || t.status === "skipped",
        ).length;
        chat.setLiveStatus(
          done === 0
            ? t("计划已批准，共 {{count}} 个任务。在下方输入框发送消息即可开始执行。", { count: meta.tasks.length })
            : t("任务执行中：{{done}}/{{total}} 已完成", { done, total: meta.tasks.length }),
          sid,
        );
      } else {
        chat.setLiveStatus("", sid);
      }
    } catch (error) {
      console.error('[applyOpened] 执行失败:', error);
    }
  }, [applySessionState, applyHistory, isNavigationCurrent]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyOpened = useCallback((
    targetWorkspace?: import("@owncoder/shared").WorkspaceInfo,
    opts?: { sanitize?: boolean; navigationVersion?: number },
  ) => {
    if (opts?.navigationVersion !== undefined) {
      return applyOpenedInternal(targetWorkspace, opts);
    }
    return enqueueNavigation((navigationVersion) =>
      applyOpenedInternal(targetWorkspace, { ...opts, navigationVersion }),
    );
  }, [applyOpenedInternal, enqueueNavigation]);

  // ── Project & session actions ─────────────────────────────────────────────


  const onSelectProject = useCallback((root: string, focusSessionId?: string) => enqueueNavigation(async (navigationVersion) => {
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
      useSessionStore.getState().sessionsByProject, root,
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
      const targetSessionId = focusSessionId && cached.some((item) => item.id === focusSessionId)
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
  }), [applyOpenedInternal, enqueueNavigation, isNavigationCurrent, refreshGit]); // eslint-disable-line react-hooks/exhaustive-deps

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
    ++projectsSyncVersionRef.current;
    session.setProjects(projects);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onToggleExpand = useCallback((root: string) => {
    session.setExpanded((e) => ({ ...e, [root]: !(e[root] !== false) }));
  }, []);

  const onRemoveProject = useCallback(async (root: string) => {
    // 存在运行中/未结束的会话时禁止删除
    const projectSessions = useSessionStore.getState().sessionsByProject[root] ?? [];
    const chatStore = useChatStore.getState();
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
  }, [refreshProjects, onSelectProject]); // eslint-disable-line react-hooks/exhaustive-deps

  // Internal helper: create a backend session for the pending-new flow.
  // Returns the new session id, or null if creation failed.
  const createPendingSession = useCallback(async (): Promise<string | null> => {
    if (creatingPendingSessionRef.current) return creatingPendingSessionRef.current;
    const run = (async (): Promise<string | null> => {
    // Snapshot the project chosen in the composer BEFORE clearing pending flags.
    // Clicking send then immediately switching project must not rewrite this
    // binding — the new session and its file lookup stay on the send-time root.
    const pendingRoot =
      pendingProjectRef.current ?? workspaceRef.current?.root ?? null;
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
        const targetWs = { root: pendingRoot, name: projects.find((p) => p.root === pendingRoot)?.name ?? pendingRoot };
        session.setWorkspace(targetWs);
        workspaceRef.current = targetWs;
        // 检查项目是否已加载，使用轻量级切换避免清理正在运行的会话
        const alreadyLoaded = Object.prototype.hasOwnProperty.call(
          useSessionStore.getState().sessionsByProject, pendingRoot,
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
      setTimeout(() => { suppressReapplyRef.current = false; }, 1000);
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
      const activeMeta = useSessionStore.getState().sessions.find(s => s.id === activeId);
      const activeRuntime = useChatStore.getState().bySession[activeId];
      const hasDraft = drafts[activeId]?.trim();
      
      // 修复：只有在会话真正为空且用户没有输入草稿时才重用
      // 如果用户已经输入了内容但历史被意外清空，也应该创建新会话
      if (activeMeta?.title === "新会话" && 
          (!activeRuntime || activeRuntime.history.length === 0) &&
          !hasDraft &&
          !sessionStateMachine.isBusy(activeId)) {
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



  const switchSessionInternal = useCallback(async (
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
    return sessionStateMachine.executeForSession(id, 'switch', async () => {
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
        // 即使后续导航版本已过期，也先把后端快照写入 bySession[id]。
        // 跨项目首次点历史会话时，乐观 syncFocusSession 会先露出空 runtime；
        // 若这里因为 navigationVersion 过期直接 return，就会一直只剩上方输入框。
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
        if (!isNavigationCurrent(navigationVersion)) return;
        // await 期间 applySessionState 可能读到后端尚未切换完的 A1；再次锁定 B1。
        syncFocusSession(id);
        
        // 3b. 刷新变更列表（总是刷新，因为可能在其他会话中修改了文件）
        await refreshChanges(id).catch(err => {
          console.warn('[onSwitchSession] 刷新变更列表失败:', err);
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
          chat.setHistoryPageState({ historyBeforeSeq: page.beforeSeq, historyHasMore: page.hasMore, historyLoading: false }, id);
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
          refreshPlans(id).catch(err => console.warn('[onSwitchSession] 刷新计划列表失败:', err)),
          refreshActivePlan(id).catch(err => console.warn('[onSwitchSession] 刷新活动计划失败:', err)),
          refreshSessions().catch(err => console.warn('[onSwitchSession] 刷新会话列表失败:', err)),
        ]);
      } catch (error) {
        console.error('[onSwitchSession] 会话切换失败:', error);
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
  }, [applyHistory, isNavigationCurrent, refreshPlans, refreshActivePlan, refreshSessions, refreshChanges]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSwitchSession = useCallback(
    (id: string, projectRoot?: string) => enqueueNavigation((navigationVersion) => switchSessionInternal(id, navigationVersion, getFocusSessionId(), projectRoot)),
    [enqueueNavigation, switchSessionInternal],
  );

  onSwitchSessionRef.current = onSwitchSession;
  switchSessionInternalRef.current = switchSessionInternal;

  const onDeleteSession = useCallback(async (id: string, projectRoot?: string) => {
    const ws = workspaceRef.current;
    const isCrossProject = projectRoot && ws?.root && projectRoot !== ws.root;
    
    // 使用状态机确保删除操作串行执行
    return sessionStateMachine.executeForSession(id, 'delete', async () => {
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
        chat.dropSession(id);
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
          // 如果删除的是当前选中的会话，使用后端返回的 activeId
          // 如果删除的是其他会话，保持当前选中状态不变
          const targetSessionId = isDeletingCurrentSession ? res.activeId : currentFocusId;
          
          if (targetSessionId !== currentFocusId) {
            syncFocusSession(targetSessionId);
            chat.setHistory(res.history, targetSessionId);
            session.setSessionTitle(null); // 清空标题，让下一次切换或刷新时重新加载
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
        console.error('[onDeleteSession] 删除会话失败:', error);
        // 删除失败时，确保状态机清理（避免死锁）
        sessionStateMachine.reset(id);
        throw error;
      }
    });
  }, [refreshSessions]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPinSession = useCallback(async (id: string) => {
    const res = await window.owncoder.pinChatSession(id);
    session.setSessions(res.list.sessions);
    const ws = workspaceRef.current;
    if (ws?.root) {
      session.setSessionsByProject((prev) => ({ ...prev, [ws.root]: res.list.sessions }));
    }
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

  return {
    // Refreshers (used by chat hook after a turn)
    refreshGit,
    refreshChanges,
    refreshPlans,
    refreshActivePlan,
    refreshSessions,
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
    // Deferred session creation (方案B)
    pendingNewSession,
    pendingNewSessionRef,
    createPendingSession,
  };
}
