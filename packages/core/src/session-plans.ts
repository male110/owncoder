/**
 * 计划 / 任务 / 检查点 / 变更管理。
 *
 * 从 index.ts (SessionOrchestrator) 拆分：活动计划批准与任务推进
 * （approvePlan/updateTask/clearActivePlan）、待定变更的 accept/undo
 * （getPendingChanges/keepAllChanges/keepChange/undoChange/rollbackCheckpoint）
 * 以及计划文件列表读取。这些操作只依赖会话运行时、会话绑定的项目根、
 * 索引失效与 persist，因此通过 PlansHost 桥接，编排器方法退化为委托。
 */
import { resolve } from "node:path";
import { promises as fs } from "node:fs";
import type { AgentMode } from "@owncoder/shared";
import type { IndexClient } from "@owncoder/index";
import type { ChatTurn } from "./harness/loop.ts";
import type { SessionRuntime, SessionState } from "./session-runtime.ts";
import {
  listCheckpoints as listCheckpointMetas,
  loadCheckpoint,
  restoreCheckpointFiles,
} from "./harness/checkpoint.ts";
import { buildChangesFromCheckpoint, restoreSingleFile, type ChangeFile } from "./changes.ts";
import {
  extractTitle,
  isPlanPath,
  listPlans as listPlanFiles,
  readActiveMeta,
  readPlanFile,
  writeActiveMeta,
  writePlanFile,
  parseTasksFromMarkdown,
  normalizeTasks,
  selectNextPendingTask,
  ACTIVE_DIR,
  type ActivePlanMeta,
  type PlanInfo,
  type TaskItem,
  type TaskStatus,
} from "./plans.ts";

const ERR_NO_WORKSPACE = "请先打开项目文件夹";

/** 宿主桥：编排器向本模块提供的方法与状态（SessionOrchestrator 满足该接口）。 */
export interface PlansHost {
  rt(id?: string | null): SessionRuntime;
  rtOpt(id?: string | null): SessionRuntime | undefined;
  sessionWorkspaceRoot(sessionId?: string | null): string;
  /** 全局工作区根（this.state.workspace?.root）。 */
  workspaceRoot(): string | null;
  /** 焦点会话 ID（this.state.activeSessionId）。 */
  focusSessionId(): string | null;
  /** 焦点会话模式回写（this.state.mode）。 */
  setFocusMode(mode: AgentMode): void;
  /** 全局查询索引（this.index）；用于 undo/rollback 后失效条目。 */
  index: IndexClient;
  persist(sessionId?: string, activityUpdatedAt?: string): Promise<void>;
  getState(sessionId?: string): SessionState;
  enqueueActivePlanUpdate<T>(update: () => Promise<T>, sessionId?: string): Promise<T>;
}

/**
 * List plan files. Plans are scoped to the chat session that saved them:
 * when `sessionId` is given only that session's plans are returned, so a
 * freshly created session no longer surfaces plans from older sessions.
 * Omitting `sessionId` (legacy callers) returns the unfiltered list.
 */
export async function listPlans(host: PlansHost, sessionId?: string): Promise<PlanInfo[]> {
  const root = sessionId ? host.sessionWorkspaceRoot(sessionId) : host.workspaceRoot();
  if (!root) return [];
  const plans = await listPlanFiles(root);
  if (!sessionId) return plans;
  return plans.filter((p) => p.sessionId === sessionId);
}

export async function readPlan(host: PlansHost, relPath: string): Promise<string> {
  const root = host.workspaceRoot();
  if (!root) throw new Error(ERR_NO_WORKSPACE);
  return readPlanFile(root, relPath);
}

export async function getActivePlan(host: PlansHost, sessionId?: string): Promise<ActivePlanMeta | null> {
  const sid = sessionId ?? host.focusSessionId();
  const root = sid ? host.sessionWorkspaceRoot(sid) : host.workspaceRoot();
  if (!root) return null;
  return readActiveMeta(root, sid ?? undefined);
}

export async function updateTask(
  host: PlansHost,
  taskId: string,
  status: TaskStatus,
  result?: string,
  sessionId?: string,
): Promise<ActivePlanMeta | null> {
  const sid = sessionId ?? host.focusSessionId();
  const root = sid ? host.sessionWorkspaceRoot(sid) : host.workspaceRoot();
  if (!root) throw new Error(ERR_NO_WORKSPACE);
  return host.enqueueActivePlanUpdate(async () => {
    const meta = await readActiveMeta(root, sid ?? undefined);
    if (!meta) throw new Error("没有活动计划");
    const t = meta.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error(`找不到任务 ${taskId}`);
    t.status = status;
    if (result !== undefined) t.result = result.slice(0, 400);
    if (status === "in_progress") meta.currentTaskId = taskId;
    if (meta.currentTaskId === null || meta.currentTaskId === taskId) {
      const next = selectNextPendingTask(meta.tasks);
      meta.currentTaskId = status === "completed" || status === "failed" || status === "skipped"
        ? (next?.id ?? null)
        : meta.currentTaskId;
    }
    await writeActiveMeta(root, meta, sid ?? undefined);
    return meta;
  }, sessionId);
}

