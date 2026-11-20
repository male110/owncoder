/**
 * App — root composition component.
 *
 * Responsibilities (only):
 *   1. Mount lifecycle hooks (events, sync, scroll)
 *   2. Compute derived display values (greeting, visible turns, status text)
 *   3. Wire action callbacks from hooks to component props
 *   4. Render the layout tree
 *
 * No useState, no IPC calls, no business logic lives here.
 * State lives in store/; logic lives in hooks/.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Stores ────────────────────────────────────────────────────────────────────
import { useSessionStore } from "./store/session-store";
import type { ChatAttachmentDto } from "../../preload/index";
import { useChatStore } from "./store/chat-store";
import { getComposerDraftKey, useUiStore } from "./store/ui-store";
import { customConfirm } from "./utils/customConfirm";
import { isDefaultSessionTitle } from "./utils/sessionTitle";

// ── Hooks ─────────────────────────────────────────────────────────────────────
import { useSessionSync } from "./hooks/useSessionSync";
import { useChatEvents } from "./hooks/useChatEvents";
import { useChatActions } from "./hooks/useChatActions";
import { requestStop } from "./hooks/queue-controller";

// ── Components ────────────────────────────────────────────────────────────────
import { AgentSidebar } from "./components/AgentSidebar";
import { SessionChatPanel } from "./components/SessionChatPanel";
import { Composer } from "./components/Composer";
import { ChangesBar } from "./components/ChangesBar";
import { PlanActionsContext } from "./components/chat-log/AssistantBubble";
import { TerminalDock } from "./components/TerminalDock";
import { CommandPalette } from "./components/CommandPalette";
import { EditorPane } from "./components/EditorPane";
import { TitleBar } from "./components/TitleBar";
import { RenderErrorBoundary } from "./components/RenderErrorBoundary";
import { DangerousCommandBar } from "./components/DangerousCommandBar";
import { AskUserCard } from "./components/AskUserCard";
import { UpdateBanner } from "./components/UpdateBanner";
import { useI18n } from "./i18n";

const SettingsPanel = lazy(async () => {
  const module = await import("./SettingsPanel");
  return { default: module.SettingsPanel };
});

export function App() {
  useEffect(() => {
    document.getElementById("boot-status")?.remove();
  }, []);
  const { t } = useI18n();

  // ── Store slices ────────────────────────────────────────────────────────────
  const {
    workspace, projects, sessions, sessionsByProject, activeSessionId, sessionTitle,
    expanded, mode, modelLabel, availableModels, providers, llmConfigured,
    activePlanPathBySession, activePlanMetaBySession, plansBySession,
    gitStatus, changesBySession, thinkingEffort,
    separateStageModels, reactModelId, reactProviderId, reactThinkingEffort,
  } = useSessionStore();

  // Derive changes for the active session (session-scoped isolation)
  const changes = changesBySession[activeSessionId ?? ""] ?? [];

  // 只读当前会话自己的计划缓存。禁止回退到全局字段：
  // 那些字段可能仍是上一个会话的任务/已批准路径，切过去会把别人的计划当成当前会话的。
  const sessionPlans = activeSessionId
    ? (plansBySession[activeSessionId] ?? []).filter((plan) => plan.sessionId === activeSessionId)
    : [];
  const historyLength = useChatStore((s) => s.history.length);
  const sending = useChatStore((s) => s.sending);
  const terminal = useChatStore((s) => s.terminal);
  const bySession = useChatStore((s) => s.bySession);

  const {
    editorTabs, editorPath, diffDataByPath, editorWidth, isEditorDragging, sidebarWidth, isSidebarDragging,
    sidebarCollapsed, settingsOpen, settingsTab,
    searchOpen, modeMenuOpen, drafts, busy, keepAllBusy,
    setEditorPath, openEditorDiff, setActiveEditorTab, closeEditorTab, setEditorWidth, setIsEditorDragging, setSidebarWidth, setIsSidebarDragging,
    setSidebarCollapsed, setSettingsOpen, setSettingsTab, setSearchOpen, setModeMenuOpen,
    setDraft, openSettings,
  } = useUiStore();

  // ── Layout refs ─────────────────────────────────────────────────────────────

  /** 共享的 per-plan 批准飞行锁：key = sessionId → 正在批准中的 planPath 集合。
   *  PlanCard 与应用层批准入口共用，避免同一计划被并发重复批准。 */
  const [approvingPlanPathsBySession, setApprovingPlanPathsBySession] = useState<Record<string, Set<string>>>({});
  const approvingPlanLocks = useRef(new Set<string>());

  /** 空集合常量：无批准飞行锁时复用同一引用，避免 PlanActionsContext value 每次重建。 */
  const EMPTY_PLAN_PATH_SET = useRef<Set<string>>(new Set()).current;

  /** 危险 bash 自动批准开关（settings modes.agent.autoApproveBash）。
   *  本地镜像：挂载时与设置面板保存后从 settings 刷新，变更后 debounce 自动保存，
   *  与 SettingsPanel 共享同一 settings 源（saveSettings → setWorkflow → core）。 */
  const [autoApproveBash, setAutoApproveBash] = useState(false);
  const autoApproveSaveTimer = useRef<number | null>(null);

  // 从主进程读取当前 autoApproveBash，刷新本地镜像。
  // 挂载时初始化一次；SettingsPanel 保存/还原（含一键还原工厂设置）后再次刷新，
  // 避免 Composer 复选框与设置面板分叉。
  const refreshAutoApproveBash = useCallback(() => {
    void (async () => {
      try {
        const snap = await window.owncoder.getSettings();
        setAutoApproveBash(snap.effective.modes.agent.autoApproveBash ?? false);
      } catch (err) {
        console.warn("[App] 读取 autoApproveBash 设置失败:", err);
      }
    })();
  }, []);

  // 挂载时读取当前 settings，初始化复选框状态。
  useEffect(() => { void refreshAutoApproveBash(); }, [refreshAutoApproveBash]);

  // 复选框变更：立即更新本地状态，700ms debounce 后持久化（与 SettingsPanel 同模式）。
  const handleAutoApproveBashChange = useCallback((enabled: boolean) => {
    setAutoApproveBash(enabled);
    if (autoApproveSaveTimer.current !== null) {
      window.clearTimeout(autoApproveSaveTimer.current);
    }
    autoApproveSaveTimer.current = window.setTimeout(() => {
      autoApproveSaveTimer.current = null;
      void (async () => {
        try {
          const snap = await window.owncoder.getSettings();
          const config = { ...snap.effective };
          if (!config.modes) config.modes = {} as any;
          if (!config.modes.agent) config.modes.agent = {} as any;
          config.modes.agent.autoApproveBash = enabled;
          await window.owncoder.saveSettings(config);
        } catch (err) {
          console.error("[App] 保存 autoApproveBash 设置失败:", err);
        }
      })();
    }, 700);
  }, []);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const pendingEditorWidthRef = useRef<number | null>(null);
  const sidebarResizeFrameRef = useRef<number | null>(null);
  const pendingSidebarWidthRef = useRef<number | null>(null);
  /** 页签行右侧操作区宿主，供 EditorPane 通过 portal 挂载保存/重新加载。 */
  const [editorTabActionsHost, setEditorTabActionsHost] = useState<HTMLDivElement | null>(null);
  /** 各打开文件的 dirty 状态，供 tab 关闭确认与脏点标记。 */
  const [editorDirtyByPath, setEditorDirtyByPath] = useState<Record<string, boolean>>({});
  const [editorLocation, setEditorLocation] = useState<{ path: string; line: number; column?: number; requestId: number } | null>(null);

  // ── Hooks ────────────────────────────────────────────────────────────────────
  const {
    refreshChanges, refreshGit, refreshPlans, refreshActivePlan, refreshSpecs,
    refreshSessions, applySessionState, applyOpened,
    onAddProject, onSelectProject, onRemoveProject, onMoveProject, onToggleExpand,
    onNewSession, onSwitchSession, onDeleteSession, onPinSession, onRenameSession,
    pendingNewSession, pendingNewSessionRef, createPendingSession,
  } = useSessionSync();

  useChatEvents();

  const {
    onSend, onRegenerate,
    onApprovePlan, onExecutePlan, onUpdateTask, onExecuteSpecTasks,
    onRollback, onKeepAll, onKeepFile, onUndoFile,
    onSelectModel, onMode, onSelectThinkingEffort, onSelectReactThinkingEffort, sendQueued,
  } = useChatActions({
    applySessionState,
    refreshChanges,
    refreshGit,
    refreshSessions,
    refreshPlans,
    refreshSpecs,
    refreshActivePlan,
    pendingNewSessionRef,
    createPendingSession,
    onNewSession,
  });

  /** 批准计划包装：进入时登记 per-plan 飞行锁，结束后清除。
   *  与 PlanCard 共享同一把锁，杜绝双入口并发批准。 */
  const handleApprovePlan = useCallback(async (path: string, sid = useSessionStore.getState().activeSessionId) => {
    if (!sid || sid !== useSessionStore.getState().activeSessionId) throw new Error("请切换至计划所属会话");
    if (useSessionStore.getState().activePlanPathBySession[sid] === path) throw new Error("计划已批准");
    const key = JSON.stringify([sid, path]);
    if (approvingPlanLocks.current.has(key)) throw new Error("计划正在批准");
    approvingPlanLocks.current.add(key);
    setApprovingPlanPathsBySession((prev) => ({
      ...prev, [sid]: new Set([...(prev[sid] ?? []), path]),
    }));
    try {
      await onApprovePlan(path);
    } finally {
      approvingPlanLocks.current.delete(key);
      setApprovingPlanPathsBySession((prev) => {
        const next = new Set(prev[sid] ?? []);
        next.delete(path);
        return { ...prev, [sid]: next };
      });
    }
  }, [onApprovePlan]);

  // pending 新会话时即使 activeSessionId 尚未清空，也必须读写 PENDING 键，
  // 与 onSend / resolveComposerDraftText 保持一致，否则会出现「有字点发送无反应」。
  const draftKey = getComposerDraftKey(activeSessionId, pendingNewSession);
  const draft = drafts[draftKey] ?? "";

  // ── Mount: restore workspace & subscribe to IPC events ───────────────────────
  useEffect(() => { void applyOpened(undefined, { sanitize: true }); }, [applyOpened]);

  useEffect(
    () => window.owncoder.onWorkspaceRestored(() => { void applyOpened(undefined, { sanitize: true }); }),
    [applyOpened],
  );

  // Settings panel open/close signal to main process.
  useEffect(() => { window.owncoder.setSettingsPanelOpen(settingsOpen); }, [settingsOpen]);
  useEffect(() => window.owncoder.onCloseSettingsPanel(() => setSettingsOpen(false)), [setSettingsOpen]);

  // Ctrl+K → command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setSearchOpen]);

  const handleEditorDirtyChange = useCallback((path: string, dirty: boolean) => {
    setEditorDirtyByPath((prev) => {
      if (Boolean(prev[path]) === dirty) return prev;
      if (!dirty && !(path in prev)) return prev;
      const next = { ...prev };
      if (dirty) next[path] = true;
      else delete next[path];
      return next;
    });
  }, []);

  const handleCloseEditorTab = useCallback((path: string) => {
    setEditorDirtyByPath((prev) => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
    closeEditorTab(path);
  }, [closeEditorTab]);

  const requestCloseEditorTab = useCallback(async (path: string) => {
    if (editorDirtyByPath[path]) {
      const ok = await customConfirm(t("文件尚未保存，确定关闭？未保存的修改将丢失。"));
      if (!ok) return;
    }
    handleCloseEditorTab(path);
  }, [editorDirtyByPath, handleCloseEditorTab]);

  const artifactSession = useRef(activeSessionId);
  useEffect(() => {
    if (artifactSession.current === activeSessionId) return;
    artifactSession.current = activeSessionId;
    for (const path of editorTabs) {
      if (/[\\/]\.owncoder[\\/](plans|specs)[\\/]/i.test(`/${path}`)) handleCloseEditorTab(path);
    }
  }, [activeSessionId, editorTabs, handleCloseEditorTab]);

  /** 文档引用先确认当前会话归属，再允许打开编辑器缓存。 */
  const openEditorFile = useCallback((path: string, line?: number, column?: number) => {
    const open = () => {
      setEditorPath(path);
      if (line !== undefined) {
        setEditorLocation((current) => ({ path, line, column, requestId: (current?.requestId ?? 0) + 1 }));
      }
    };
    if (/[\\/]\.owncoder[\\/](plans|specs)[\\/]/i.test(`/${path}`)) {
      const sid = activeSessionId;
      void window.owncoder.readPlan(path, sid ?? undefined).then(() => {
        if (sid === useSessionStore.getState().activeSessionId) open();
      }, () => {});
    } else {
      open();
    }
  }, [activeSessionId, setEditorPath]);

  const fileNameOf = useCallback((path: string) => {
    const parts = path.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || path;
  }, []);

  // Drag-resize handler for the editor column (width measured from left edge).
  useEffect(() => {
    if (!isEditorDragging) return;

    const onMove = (e: MouseEvent) => {
      if (!bodyRef.current) return;
      const rect = bodyRef.current.getBoundingClientRect();
      const widthPx = e.clientX - rect.left;
      const pct = (widthPx / rect.width) * 100;
      pendingEditorWidthRef.current = pct;
      if (resizeFrameRef.current !== null) return;

      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        if (pendingEditorWidthRef.current !== null) {
          setEditorWidth(pendingEditorWidthRef.current);
        }
      });
    };

    const onUp = () => {
      setIsEditorDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      pendingEditorWidthRef.current = null;
    };
  }, [isEditorDragging, setEditorWidth, setIsEditorDragging]);

  // Drag-resize handler for left sidebar.
  useEffect(() => {
    if (!isSidebarDragging || sidebarCollapsed) return;

    const onMove = (e: MouseEvent) => {
      if (!shellRef.current) return;
      const rect = shellRef.current.getBoundingClientRect();
      const nextWidth = Math.min(480, Math.max(180, e.clientX - rect.left));
      pendingSidebarWidthRef.current = nextWidth;
      if (sidebarResizeFrameRef.current !== null) return;

      sidebarResizeFrameRef.current = requestAnimationFrame(() => {
        sidebarResizeFrameRef.current = null;
        if (pendingSidebarWidthRef.current !== null) {
          setSidebarWidth(pendingSidebarWidthRef.current);
        }
      });
    };

    const onUp = () => {
      setIsSidebarDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (sidebarResizeFrameRef.current !== null) {
        cancelAnimationFrame(sidebarResizeFrameRef.current);
        sidebarResizeFrameRef.current = null;
      }
      pendingSidebarWidthRef.current = null;
    };
  }, [isSidebarDragging, sidebarCollapsed, setSidebarWidth, setIsSidebarDragging]);

  // ── Derived values ───────────────────────────────────────────────────────────
  const visitedRef = useRef<Set<string>>(new Set());
  if (!visitedRef.current) visitedRef.current = new Set();
  if (activeSessionId && !pendingNewSession) visitedRef.current.add(activeSessionId);

  // Clean up visitedRef when sessions are deleted or workspace changes
  useEffect(() => {
    const visited = visitedRef.current ?? (visitedRef.current = new Set());
    const sessionIds = new Set(sessions.map(s => s.id));
    // Remove any visited session IDs that no longer exist
    for (const id of visited) {
      if (!sessionIds.has(id)) {
        visited.delete(id);
      }
    }
    // If no sessions exist and no active session, clear visitedRef entirely
    if (sessions.length === 0 && !activeSessionId) {
      visited.clear();
    }
  }, [sessions, activeSessionId]);
  
  // 常驻挂载所有「已访问且仍存在」的会话面板，非焦点面板用 display:none 隐藏
  // （见 SessionChatPanel 的 isActive 样式）。不能只挂载焦点面板：否则切换会话
  // 会卸载/重挂整个 ChatLog（含 Virtuoso 与 live footer DOM），正在后台 streaming
  // 的会话切回来时其已输出内容会因重挂竞态而消失。store（bySession）虽保留数据，
  // 但重建的虚拟列表在量高完成前渲染为空，表现为「原来输出的内容不见了」。
  // visitedRef 已在会话删除/工作区切换时清理，pruneIdleSessions 也会回收空闲
  // runtime，因此常驻面板数量是有界的。
  const panelSessions = useMemo(() => {
    const existing = new Set(sessions.map((s) => s.id));
    const ids = Array.from(visitedRef.current).filter((id) => existing.has(id));
    // 焦点会话即使尚未进入 visited（边界情况）也要保证挂载。
    if (activeSessionId && !ids.includes(activeSessionId)) ids.push(activeSessionId);
    return ids;
  }, [sessions, activeSessionId]);

  // When a new session is pending, show a blank canvas instead of the old
  // session's chat history / changes / plans.  The actual backend session is
  // created lazily on first send inside createPendingSession.
  // Also show blank canvas when there are no sessions at all.
  const showBlank = pendingNewSession || (sessions.length === 0 && !activeSessionId);

  // ── Send wrapper ──────────────────────────────────────────────────────────────
  const handleSend = useCallback((attachments?: ChatAttachmentDto[]) => { onSend(attachments); }, [onSend]);

  // ── Composer callbacks (stabilized so React.memo can skip re-renders) ─────────
  // PENDING_DRAFT_KEY is used when there is no active session / pending new
  // session. Persisting the draft here lets the composer stay usable; onSend
  // resolves the same key via resolveComposerDraftText.
  const handleDraft = useCallback(
    (v: string) => {
      setDraft(v, getComposerDraftKey(activeSessionId, pendingNewSession));
    },
    [activeSessionId, pendingNewSession, setDraft],
  );
  const handleCancel = useCallback(() => {
    const chatActions = useChatStore.getState();
    const sid = useSessionStore.getState().activeSessionId
      ?? useChatStore.getState().activeSessionId;
    // 1) 立即给视觉反馈：关掉流式动画，但保留已有的 liveEvents
    //    （工具卡片、思维过程等），让用户仍能看到执行过程，
    //    直到后端返回最终结果后再替换为历史记录。
    if (sid) {
      chatActions.sealAllStreaming(sid);
      chatActions.setLiveStatus(t("正在停止…"), sid);
      // 进入「正在停止…」窗口：此窗口内乐观用户行尚无 turnId，单独放开
      // 删除入口，让用户能删掉刚发出的这条消息。
      chatActions.setStopping(true, sid);
      // 请求停止队列循环：runQueue 在当前消息结束后会检查停止标志并
      // break 出循环，但保留剩余的待执行消息，用户可继续手动发送。
      requestStop(sid);
    } else {
      chatActions.resetTurnState();
      chatActions.setLiveStatus(t("正在停止…"));
    }
    // 2) 显式带 sid 调用；后端 cancelTurn 在 sid 缺失时会回退到 activeSessionId，
    //    但显式传值避免渲染/主进程活跃会话不一致时打错对象。
    void window.owncoder.cancelChat(sid ?? undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const handleNewSession = useCallback(() => { void onNewSession(); }, [onNewSession]);
  const handleMode = useCallback((m: import("@owncoder/shared").AgentMode) => { void onMode(m); }, [onMode]);
  const handleSelectModel = useCallback(
    (id: string, providerId: string) => { void onSelectModel(id, providerId); },
    [onSelectModel],
  );
  const handleSelectReactModel = useCallback(async (name: string, providerId: string) => {
    const snap = await window.owncoder.getSettings();
    const config = { ...snap.effective };
    if (!config.harness) config.harness = {} as any;
    const selected = (config.selectedModels ?? []).find((model) =>
      model.providerId === providerId && (model.name === name || model.id === name),
    );
    config.harness.reactModel = selected?.name ?? name;
    config.harness.reactProviderId = selected?.providerId ?? providerId;
    await window.owncoder.saveSettings(config);
    useSessionStore.getState().setReactModelId(config.harness.reactModel);
    useSessionStore.getState().setReactProviderId(config.harness.reactProviderId);
  }, []);
  const handleSelectThinkingEffort = useCallback((effort: import("@owncoder/settings").ThinkingEffort) => { void onSelectThinkingEffort(effort); }, [onSelectThinkingEffort]);
  const handleSelectReactThinkingEffort = useCallback((effort: import("@owncoder/settings").ThinkingEffort) => { void onSelectReactThinkingEffort(effort); }, [onSelectReactThinkingEffort]);
  const handleOpenSettings = useCallback(() => { openSettings("models"); }, [openSettings]);
  const handleSelectProject = useCallback((root: string) => onSelectProject(root), [onSelectProject]);
  const handleAddProject = useCallback(() => { void onAddProject(); }, [onAddProject]);

  /** 编辑器当前打开的计划文件（若打开的是本会话的计划）。批准入口展示在文件页内，
   *  与 ZCode plan_approval 的「内容 + 动作区」布局一致。 */
  const editorPlan = editorPath ? sessionPlans.find((plan) => plan.path === editorPath) : undefined;
  const editorPlanApproved = Boolean(editorPlan && editorPath && activePlanPathBySession[activeSessionId ?? ""] === editorPath);
  const editorPlanApproving = Boolean(
    editorPlan && editorPath && activeSessionId && approvingPlanPathsBySession[activeSessionId]?.has(editorPath),
  );

  // ── Chat panel ────────────────────────────────────────────────────────────────
  const chatPanel = (
    <>
      {!showBlank && panelSessions.map((sid) => (
        <PlanActionsContext.Provider key={sid} value={{
          plans: sid === activeSessionId ? sessionPlans : (plansBySession[sid] ?? []),
          activePlanPath: activePlanPathBySession[sid] ?? null,
          busy: busy || sending || sid !== activeSessionId,
          onApprovePlan: (path) => { if (sid === useSessionStore.getState().activeSessionId) void handleApprovePlan(path).catch(() => {}); },
          approvingPlanPaths: approvingPlanPathsBySession[sid] ?? EMPTY_PLAN_PATH_SET,
        }}>
        <SessionChatPanel
          sessionId={sid}
          isActive={sid === activeSessionId}
          llmConfigured={llmConfigured}
          onRegenerate={() => void onRegenerate()}
          onOpenFile={openEditorFile}
          workspaceRoot={workspace?.root}
          onOpenSettings={openSettings}
          onSendQueuedMessage={(index) => void sendQueued(sid, index)}
        />
        </PlanActionsContext.Provider>
      ))}

      {!showBlank && (
        <>
          <ChangesBar
            changes={changes}
            busy={busy || sending}
            keepAllBusy={keepAllBusy}
            onKeepAll={() => void onKeepAll()}
            onUndoAll={() => void onRollback()}
            onKeepFile={(p) => void onKeepFile(p)}
            onUndoFile={(p) => void onUndoFile(p)}
            onViewDiff={openEditorDiff}
            onOpenFile={openEditorFile}
          />
          <DangerousCommandBar
            autoApproveBash={autoApproveBash}
            onAutoApproveBashChange={handleAutoApproveBashChange}
          />
          <AskUserCard />
        </>
      )}
      {showBlank ? (
        <div className="hero-empty" style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
          <div className="hero-watermark">✦</div>
          <h1>{t("新会话")}</h1>
          <p className="hero-sub">{t("选择项目目录，输入任务描述开始")}</p>
        </div>
      ) : null}
      <Composer
        mode={mode}
        activeSessionId={activeSessionId}
        draft={draft}
        sending={sending}
        modelLabel={modelLabel}
        availableModels={availableModels}
        providers={providers}
        thinkingEffort={thinkingEffort}
        separateStageModels={separateStageModels}
        reactModelId={reactModelId}
        reactProviderId={reactProviderId}
        reactThinkingEffort={reactThinkingEffort}
        workspaceName={workspace?.name ?? null}
        workspaceRoot={workspace?.root ?? null}
        projects={projects}
        gitStatus={gitStatus}
        isEmptySession={historyLength === 0}
        pendingNewSession={pendingNewSession}
        modeMenuOpen={modeMenuOpen}
        onDraft={handleDraft}
        onSend={handleSend}
        onCancel={handleCancel}
        onNewSession={handleNewSession}
        onMode={handleMode}
        onModeMenuOpen={setModeMenuOpen}
        onSelectModel={handleSelectModel}
        onOpenSettings={handleOpenSettings}
        onSelectThinkingEffort={handleSelectThinkingEffort}
        onSelectProject={handleSelectProject}
        onAddProject={handleAddProject}
        onSelectReactModel={handleSelectReactModel}
        onSelectReactThinkingEffort={handleSelectReactThinkingEffort}
      />
    </>
  );

  // ── Layout ────────────────────────────────────────────────────────────────────
  return (
    <div className="app-frame">
      <TitleBar
        title={showBlank || isDefaultSessionTitle(sessionTitle) ? t("新会话") : sessionTitle}
        gitSummary={
          gitStatus?.isRepo
            ? ["干净", "已改", "未跟踪", "有改动", "Git 状态获取失败"].reduce(
                (summary, label) => summary.replaceAll(label, t(label as Parameters<typeof t>[0])),
                gitStatus.summary,
              )
            : null
        }
        gitDirty={gitStatus?.dirty}
      />
      <UpdateBanner />
      <div
        ref={shellRef}
        className={`app agent-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${isSidebarDragging ? " is-resizing" : ""}`}
        style={
          sidebarCollapsed
            ? undefined
            : { gridTemplateColumns: `${sidebarWidth}px 5px 1fr` }
        }
      >
        <AgentSidebar
          projects={projects}
          sessions={sessions}
          sessionsByProject={sessionsByProject}
          workspace={workspace}
          activeSessionId={activeSessionId}
          expanded={expanded}
          collapsed={sidebarCollapsed}
          isSessionRunning={(id: string) => useChatStore.getState().isSessionSending(id)}
          getSessionStatus={(id: string) => {
            // Reactive read: bySession is destructured above so background
            // session status changes trigger re-render. Always read from
            // bySession — it is the authoritative per-session state and is
            // kept in sync with the top-level fields for the active session
            // via applyRuntime. Reading the top-level `status` for the active
            // session is unsafe here because `activeSessionId` comes from the
            // session store, which can temporarily differ from the chat store's
            // activeSessionId during new-session transitions (setActiveSession(null)
            // resets the top-level status to "idle" while the session store still
            // points at the old session). That mismatch caused running icons to
            // disappear when creating a new session.
            return bySession[id]?.status ?? "idle";
          }}
          onClearSessionStatus={(id: string) => useChatStore.getState().clearSessionStatus(id)}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          onNewSession={() => void onNewSession()}
          onAddProject={() => void onAddProject()}
          onOpenSettings={() => { setSettingsTab("models"); setSettingsOpen(true); }}
          onSelectProject={(root, focusSessionId) => onSelectProject(root, focusSessionId)}
          onToggleExpand={onToggleExpand}
          onRemoveProject={(root) => onRemoveProject(root)}
          onMoveProject={onMoveProject}
          onSwitchSession={(id, projectRoot) => onSwitchSession(id, projectRoot)}
          onDeleteSession={(id, projectRoot) => void onDeleteSession(id, projectRoot)}
          onPinSession={onPinSession}
          onRenameSession={onRenameSession}
          onOpenFile={openEditorFile}
        />

        {!sidebarCollapsed ? (
          <div
            className="sidebar-resize-handle"
            onMouseDown={() => setIsSidebarDragging(true)}
            title={t("拖动调整左侧宽度")}
          />
        ) : null}

        <main className="agent-main">

          <div ref={bodyRef} className={`agent-body${editorTabs.length > 0 ? " with-editor" : ""}`}>
            {editorTabs.length > 0 && editorPath ? (
              <>
                <div className="editor-shell" style={{ width: `${editorWidth}%` }}>
                  <div className="editor-tabs-row">
                    <div className="editor-tabs" role="tablist" aria-label={t("已打开文件")}>
                      {editorTabs.map((tabPath) => {
                        const active = tabPath === editorPath;
                        const dirty = Boolean(editorDirtyByPath[tabPath]);
                        const isDiff = Boolean(diffDataByPath[tabPath]);
                        return (
                          <div
                            key={tabPath}
                            className={`editor-tab${active ? " active" : ""}`}
                            role="presentation"
                          >
                            <button
                              type="button"
                              role="tab"
                              aria-selected={active}
                              className="editor-tab-main"
                              title={tabPath}
                              onClick={() => setActiveEditorTab(tabPath)}
                            >
                              <span className="editor-tab-name">{fileNameOf(tabPath)}</span>
                              {isDiff ? <span className="editor-tab-badge">{t("对比")}</span> : null}
                              {dirty ? <span className="editor-dirty">●</span> : null}
                            </button>
                            <button
                              type="button"
                              className="editor-tab-close"
                              title={t("关闭")}
                              aria-label={t("关闭 {{name}}", { name: fileNameOf(tabPath) })}
                              onClick={() => void requestCloseEditorTab(tabPath)}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <div
                      ref={setEditorTabActionsHost}
                      className="editor-tab-actions-host"
                      aria-label={t("编辑器操作")}
                    />
                  </div>
                  {editorTabs.map((tabPath) => {
                    const active = tabPath === editorPath;
                    const diff = diffDataByPath[tabPath];
                    return (
                      <div
                        key={tabPath}
                        className="editor-tab-pane"
                        style={{ display: active ? "flex" : "none" }}
                        aria-hidden={!active}
                      >
                        {active && editorPlan ? (
                          /* 批准入口悬浮在计划正文上方（对齐 ZCode plan_approval 卡片式动作层）。 */
                          <div className="editor-plan-float">
                            {editorPlan.kind === "document" ? (
                              <span className="editor-plan-float-note">{t("文档交付物 · 无需批准（如需执行请生成实施计划）")}</span>
                            ) : editorPlanApproved ? (
                              <span className="editor-plan-float-note">{t("已批准")}</span>
                            ) : (
                              <button
                                type="button"
                                className="plan-approve-cta"
                                disabled={busy || sending || editorPlanApproving}
                                onClick={() => {
                                  if (editorPath && activeSessionId) {
                                    void handleApprovePlan(editorPath, activeSessionId).catch(() => {});
                                  }
                                }}
                              >
                                {editorPlanApproving ? t("批准中…") : t("批准此计划并自动执行")}
                              </button>
                            )}
                          </div>
                        ) : null}
                        <EditorPane
                          path={tabPath}
                          active={active}
                          revealLine={editorLocation?.path === tabPath ? editorLocation : undefined}
                          hidePathTitle
                          actionsHost={active ? editorTabActionsHost : null}
                          {...(diff
                            ? {
                                diffMode: true as const,
                                content: diff.after,
                                originalContent: diff.before,
                              }
                            : {
                                diffMode: false as const,
                                content: undefined,
                              })}
                          onSaved={() => void refreshChanges()}
                          onDirtyChange={(dirty) => handleEditorDirtyChange(tabPath, dirty)}
                          activePlanMeta={activePlanMetaBySession[activeSessionId ?? ""] as import("../../preload/index").ActivePlanMetaDto | undefined}
                          taskBusy={busy || sending}
                          sessionId={activeSessionId ?? undefined}
                          onExecutePlan={() => activeSessionId && onExecutePlan(activeSessionId)}
                          onExecuteSpecTasks={activeSessionId ? (document, taskId) => void onExecuteSpecTasks(activeSessionId, document, taskId) : undefined}
                          onUpdateTask={(taskId, status, document) => activeSessionId && void onUpdateTask(taskId, status, activeSessionId, document)}
                        />
                      </div>
                    );
                  })}
                </div>
                <div
                  className="editor-resize-handle"
                  onMouseDown={() => setIsEditorDragging(true)}
                  title={t("拖动调整文件区域宽度")}
                />
              </>
            ) : null}
            <div className="agent-chat">
              {chatPanel}
            </div>
          </div>

          <TerminalDock terminalLog={terminal} />
        </main>

        <CommandPalette
          open={searchOpen}
          sessions={sessions}
          workspaceName={workspace?.name ?? null}
          onClose={() => setSearchOpen(false)}
          onSelectSession={async (id, projectRoot) => {
            await onSwitchSession(id, projectRoot);
          }}
          onSelectFile={(path) => {
            openEditorFile(path);
            setDraft(
              draft.trim() ? `${draft} @${path} ` : `@${path} `,
              getComposerDraftKey(activeSessionId, pendingNewSession),
            );
          }}
          onNewSession={() => void onNewSession()}
          onOpenSettings={() => { setSettingsTab("models"); setSettingsOpen(true); }}
        />

        {settingsOpen ? (
          <RenderErrorBoundary
            scope="settings-module"
            resetKey={`${settingsOpen}:${settingsTab}`}
            fallback={(error, reset) => (
              <div className="settings-overlay" role="dialog" aria-modal="true" aria-label={t("设置加载失败")}>
                <section
                  role="alert"
                  style={{
                    margin: "auto",
                    maxWidth: 560,
                    padding: 20,
                    border: "1px solid #7e3d3d",
                    borderRadius: 8,
                    background: "#1a1012",
                  }}
                >
                  <h2>{t("设置未能加载")}</h2>
                  <p className="hint">{t("主界面仍在运行。错误详情已记录到启动终端。")}</p>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{error.message}</pre>
                  <div className="todo-actions">
                    <button type="button" className="ghost" onClick={reset}>{t("重试")}</button>
                    <button type="button" className="ghost" onClick={() => setSettingsOpen(false)}>{t("关闭设置")}</button>
                  </div>
                </section>
              </div>
            )}
          >
            <Suspense fallback={<div className="settings-overlay" aria-label={t("正在加载设置")} />}>
              <SettingsPanel
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                onSaved={() => { void applySessionState(); refreshAutoApproveBash(); }}
                initialTab={settingsTab}
              />
            </Suspense>
          </RenderErrorBoundary>
        ) : null}
      </div>
    </div>
  );
}
