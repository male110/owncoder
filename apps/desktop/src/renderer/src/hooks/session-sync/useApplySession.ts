/**
 * useApplySession
 *
 * Full state sync (called on open/switch/restore):
 *   - applySessionState: pulls the whole backend session state into the stores
 *   - applyHistory: writes a history page into the chat store
 *   - applyOpened: applySessionState + history/terminal/queue restore
 *
 * While suppressReapplyRef is set, applyOpened is a no-op. That guards the
 * pending-new creation flow against the workspace:restored event that fires
 * while createPendingSession is still materialising the new session (it would
 * otherwise revert the UI to the stale backend activeId and flood the backend
 * with refresh IPCs that trip the rate limiter).
 */
import { useCallback } from "react";
import { modelDisplayName } from "@owncoder/settings";
import { useSessionStore } from "../../store/session-store";
import { useChatStore } from "../../store/chat-store";
import { getFocusSessionId, syncFocusSession } from "../../store/focus-session";
import { extractHistoryError } from "../../components/ErrorBanner";
import { hydrateQueue, resumeQueue } from "../queue-controller";
import { setLocalePref } from "../../i18n";
import { t, type LocalePref } from "../../../../shared/i18n/core";
import type { ChatTurnDto } from "../../../../preload/index";
import type { SessionSyncContext } from "./types";
import type { SyncRefreshers } from "./useSyncRefreshers";

export function useApplySession(ctx: SessionSyncContext, refreshers: SyncRefreshers) {
  const {
    session,
    workspaceRef,
    pendingNewSessionRef,
    suppressReapplyRef,
    navigationVersionRef,
    isNavigationCurrent,
    enqueueNavigation,
  } = ctx;
  const { refreshChanges, refreshPlans, refreshSpecs, refreshActivePlan, refreshGit, refreshProjects, refreshSessions } = refreshers;

  const applySessionState = useCallback(
    async (
      targetWorkspace?: import("@owncoder/shared").WorkspaceInfo,
      navigationVersion?: number,
    ): Promise<import("../../../../preload/index").SessionStateDto | null> => {
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
      session.setModelLabel(sel.length > 0 ? modelDisplayName(sel[0]) : t("未配置"));
      session.setThinkingEffort(snap.effective.thinking?.defaultEffort ?? "high");

      // 同步执行阶段单独配置（向后兼容旧配置）
      const separateEnabled = snap.effective.harness?.separateStageModels ?? false;
      session.setSeparateStageModels(separateEnabled);

      // 向后兼容：如果启用执行阶段单独配置但模型字段为空，从统一配置回退
      const unifiedModelName = sel.length > 0 ? sel[0]!.name : null;

      const reactModel = snap.effective.harness?.reactModel ?? (separateEnabled ? unifiedModelName : null);
      const reactProviderId =
        snap.effective.harness?.reactProviderId ??
        sel.find((model) => model.name === reactModel || model.id === reactModel)?.providerId ??
        null;
      // 执行阶段思考等级默认“中强度”：未单独配置时固定回退到 medium，
      // 不再跟随任务分解的 defaultEffort（high）。
      const reactEffort = snap.effective.harness?.reactThinkingEffort ?? "medium";

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
          refreshSpecs(sid ?? undefined),
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
    },
    [refreshChanges, refreshPlans, refreshSpecs, refreshActivePlan, refreshGit, refreshProjects, refreshSessions],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const applyHistory = useCallback((turns: ChatTurnDto[], sid?: string) => {
    ctx.chat.setHistory(turns, sid);
    const histErr = extractHistoryError(turns);
    if (histErr) ctx.chat.setErrorAlert(histErr, sid);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyOpenedInternal = useCallback(
    async (
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
            console.warn("[applyOpened] 前端有历史但后端返回空，保留前端历史以防止数据丢失");
          } else if (shouldUpdate) {
            applyHistory(initialHistory, sid);
            if (historyPage) {
              ctx.chat.setHistoryPageState(
                { historyBeforeSeq: historyPage.beforeSeq, historyHasMore: historyPage.hasMore, historyLoading: false },
                sid,
              );
            }
            ctx.chat.setTerminal(await window.owncoder.getTerminalLog(sid), sid);
            ctx.chat.resetTurnState(sid);
            ctx.chat.setErrorAlert(null, sid);
          }
        }

        // sanitizeAllSessionStatuses clears stale running/needs_confirmation
        // flags from a previous app run. Only call it on true startup/restore,
        // NOT during live project switches — those may have genuinely in-flight
        // sessions whose sending flag must be preserved.
        if (opts?.sanitize) {
          ctx.chat.sanitizeAllSessionStatuses();
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
          ctx.chat.setLiveStatus(
            done === 0
              ? t("计划已批准，共 {{count}} 个任务。在下方输入框发送消息即可开始执行。", { count: meta.tasks.length })
              : t("任务执行中：{{done}}/{{total}} 已完成", { done, total: meta.tasks.length }),
            sid,
          );
        } else {
          ctx.chat.setLiveStatus("", sid);
        }
      } catch (error) {
        console.error("[applyOpened] 执行失败:", error);
      }
    },
    [applySessionState, applyHistory, isNavigationCurrent],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const applyOpened = useCallback(
    (
      targetWorkspace?: import("@owncoder/shared").WorkspaceInfo,
      opts?: { sanitize?: boolean; navigationVersion?: number },
    ) => {
      if (opts?.navigationVersion !== undefined) {
        return applyOpenedInternal(targetWorkspace, opts);
      }
      return enqueueNavigation((navigationVersion) =>
        applyOpenedInternal(targetWorkspace, { ...opts, navigationVersion }),
      );
    },
    [applyOpenedInternal, enqueueNavigation],
  );

  return { applySessionState, applyHistory, applyOpened, applyOpenedInternal };
}
