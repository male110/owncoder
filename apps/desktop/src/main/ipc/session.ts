/**
 * IPC handlers: session lifecycle, mode, plan, tasks, checkpoints, changes, git, memories.
 *
 * Session-scoped handlers accept an optional trailing `sessionId` argument so the
 * renderer can target a specific session (the focus session by default). This
 * keeps multi-session concurrent execution working: switching the front-end
 * focus never aborts a background session's in-flight turn.
 */
import { ipcMain } from "electron";
import { listSessionMetas } from "@owncoder/core";
import type { AgentMode } from "@owncoder/shared";
import type { IpcContext } from "./types";

export function registerSessionHandlers(ctx: IpcContext): void {
  const { session, settingsStore } = ctx;
  const withProjectRoot = <T extends { id: string }>(meta: T, root?: string) => ({
    ...meta,
    projectRoot: root ?? session.getState(meta.id).workspace?.root ?? "",
  });
  const withProjectRoots = <T extends { id: string }>(metas: T[], root?: string) =>
    metas.map((meta) => withProjectRoot(meta, root));

  // ── Session state ──────────────────────────────────────────────────────────

  ipcMain.handle("session:getState", (_e, sessionId?: string) => {
    const s = session.getState(sessionId);
    const index = session.getIndex().status();
    const snap = settingsStore.snapshot();
    return {
      mode: s.mode,
      workspace: s.workspace,
      index,
      workflowFingerprint: snap.fingerprint,
      matchesBuiltin: snap.matchesBuiltin,
      activePlanPath: s.activePlanPath,
      lastPlanPath: s.lastPlanPath,
      todoAnchor: s.todoAnchor,
      lastCheckpointId: s.lastCheckpointId,
      sessionRestored: s.sessionRestored,
      activeSessionId: s.activeSessionId,
      sessionTitle: s.sessionTitle,
      queuedMessages: s.queuedMessages ?? [],
    };
  });

  ipcMain.handle(
    "session:setQueuedMessages",
    (_e, messages: Array<{ text: string; attachments?: import("@owncoder/llm").ChatAttachment[] }> | string[], sessionId?: string) => {
      session.setQueuedMessages(Array.isArray(messages) ? messages : [], sessionId);
      return session.getState(sessionId).queuedMessages ?? [];
    },
  );

  ipcMain.handle("sessions:list", async (_e, root?: string) => {
    const result = root ? await listSessionMetas(root) : await session.listChatSessions();
    return { ...result, sessions: withProjectRoots(result.sessions, root) };
  });

  ipcMain.handle("sessions:create", async (_e, title?: string) => {
    const meta = await session.createChatSession(title);
    // createChatSession makes the new session the focus; return its (empty) history.
    return {
      meta: withProjectRoot(meta, session.getState(meta.id).workspace?.root),
      history: session.getHistory(meta.id),
      state: session.getState(meta.id),
    };
  });

  ipcMain.handle("sessions:switch", async (_e, id: string, projectRoot?: string) => {
    if (projectRoot && session.getState().workspace?.root !== projectRoot) {
      await session.switchWorkspace(projectRoot, projectRoot.split(/[\\/]+/).pop() || projectRoot);
    }
    const state = await session.switchChatSession(id);
    return { state, history: session.getHistory(id), terminal: session.getTerminalLog(id) };
  });

  ipcMain.handle("sessions:delete", async (_e, id: string, projectRoot?: string) => {
    const res = await session.deleteChatSession(id, projectRoot);
    ctx.chatBuffer?.removeSession(id ?? null);
    ctx.chatBufferRef?.removeSession(id ?? null);
    const list = projectRoot ? await listSessionMetas(projectRoot) : await session.listChatSessions();
    return {
      ...res,
      history: session.getHistory(res.activeId ?? undefined),
      list: { ...list, sessions: withProjectRoots(list.sessions, projectRoot) },
    };
  });

  ipcMain.handle("sessions:pin", async (_e, id: string) => {
    const sessions = await session.toggleChatSessionPin(id);
    const list = await session.listChatSessions();
    return {
      sessions: withProjectRoots(sessions),
      list: { ...list, sessions: withProjectRoots(list.sessions) },
    };
  });

  ipcMain.handle("session:wipe", async (_e, sessionId?: string) => {
    await session.wipePersistedSession(sessionId);
    return {
      history: session.getHistory(sessionId),
      terminal: session.getTerminalLog(sessionId),
      state: session.getState(sessionId),
    };
  });

  ipcMain.handle("session:setMode", (_e, mode: AgentMode, sessionId?: string) => {
    session.setMode(mode, sessionId);
    return session.getState(sessionId).mode;
  });

  ipcMain.handle("session:compact", (_e, sessionId?: string) => session.compactNow(sessionId));

  ipcMain.handle("session:setTodoAnchor", (_e, todo: string | null, sessionId?: string) => {
    session.setTodoAnchor(todo, sessionId);
    return session.getState(sessionId);
  });

  // ── Plans & tasks ──────────────────────────────────────────────────────────

  ipcMain.handle("session:approvePlan", async (_e, opts?: { path?: string; content?: string; title?: string; tasks?: unknown[] }, sessionId?: string) => {
    return session.approvePlan(opts as never, sessionId);
  });

  ipcMain.handle("session:clearActivePlan", (_e, sessionId?: string) => session.clearActivePlan(sessionId));

  ipcMain.handle("session:getActivePlan", (_e, sessionId?: string) => session.getActivePlan(sessionId));

  ipcMain.handle("session:updateTask", async (_e, taskId: string, status: string, result?: string, sessionId?: string) => {
    return session.updateTask(taskId, status as never, result, sessionId);
  });

  ipcMain.handle("plans:list", (_e, sessionId?: string) => session.listPlans(sessionId));

  ipcMain.handle("plans:read", (_e, path: string) => session.readPlan(path));

  // ── Checkpoints & changes ─────────────────────────────────────────────────

  ipcMain.handle("session:listCheckpoints", () => session.listCheckpoints());

  ipcMain.handle("session:rollback", async (_e, id?: string, sessionId?: string) => {
    const result = await session.rollbackCheckpoint(id, sessionId);
    return { ...result, history: session.getHistory(sessionId), state: session.getState(sessionId) };
  });

  ipcMain.handle("changes:pending", (_e, sessionId?: string) => session.getPendingChanges(sessionId));

  ipcMain.handle("changes:keepAll", async (_e, sessionId?: string) => {
    await session.keepAllChanges(sessionId);
    return session.getPendingChanges(sessionId);
  });

  ipcMain.handle("changes:keep", async (_e, path: string, sessionId?: string) => {
    await session.keepChange(path, sessionId);
    return session.getPendingChanges(sessionId);
  });

  ipcMain.handle("changes:undo", async (_e, path: string, sessionId?: string) => {
    await session.undoChange(path, sessionId);
    return session.getPendingChanges(sessionId);
  });

  ipcMain.handle("changes:undoAll", async (_e, sessionId?: string) => {
    const result = await session.rollbackCheckpoint(undefined, sessionId);
    return {
      ...result,
      history: session.getHistory(sessionId),
      changes: await session.getPendingChanges(sessionId),
    };
  });

  // ── Git ───────────────────────────────────────────────────────────────────

  ipcMain.handle("git:status", () => session.getGitStatus());

  // ── Rules ─────────────────────────────────────────────────────────────────

  ipcMain.handle("rules:list", () => session.listRules());

  ipcMain.handle("rules:read", (_e, name: string) => session.readRule(name));

  ipcMain.handle("rules:write", (_e, name: string, content: string) => session.writeRule(name, content));

  ipcMain.handle("rules:delete", async (_e, name: string) => {
    await session.deleteRule(name);
    return true;
  });

  ipcMain.handle("rules:combined", async () => {
    await session.reloadProjectRules();
    return session.getProjectRulesText();
  });

  ipcMain.handle("project:restoreContext", () => session.restoreProjectContext());

  // ── Memories ──────────────────────────────────────────────────────────────

  ipcMain.handle("memories:list", (_e, scope?: string) => {
    const store = scope === "project"
      ? session.getProjectMemoryStore()
      : session.getMemoryStore();
    return store?.list() ?? [];
  });

  ipcMain.handle("memories:add", (_e, m: { title: string; content: string; category?: string; keywords?: string[] }, scope?: string) => {
    const store = scope === "project"
      ? session.getProjectMemoryStore()
      : session.getMemoryStore();
    if (!store) return null;
    return store.add({
      title: m?.title ?? "",
      content: m?.content ?? "",
      category: m?.category ?? "general",
      keywords: m?.keywords ?? [],
    });
  });

  ipcMain.handle("memories:update", (_e, id: string, patch: Partial<{ title: string; content: string; category: string; keywords: string[] }>, scope?: string) => {
    const store = scope === "project"
      ? session.getProjectMemoryStore()
      : session.getMemoryStore();
    return store?.update(id, patch ?? {}) ?? null;
  });

  ipcMain.handle("memories:delete", (_e, id: string, scope?: string) => {
    const store = scope === "project"
      ? session.getProjectMemoryStore()
      : session.getMemoryStore();
    return store?.remove(id) ?? false;
  });

  // ── MCP ───────────────────────────────────────────────────────────────────

  ipcMain.handle("mcp:listTools", () => session.listMcpTools());
}
