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
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

// ── Stores ────────────────────────────────────────────────────────────────────
import { useSessionStore } from "./store/session-store";
import type { ActivePlanMetaDto } from "../../preload/index";
import { useChatStore } from "./store/chat-store";
import { getComposerDraftKey, useUiStore } from "./store/ui-store";
import { customConfirm } from "./utils/customConfirm";

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
import { PlansBar } from "./components/PlansBar";
import { TaskListBar } from "./components/TaskListBar";
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
    activePlanPathBySession, activePlanMetaBySession, plansBySession, gitStatus, changesBySession, thinkingEffort,
  } = useSessionStore();

  // Derive changes for the active session (session-scoped isolation)
  const changes = changesBySession[activeSessionId ?? ""] ?? [];

  // 只读当前会话自己的计划缓存。禁止回退到全局字段：
  // 那些字段可能仍是上一个会话的任务/已批准路径，切过去会把别人的计划当成当前会话的。
  const sessionActivePlanMeta = activeSessionId
    ? (activePlanMetaBySession[activeSessionId] ?? null)
    : null;
  const sessionActivePlanPath = activeSessionId
    ? (activePlanPathBySession[activeSessionId] ?? null)
    : null;
  const sessionPlans = activeSessionId
    ? (plansBySession[activeSessionId] ?? [])
    : [];

  const historyLength = useChatStore((s) => s.history.length);
  const sending = useChatStore((s) => s.sending);
  const queueCount = useChatStore((s) => s.queuedMessages.length);
  const terminal = useChatStore((s) => s.terminal);
  const bySession = useChatStore((s) => s.bySession);

  const {
    editorTabs, editorPath, chatWidth, isDragging, sidebarWidth, isSidebarDragging,
    sidebarCollapsed, settingsOpen, settingsTab,
    searchOpen, modeMenuOpen, drafts, busy, keepAllBusy,
    setEditorPath, setActiveEditorTab, closeEditorTab, setChatWidth, setIsDragging, setSidebarWidth, setIsSidebarDragging,
    setSidebarCollapsed, setSettingsOpen, setSettingsTab, setSearchOpen, setModeMenuOpen,
    setDraft, openSettings,
  } = useUiStore();

  // ── Layout refs ─────────────────────────────────────────────────────────────

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const pendingChatWidthRef = useRef<number | null>(null);
  const sidebarResizeFrameRef = useRef<number | null>(null);
  const pendingSidebarWidthRef = useRef<number | null>(null);
  /** 页签行右侧操作区宿主，供 EditorPane 通过 portal 挂载保存/重新加载。 */
  const [editorTabActionsHost, setEditorTabActionsHost] = useState<HTMLDivElement | null>(null);
  /** 各打开文件的 dirty 状态，供 tab 关闭确认与脏点标记。 */
  const [editorDirtyByPath, setEditorDirtyByPath] = useState<Record<string, boolean>>({});
  /** 当前以 diff 模式打开的文件内容（按 path 绑定，切换/重开时需触发重渲染）。 */
  const [diffData, setDiffData] = useState<{ path: string; before: string; after: string } | null>(null);

  // ── Hooks ────────────────────────────────────────────────────────────────────
  const {
    refreshChanges, refreshGit, refreshPlans, refreshActivePlan,
    refreshSessions, applySessionState, applyOpened,
    onAddProject, onSelectProject, onRemoveProject, onToggleExpand,
    onNewSession, onSwitchSession, onDeleteSession,
    pendingNewSession, pendingNewSessionRef, createPendingSession,
  } = useSessionSync();

  useChatEvents();


  const {
    onSend, onRegenerate,
    onApprovePlan, onUpdateTask,
    onRollback, onKeepAll, onKeepFile, onUndoFile,
    onSelectModel, onMode, onSelectThinkingEffort, onRemoveQueueMessage, sendQueued,
  } = useChatActions({
    applySessionState,
    refreshChanges,
    refreshGit,
    refreshSessions,
    refreshPlans,
    refreshActivePlan,
    pendingNewSessionRef,
    createPendingSession,
    onNewSession,
  });

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

  // Collapse sidebar when editor opens; restore when it closes.
  useEffect(() => {
    setSidebarCollapsed(editorTabs.length > 0);
  }, [editorTabs.length, setSidebarCollapsed]);

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
    setDiffData((prev) => (prev?.path === path ? null : prev));
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

  /** 普通打开文件：激活/追加 tab，并取消该路径上的 diff 模式。 */
  const openEditorFile = useCallback((path: string) => {
    setDiffData((prev) => (prev?.path === path ? null : prev));
    setEditorPath(path);
  }, [setEditorPath]);

  const fileNameOf = useCallback((path: string) => {
    const parts = path.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || path;
  }, []);

  // Drag-resize handler for chat panel (right side).
  useEffect(() => {
    if (!isDragging) return;
    
    const onMove = (e: MouseEvent) => {
      if (!bodyRef.current) return;
      const rect = bodyRef.current.getBoundingClientRect();
      // Calculate width from right edge
      const widthPx = rect.right - e.clientX;
      const pct = (widthPx / rect.width) * 100;
      const newWidth = Math.min(50, Math.max(15, pct));
      pendingChatWidthRef.current = newWidth;
      if (resizeFrameRef.current !== null) return;

      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        if (pendingChatWidthRef.current !== null) {
          setChatWidth(pendingChatWidthRef.current);
        }
      });
    };
    
    const onUp = () => {
      setIsDragging(false);
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
      pendingChatWidthRef.current = null;
    };
  }, [isDragging, setChatWidth, setIsDragging]);

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
  
  // Keep the store as the source of truth for background sessions, but only
  // mount the focused panel. Hidden panels still retain their full React tree,
  // virtualization state and subscriptions, which becomes expensive after many
  // session switches.
  const panelSessions = activeSessionId ? [activeSessionId] : [];

  // When a new session is pending, show a blank canvas instead of the old
  // session's chat history / changes / plans.  The actual backend session is
  // created lazily on first send inside createPendingSession.
  // Also show blank canvas when there are no sessions at all.
  const showBlank = pendingNewSession || (sessions.length === 0 && !activeSessionId);

  // ── Send wrapper ──────────────────────────────────────────────────────────────
  const handleSend = useCallback(() => { onSend(); }, [onSend]);

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
  const handleSelectModel = useCallback((id: string) => { void onSelectModel(id); }, [onSelectModel]);
  const handleSelectThinkingEffort = useCallback((effort: import("@owncoder/settings").ThinkingEffort) => { void onSelectThinkingEffort(effort); }, [onSelectThinkingEffort]);
  const handleOpenSettings = useCallback(() => { openSettings("models"); }, [openSettings]);
  const handleSelectProject = useCallback((root: string) => onSelectProject(root), [onSelectProject]);
  const handleAddProject = useCallback(() => { void onAddProject(); }, [onAddProject]);

  // ── Chat panel ────────────────────────────────────────────────────────────────
  const chatPanel = (
    <>
      {!showBlank && panelSessions.map((sid) => (
        <SessionChatPanel
          key={sid}
          sessionId={sid}
          isActive={sid === activeSessionId}
          llmConfigured={llmConfigured}
          onRegenerate={() => void onRegenerate()}
          onOpenFile={openEditorFile}
          onOpenSettings={openSettings}
          onSendQueuedMessage={(index) => sendQueued(sid, index)}
        />
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
            onViewDiff={(path, before, after) => {
              setDiffData({ path, before, after });
              setEditorPath(path);
            }}
            onOpenFile={openEditorFile}
          />
          <PlansBar
            plans={sessionPlans}
            activePlanPath={sessionActivePlanPath}
            busy={busy || sending}
            onApprovePlan={(p) => void onApprovePlan(p)}
            onReadPlan={(p) => window.owncoder.readPlan(p)}
            onOpenFile={openEditorFile}
          />
          {sessionActivePlanMeta && sessionActivePlanMeta.tasks.length > 0 && sessionActivePlanMeta.path ? (
            <TaskListBar
              meta={sessionActivePlanMeta as ActivePlanMetaDto}
              busy={busy || sending}
              onUpdateTask={(id, s) => void onUpdateTask(id, s)}
            />
          ) : null}
          <DangerousCommandBar />
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
        queueCount={queueCount}
        modelLabel={modelLabel}
        availableModels={availableModels}
        providers={providers}
        thinkingEffort={thinkingEffort}
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
        onRemoveQueueMessage={onRemoveQueueMessage}
      />
    </>
  );

  // ── Layout ────────────────────────────────────────────────────────────────────
  return (
    <div className="app-frame">
      <TitleBar
        title={showBlank || sessionTitle === "新会话" ? t("新会话") : sessionTitle}
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
            : { gridTemplateColumns: `${sidebarWidth}px 6px 1fr` }
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
          onSwitchSession={(id) => onSwitchSession(id)}
          onDeleteSession={(id, projectRoot) => void onDeleteSession(id, projectRoot)}
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
                <div className="editor-shell">
                  <div className="editor-tabs-row">
                    <div className="editor-tabs" role="tablist" aria-label={t("已打开文件")}>
                      {editorTabs.map((tabPath) => {
                        const active = tabPath === editorPath;
                        const dirty = Boolean(editorDirtyByPath[tabPath]);
                        const isDiff = diffData?.path === tabPath;
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
                    const diff = diffData?.path === tabPath ? diffData : null;
                    return (
                      <div
                        key={tabPath}
                        className="editor-tab-pane"
                        style={{ display: active ? "flex" : "none" }}
                        aria-hidden={!active}
                      >
                        <EditorPane
                          path={tabPath}
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
                        />
                      </div>
                    );
                  })}
                </div>
                <div
                  className="editor-resize-handle"
                  onMouseDown={() => setIsDragging(true)}
                />
              </>
            ) : null}
            <div className="agent-chat" style={editorTabs.length > 0 ? { width: `${chatWidth}%` } : undefined}>
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
          onSelectSession={async (id) => {
            await onSwitchSession(id);
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
                onSaved={() => void applySessionState()}
                initialTab={settingsTab}
              />
            </Suspense>
          </RenderErrorBoundary>
        ) : null}
      </div>
    </div>
  );
}
