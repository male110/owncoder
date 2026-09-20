/**
 * Session store — workspace, sessions, mode, plan, tasks, git.
 * This is the "server state" mirror: data that lives in the main process
 * and is fetched/synced to the renderer.
 */
import { create } from "zustand";
import type { AgentMode, WorkspaceInfo } from "@owncoder/shared";
import type { AvailableModel, Provider, ThinkingEffort } from "@owncoder/settings";
import type {
  ActivePlanMetaDto,
  ChangeFileDto,
  ChatSessionMetaDto,
  GitStatusDto,
  PlanInfoDto,
  ProjectDto,
  TaskStatusDto,
} from "../../../preload/index";

export interface SessionState {
  // Workspace
  workspace: WorkspaceInfo | null;
  projects: ProjectDto[];
  expanded: Record<string, boolean>;

  // Sessions
  sessions: ChatSessionMetaDto[];
  sessionsByProject: Record<string, ChatSessionMetaDto[]>;
  activeSessionIdByProject: Record<string, string | null>;
  activeSessionId: string | null;
  sessionTitle: string | null;

  // Mode & model
  mode: AgentMode;
  modelLabel: string;
  availableModels: AvailableModel[];
  providers: Provider[];
  llmConfigured: boolean;
  thinkingEffort: ThinkingEffort;

  // Plan & tasks
  /** Focused-session mirror of the approved plan path. */
  activePlanPath: string | null;
  /** Per-session approved plan path. Prevents A's approval from hiding B's PlansBar. */
  activePlanPathBySession: Record<string, string | null>;
  activePlanMeta: ActivePlanMetaDto | null;
  /** Per-session active plan meta cache. Keys are sessionId; values may be
   * partial (only tasks/currentTaskId) until a full plan payload arrives. */
  activePlanMetaBySession: Record<string, Partial<ActivePlanMetaDto> & { tasks: ActivePlanMetaDto["tasks"]; currentTaskId: string | null }>;

  // Changes (per-session isolation)
  changesBySession: Record<string, ChangeFileDto[]>;

  // Plans list (sidebar) — focused-session mirror
  plans: PlanInfoDto[];
  /** Per-session pending-plan list shown in PlansBar. */
  plansBySession: Record<string, PlanInfoDto[]>;

  // Git
  gitStatus: GitStatusDto | null;
}

export interface SessionActions {
  setWorkspace: (ws: WorkspaceInfo | null) => void;
  setProjects: (projects: ProjectDto[]) => void;
  setExpanded: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  setSessions: (sessions: ChatSessionMetaDto[]) => void;
  setSessionsByProject: (updater: (prev: Record<string, ChatSessionMetaDto[]>) => Record<string, ChatSessionMetaDto[]>) => void;
  setActiveSessionIdByProject: (projectRoot: string, id: string | null) => void;
  setActiveSessionId: (id: string | null) => void;
  setSessionTitle: (title: string | null) => void;
  setMode: (mode: AgentMode) => void;
  setModelLabel: (label: string) => void;
  setAvailableModels: (models: AvailableModel[]) => void;
  setProviders: (providers: Provider[]) => void;
  setLlmConfigured: (v: boolean) => void;
  setThinkingEffort: (effort: ThinkingEffort) => void;
  setActivePlanPath: (path: string | null, sessionId?: string | null) => void;
  getActivePlanPathForSession: (sessionId?: string | null) => string | null;
  setActivePlanMeta: (meta: ActivePlanMetaDto | null) => void;
  patchActivePlanMeta: (tasks: ActivePlanMetaDto["tasks"], currentTaskId: string | null) => void;
  setActivePlanMetaBySession: (sessionId: string, meta: ActivePlanMetaDto | null) => void;
  patchActivePlanMetaBySession: (sessionId: string, tasks: ActivePlanMetaDto["tasks"], currentTaskId: string | null) => void;
  getActivePlanMetaForSession: (sessionId?: string | null) => ActivePlanMetaDto | null;
  setChanges: (sessionId: string, changes: ChangeFileDto[]) => void;
  getChangesForSession: (sessionId?: string | null) => ChangeFileDto[];
  setPlans: (plans: PlanInfoDto[], sessionId?: string | null) => void;
  getPlansForSession: (sessionId?: string | null) => PlanInfoDto[];
  setGitStatus: (status: GitStatusDto | null) => void;

