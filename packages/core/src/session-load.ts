/**
 * 会话快照装入运行时。
 *
 * 从 index.ts (SessionOrchestrator.applyLoadedSession) 拆分：把磁盘会话
 * 快照合并进 runtimes（运行中/未完成会话绝不覆盖内存状态），并在必要时
 * 迁移旧格式历史、把完整 transcript 后台迁移到 conversation store。
 * 编排器只负责提供 runtimes/sessionRoots/state 与 isSessionIncomplete 判定。
 */
import type { AgentMode } from "@owncoder/shared";
import type { ChatTurn, DocumentWorkflowState } from "./harness/loop.ts";
import type { TerminalEntry } from "./harness/terminal.ts";
import type { QueuedMessage } from "./session-store.ts";
import type { TaskRunState } from "./task-run.ts";
import type { SessionRuntime } from "./session-runtime.ts";
import { createSessionRuntime } from "./session-runtime.ts";
import { sanitizeQueuedMessages } from "./session-store.ts";
import { migrateHistory, needsMigration } from "./session-migration.ts";
import { migrateLegacyHistory } from "./conversation-store.ts";
import { restoreTaskRunState } from "./task-run.ts";

/** 磁盘会话快照（PersistedSession 及 createSessionFile 的返回均满足此形状）。 */
export interface LoadedSession {
  id?: string;
  title?: string;
  createdAt?: string;
  mode: AgentMode;
  history: ChatTurn[];
  terminalLog: TerminalEntry[];
  lastPlanPath: string | null;
  currentFeature?: string | null;
  todoAnchor: string | null;
  lastCheckpointId: string | null;
  documentWorkflow?: DocumentWorkflowState | null;
  queuedMessages?: QueuedMessage[] | string[];
  taskRunState?: TaskRunState | null;
}

/** 装入过程需要读写的编排器状态子集（SessionState 结构兼容）。 */
export interface SessionFocusState {
  activeSessionId: string | null;
  mode: AgentMode;
  sessionTitle: string | null;
}

export interface SessionLoadHost {
  runtimes: Map<string, SessionRuntime>;
  sessionRoots: Map<string, string>;
  state: SessionFocusState;
  /** 当前全局工作区根；仅用于给新建运行时打上项目绑定。 */
  workspaceRoot(): string | null;
  isSessionIncomplete(sessionId: string): boolean;
}

export function applyLoadedSession(host: SessionLoadHost, saved: LoadedSession): void {
  const id = saved.id ?? null;
  if (!id) {
    console.error('[session] applyLoadedSession: 缺少会话ID');
    return;
  }

  let r = host.runtimes.get(id);
  const isNewRuntime = !r;

  if (!r) {
    r = createSessionRuntime(id, saved.mode);
    r.workspaceRoot = host.workspaceRoot() ?? null;
    host.runtimes.set(id, r);
  } else if (host.isSessionIncomplete(id)) {
    // 运行中/未完成：切回项目时绝不能用磁盘快照覆盖内存中的流式、队列、计划。
    host.state.activeSessionId = id;
    host.state.mode = r.mode;
    host.state.sessionTitle = r.sessionTitle;
    return;
  } else {
    // 如果运行时已存在且有内容，需要谨慎合并而不是直接覆盖
    if (r.history.length > 0 && saved.history.length === 0) {
      console.warn(`[session] 磁盘会话数据为空，保留内存中的历史 (${r.history.length} 条)`);
      // 保留内存中的数据，只更新其他字段
      r.mode = saved.mode;
      r.lastPlanPath = saved.lastPlanPath;
      r.currentFeature = saved.currentFeature ?? null;
      r.todoAnchor = saved.todoAnchor;
      r.lastCheckpointId = saved.lastCheckpointId;
      r.documentWorkflow = saved.documentWorkflow ?? null;
      r.sessionTitle = saved.title ?? r.sessionTitle;
      r.sessionCreatedAt = saved.createdAt ?? r.sessionCreatedAt;
      // 不覆盖 history 和 terminalLog
      host.state.activeSessionId = id;
      host.state.mode = saved.mode;
      host.state.sessionTitle = r.sessionTitle;
      return;
    }

    // 如果内存和磁盘都有内容，比较数量，优先使用内容更多的
    if (r.history.length > saved.history.length) {
      console.warn(`[session] 内存历史更完整 (${r.history.length}条) > 磁盘历史 (${saved.history.length}条)，保留内存数据`);
      host.state.activeSessionId = id;
      host.state.mode = r.mode;
      host.state.sessionTitle = r.sessionTitle;
      return;
    }
  }
  if (r.workspaceRoot) host.sessionRoots.set(id, r.workspaceRoot);

  // 安全地应用磁盘数据
  try {
    // 迁移旧格式历史记录（阶段三架构）
    let fullHistory = Array.isArray(saved.history) ? saved.history : [];
    if (fullHistory.length > 0) {
      try {
        if (needsMigration(fullHistory)) {
          console.log(`[SessionOrchestrator] Migrating session ${r.id} to structured message format`);
          fullHistory = migrateHistory(fullHistory);
        }
      } catch (err) {
        console.warn(`[SessionOrchestrator] Migration failed, using original history:`, err);
      }
    }

    // Only keep the tail of history in the runtime to bound startup memory.
    // The full transcript lives in the conversation store for UI pagination.
    const RECENT_LIMIT = 20;
    const recentHistory = fullHistory.slice(-RECENT_LIMIT);
    r.history = recentHistory;
    r.terminalLog = Array.isArray(saved.terminalLog) ? saved.terminalLog.slice(-20) : [];
    r.mode = saved.mode || 'agent';
    r.lastPlanPath = saved.lastPlanPath;
    r.currentFeature = saved.currentFeature ?? null;
    r.todoAnchor = saved.todoAnchor;
    r.lastCheckpointId = saved.lastCheckpointId;
    r.documentWorkflow = saved.documentWorkflow ?? null;
    r.queuedMessages = sanitizeQueuedMessages(saved.queuedMessages);
    r.taskRunState = restoreTaskRunState(saved.taskRunState, id) ?? null;
    r.sessionTitle = saved.title ?? null;
    r.sessionCreatedAt = saved.createdAt ?? null;
    r.sessionRestored = fullHistory.length > 0 || (saved.terminalLog?.length ?? 0) > 0;

    // Migrate the full legacy history to the conversation store in the
    // background so the UI can paginate older turns without keeping them
    // in the runtime. fire-and-forget, errors are non-fatal.
    if (fullHistory.length > RECENT_LIMIT && r.workspaceRoot) {
      const root = r.workspaceRoot;
      void migrateLegacyHistory(root, id, fullHistory).catch((err) => {
        console.warn(`[session] background conversation migration failed for ${id}:`, err);
      });
    }

    console.log(`[session] ${isNewRuntime ? '创建新运行时' : '更新现有运行时'}: ${id}, 历史: ${r.history.length}/${fullHistory.length}条, 终端: ${r.terminalLog.length}条`);
  } catch (error) {
    console.error(`[session] 应用会话数据失败: ${id}`, error);
    // 如果应用失败，至少确保运行时处于可用状态
    if (isNewRuntime) {
      r.history = [];
      r.terminalLog = [];
      r.mode = 'agent';
      r.sessionTitle = '恢复失败的会话';
    }
  }

  // Make this the focus session.
  host.state.activeSessionId = id;
  host.state.mode = r.mode;
  host.state.sessionTitle = r.sessionTitle;
}