export async function listCheckpoints(host: PlansHost): Promise<
  Array<{ id: string; createdAt: string; touched: string[]; historyLen: number }>
> {
  const root = host.workspaceRoot();
  const sessionId = host.focusSessionId();
  if (!root || !sessionId) return [];
  return listCheckpointMetas(root, sessionId);
}

export async function getPendingChanges(host: PlansHost, sessionId?: string): Promise<{
  checkpointId: string | null;
  files: ChangeFile[];
  /** True when this session had a checkpoint but it is gone from disk. */
  expired?: boolean;
}> {
  const root = sessionId ? host.sessionWorkspaceRoot(sessionId) : host.workspaceRoot();
  const r = host.rtOpt(sessionId);
  if (!root || !r || !r.lastCheckpointId) {
    return { checkpointId: null, files: [] };
  }
  const cp = await loadCheckpoint(root, r.lastCheckpointId);
  if (!cp) {
    // The checkpoint this session pointed at is no longer on disk (pruned, or
    // deleted externally). Say so instead of reporting "no pending changes",
    // which reads as "nothing to undo" and silently drops undo capability.
    console.log(
      `[checkpoint] session checkpoint ${r.lastCheckpointId} is missing; undo unavailable`,
    );
    r.lastCheckpointId = null;
    return { checkpointId: null, files: [], expired: true };
  }
  const files = (await buildChangesFromCheckpoint(root, cp)).filter(
    (f) => !r.keptPaths.has(f.path),
  );
  return { checkpointId: cp.id, files };
}

/** Accept all pending file changes (keep on disk). */
export async function keepAllChanges(host: PlansHost, sessionId?: string): Promise<void> {
  const r = host.rtOpt(sessionId);
  if (r) {
    r.keptPaths.clear();
    r.lastCheckpointId = null;
    await host.persist(sessionId);
  }
}

export async function keepChange(host: PlansHost, path: string, sessionId?: string): Promise<void> {
  const r = host.rtOpt(sessionId);
  if (!r) return;
  r.keptPaths.add(path);
  const pending = await getPendingChanges(host, sessionId);
  if (pending.files.length === 0) {
    r.keptPaths.clear();
    r.lastCheckpointId = null;
    await host.persist(sessionId);
  }
}

export async function undoChange(host: PlansHost, path: string, sessionId?: string): Promise<void> {
  const root = sessionId ? host.sessionWorkspaceRoot(sessionId) : host.workspaceRoot();
  const r = host.rtOpt(sessionId);
  if (!root || !r || !r.lastCheckpointId) throw new Error("没有可撤销的变更");
  const cp = await loadCheckpoint(root, r.lastCheckpointId);
  if (!cp) throw new Error("找不到检查点");
  const snap = cp.files.find((f) => f.path === path);
  if (!snap) throw new Error(`检查点中无文件：${path}`);
  await restoreSingleFile(root, snap);
  host.index.invalidate(path);
  r.keptPaths.add(path);
  const pending = await getPendingChanges(host, sessionId);
  if (pending.files.length === 0) {
    r.keptPaths.clear();
    r.lastCheckpointId = null;
  }
  await host.persist(sessionId);
}

/**
 * Roll back the latest (or given) turn checkpoint: restore files, history, invalidate index.
 *
 * `.owncoder/checkpoints/` is workspace-global, so target selection must be
 * session-aware: previously this picked the newest checkpoint on disk ahead of
 * the current session's own, which could restore another session's files and
 * overwrite this conversation with that session's history.
 */