  // High-level helpers used by hooks
  applyTaskStatus: (taskId: string, status: TaskStatusDto) => void;
}

const initialState: SessionState = {
  workspace: null,
  projects: [],
  expanded: {},
  sessions: [],
  sessionsByProject: {},
  activeSessionIdByProject: {},
  activeSessionId: null,
  sessionTitle: null,
  mode: "agent",
  modelLabel: "default",
  availableModels: [],
  providers: [],
  llmConfigured: true,
  thinkingEffort: "high",
  activePlanPath: null,
  activePlanPathBySession: {},
  activePlanMeta: null,
  activePlanMetaBySession: {},
  changesBySession: {},
  plans: [],
  plansBySession: {},
  gitStatus: null,
};

export const useSessionStore = create<SessionState & SessionActions>()((set, get) => ({
  ...initialState,

  setWorkspace: (workspace) => set({ workspace }),
  setProjects: (projects) => set({ projects }),
  setExpanded: (updater) => set((s) => ({ expanded: updater(s.expanded) })),
  setSessions: (sessions) =>
    set((s) => ({
      sessions:
        typeof sessions === "function"
          ? (sessions as (prev: ChatSessionMetaDto[]) => ChatSessionMetaDto[])(s.sessions)
          : sessions,
    })),
  setSessionsByProject: (updater) => set((s) => ({ sessionsByProject: updater(s.sessionsByProject) })),
  setActiveSessionIdByProject: (projectRoot, activeSessionId) =>
    set((s) => ({
      activeSessionIdByProject: { ...s.activeSessionIdByProject, [projectRoot]: activeSessionId },
    })),
  setActiveSessionId: (activeSessionId) =>
    set((s) => {
      if (s.activeSessionId === activeSessionId) {
        return s.workspace?.root
          ? {
              activeSessionIdByProject: {
                ...s.activeSessionIdByProject,
                [s.workspace.root]: activeSessionId,
              },
            }
          : {};
      }
      return {
        activeSessionId,
        activeSessionIdByProject: s.workspace?.root
          ? { ...s.activeSessionIdByProject, [s.workspace.root]: activeSessionId }
          : s.activeSessionIdByProject,
        // 切换会话时只恢复该会话自己的计划路径/列表/元数据，避免 A 的已批准计划盖住 B。
        activePlanMeta: activeSessionId
          ? (() => {
              const cached = s.activePlanMetaBySession[activeSessionId];
              return cached?.path ? (cached as ActivePlanMetaDto) : null;
            })()
          : null,
        activePlanPath: activeSessionId
          ? (s.activePlanPathBySession[activeSessionId] ?? null)
          : null,
        plans: activeSessionId ? (s.plansBySession[activeSessionId] ?? []) : [],
      };
    }),
  setSessionTitle: (sessionTitle) => set({ sessionTitle }),
  setMode: (mode) => set({ mode }),
  setModelLabel: (modelLabel) => set({ modelLabel }),
  setAvailableModels: (availableModels) => set({ availableModels }),
  setProviders: (providers) => set({ providers }),
  setLlmConfigured: (llmConfigured) => set({ llmConfigured }),
  setThinkingEffort: (thinkingEffort) => set({ thinkingEffort }),
  setActivePlanPath: (path, sessionId) => {
    const sid = sessionId ?? get().activeSessionId;
    set((s) => {
      const activePlanPathBySession = sid
        ? { ...s.activePlanPathBySession, [sid]: path }
        : s.activePlanPathBySession;
      return {
        activePlanPathBySession,
        // 非焦点写入只更新该会话缓存，不覆盖当前 PlansBar。
        activePlanPath: !sid || sid === s.activeSessionId ? path : s.activePlanPath,
      };
    });
  },
  getActivePlanPathForSession: (sessionId) => {
    const s = get();
    if (sessionId) {
      if (Object.prototype.hasOwnProperty.call(s.activePlanPathBySession, sessionId)) {
        return s.activePlanPathBySession[sessionId] ?? null;
      }
      if (sessionId === s.activeSessionId) return s.activePlanPath;
      return null;
    }
    return s.activePlanPath;
  },
  setActivePlanMeta: (activePlanMeta) => {
    const activeSessionId = get().activeSessionId;
    set((s) => {
      let activePlanMetaBySession = s.activePlanMetaBySession;
      if (activeSessionId) {
        if (activePlanMeta) {
          activePlanMetaBySession = {
            ...s.activePlanMetaBySession,
            [activeSessionId]: activePlanMeta,
          };
        } else {
          const { [activeSessionId]: _removed, ...rest } = s.activePlanMetaBySession;
          activePlanMetaBySession = rest;
        }
      }
      return { activePlanMeta, activePlanMetaBySession };
    });
  },
  patchActivePlanMeta: (tasks, currentTaskId) => {
    const base = get().activePlanMeta;
    if (!base) return;
    const updated = { ...base, tasks, currentTaskId };
    const activeSessionId = get().activeSessionId;
    if (activeSessionId) {
      set((s) => ({
        activePlanMeta: updated,
        activePlanMetaBySession: {
          ...s.activePlanMetaBySession,
          [activeSessionId]: updated,
        },
      }));
    } else {
      set({ activePlanMeta: updated });
    }
  },
  setActivePlanMetaBySession: (sessionId, meta) => {
    if (!sessionId) return;
    set((s) => {
      const { [sessionId]: _removed, ...rest } = s.activePlanMetaBySession;
      const activePlanMetaBySession = meta
        ? { ...rest, [sessionId]: { ...meta } }
        : rest;
      return {
        activePlanMetaBySession,
        // 目标会话正是焦点时，同步全局字段；否则不要动别人的任务列表。
        activePlanMeta: s.activeSessionId === sessionId ? meta : s.activePlanMeta,
      };
    });
  },
  patchActivePlanMetaBySession: (sessionId, tasks, currentTaskId) => {
    if (!sessionId) return;
    set((s) => {
      const prev = s.activePlanMetaBySession[sessionId];
      const focusedMeta = sessionId === s.activeSessionId ? s.activePlanMeta : null;
      const base = prev ?? focusedMeta;
      // 没有该会话自己的计划时，绝不借用全局 path（那可能是另一个会话的）。
      if (!base) return {};
      const nextEntry = { ...base, tasks, currentTaskId };
      return {
        activePlanMetaBySession: {
          ...s.activePlanMetaBySession,
          [sessionId]: nextEntry,
        },
        activePlanMeta:
          sessionId === s.activeSessionId && s.activePlanMeta
            ? { ...s.activePlanMeta, tasks, currentTaskId }
            : s.activePlanMeta,
      };
    });
  },
  getActivePlanMetaForSession: (sessionId) => {
    const s = get();
    if (sessionId) {
      const entry = s.activePlanMetaBySession[sessionId];
      if (entry?.path) return entry as ActivePlanMetaDto;
      if (sessionId === s.activeSessionId && s.activePlanMeta?.path) {
        return s.activePlanMeta;
      }
      return null;
    }
    return s.activePlanMeta;
  },
  setChanges: (sessionId, changes) => {
    if (!sessionId) return;
    set((s) => ({
      changesBySession: { ...s.changesBySession, [sessionId]: changes },
    }));
  },
  getChangesForSession: (sessionId) => {
    const s = get();
    if (!sessionId) return [];
    return s.changesBySession[sessionId] ?? [];
  },
  setPlans: (plans, sessionId) => {
    const sid = sessionId ?? get().activeSessionId;
    set((s) => {
      const plansBySession = sid
        ? { ...s.plansBySession, [sid]: plans }
        : s.plansBySession;
      return {
        plansBySession,
        plans: !sid || sid === s.activeSessionId ? plans : s.plans,
      };
    });
  },
  getPlansForSession: (sessionId) => {
    const s = get();
    if (sessionId) {
      if (Object.prototype.hasOwnProperty.call(s.plansBySession, sessionId)) {
        return s.plansBySession[sessionId] ?? [];
      }
      if (sessionId === s.activeSessionId) return s.plans;
      return [];
    }
    return s.plans;
  },
  setGitStatus: (gitStatus) => set({ gitStatus }),

  applyTaskStatus: (taskId, status) => {
    const meta = get().activePlanMeta;
    if (!meta) return;
    const tasks = meta.tasks.map((t) =>
      t.id === taskId ? { ...t, status } : t,
    );
    set({ activePlanMeta: { ...meta, tasks } });
  },
}));