export async function rollbackCheckpoint(
  host: PlansHost,
  id?: string,
  sessionId?: string,
): Promise<{ restored: string[]; checkpointId: string }> {
  const r = host.rt(sessionId);
  const root = host.sessionWorkspaceRoot(r.id);
  const activeSessionId = r.id;
  let targetId = id ?? r.lastCheckpointId ?? null;
  if (!targetId) {
    // Fall back to the newest checkpoint that belongs to this session.
    const list = await listCheckpointMetas(root, activeSessionId);
    targetId = list[0]?.id ?? null;
  }
  if (!targetId) throw new Error("没有可回滚的检查点");
  const cp = await loadCheckpoint(root, targetId);
  if (!cp) throw new Error(`找不到检查点：${targetId}`);

  const owner = cp.sessionId ?? null;
  if (owner && activeSessionId && owner !== activeSessionId) {
    throw new Error(
      `检查点 ${cp.id} 属于另一个会话，拒绝回滚（避免覆盖当前会话的文件与对话历史）。`,
    );
  }

  const restored = await restoreCheckpointFiles(root, cp);
  for (const p of restored) {
    host.index.invalidate(p);
  }
  // Only adopt the checkpoint's conversation when we can prove it is ours.
  // Legacy checkpoints carry no sessionId; restoring their files is fine, but
  // replacing the live history with a foreign one is unrecoverable.
  if (owner && activeSessionId && owner === activeSessionId) {
    r.history = (cp.history as ChatTurn[]).map((h) => ({ ...h }));
  }
  r.lastCheckpointId = null;
  r.keptPaths.clear();
  r.history.push({
    role: "assistant",
    content: `已回滚检查点 ${cp.id}（${restored.length} 个文件）。`,
  });
  await host.persist(sessionId);
  return { restored, checkpointId: cp.id };
}

export async function approvePlan(
  host: PlansHost,
  opts?: {
    path?: string;
    content?: string;
    title?: string;
    tasks?: TaskItem[];
  },
  sessionId?: string,
): Promise<SessionState> {
  const r = host.rt(sessionId);
  const root = host.sessionWorkspaceRoot(r.id);

  let path = opts?.path?.trim();
  if (path) {
    if (!isPlanPath(path)) {
      throw new Error("批准路径必须在 .owncoder/plans/ 下");
    }
  } else if (opts?.content?.trim()) {
    path = await writePlanFile(root, opts.content, { title: opts.title, sessionId: r.id });
  } else if (r.lastPlanPath) {
    path = r.lastPlanPath;
  } else {
    const lastAssistant = [...r.history]
      .reverse()
      .find((h) => h.role === "assistant" && h.content.trim().length > 40);
    if (!lastAssistant) {
      throw new Error("没有可批准的计划 - 请先 save_plan 或传入内容");
    }
    path = await writePlanFile(root, lastAssistant.content, {
      title: opts?.title ?? "已批准的计划",
      sessionId: r.id,
    });
  }

  // 防重复批准：该计划已是活动计划则拒绝，闭环状态机
  if (r.activePlanPath === path) {
    throw new Error("该计划已批准并切换到 Agent 模式，无需重复操作");
  }

  const body = await readPlanFile(root, path);
  const tasks = normalizeTasks(opts?.tasks && opts.tasks.length > 0 ? opts.tasks : parseTasksFromMarkdown(body));
  const firstPending = selectNextPendingTask(tasks);
  const meta: ActivePlanMeta = {
    path,
    approvedAt: new Date().toISOString(),
    title: extractTitle(body, path),
    tasks,
    currentTaskId: firstPending?.id ?? null,
    status: "approved",
    sessionId: r.id,
  };
  await writeActiveMeta(root, meta, r.id);

  // 清除 checkpoint 引用：Plan 模式生成的文档文件（PRD/TDD 等）以 existed=false
  // 记录在 checkpoint 中，若不清除，后续 rollback 会因 existed=false 将其删除。
  // 批准即视为用户确认所有生成产物，无需保留回滚能力。
  r.keptPaths.clear();
  r.lastCheckpointId = null;

  r.activePlanPath = path;
  r.lastPlanPath = path;
  r.mode = "agent";
  r.todoAnchor = null;
  if (r.id === host.focusSessionId()) {
    host.setFocusMode("agent");
  }

  r.history.push({
    role: "assistant",
    content: `✅ 计划已批准 → 已切换到 Agent 模式。\n\n📋 **活动计划**：${path}\n📊 **任务总数**：${tasks.length}\n\n💡 **下一步**：在下方输入框发送消息（如"开始执行"）即可触发 Agent 按顺序执行任务。`,
  });

  await host.persist(sessionId);
  return host.getState(sessionId);
}

export async function clearActivePlan(host: PlansHost, sessionId?: string): Promise<SessionState> {
  const sid = sessionId ?? host.focusSessionId();
  const root = sid ? host.sessionWorkspaceRoot(sid) : host.workspaceRoot();
  if (root && sid) {
    // 删除 session-scoped 的活动计划文件
    const activePath = resolve(root, ACTIVE_DIR, `${sid}.json`);
    await fs.unlink(activePath).catch(() => undefined);
  }
  const r = host.rtOpt(sessionId);
  if (r) r.activePlanPath = null;
  await host.persist(sessionId);
  return host.getState(sessionId);
}
