/**
 * Spec 文档工作流与任务执行准备。
 *
 * 需求与设计通过对话推进；任务清单只在用户点击执行或全部执行后启动。
 *
 * 设计与 session-plans.ts 对称：通过 SpecsHost 桥接编排器，只依赖会话
 * 运行时、项目根与持久化，编排器方法退化为委托。
 */
import type { AgentMode } from "@owncoder/shared";
import type { SessionRuntime, SessionState } from "./session-runtime.ts";
import { readSpecTaskDocument, specTaskFeature, specTaskVersion, type SpecTaskDocument } from "./spec-task-document.ts";
import {
  extractTitle,
  normalizeTasks,
  parseTasksFromMarkdown,
  selectNextPendingTask,
  writeActiveMeta,
  type ActivePlanMeta,
} from "./plans.ts";
import {
  getSpecStatus as readSpecStatusFromDisk,
  listSpecs,
  readSpecPhase,
  validateTasksContent,
  writeFeatureState,
  type SpecFeature,
  type SpecStatus,
} from "./specs.ts";

/** 宿主桥：编排器向本模块提供的方法与状态（SessionOrchestrator 满足该接口）。 */
export interface SpecsHost {
  rt(id?: string | null): SessionRuntime;
  sessionWorkspaceRoot(sessionId?: string | null): string;
  focusSessionId(): string | null;
  /** 焦点会话模式回写（this.state.mode）。 */
  setFocusMode(mode: AgentMode): void;
  persist(sessionId?: string, activityUpdatedAt?: string): Promise<void>;
  getState(sessionId?: string | null): SessionState;
}

export async function listSpecFeatures(
  host: SpecsHost,
  sessionId?: string,
): Promise<SpecFeature[]> {
  const sid = sessionId ?? host.focusSessionId();
  if (!sid) return [];
  return listSpecs(host.sessionWorkspaceRoot(sid), sid);
}

export async function getSpecStatus(
  host: SpecsHost,
  feature: string,
  sessionId?: string,
): Promise<SpecStatus> {
  const r = host.rt(sessionId);
  return readSpecStatusFromDisk(host.sessionWorkspaceRoot(r.id), feature, r.id);
}

export async function getSpecTaskDocument(host: SpecsHost, path: string, sessionId: string): Promise<SpecTaskDocument | null> {
  const r = host.rt(sessionId);
  return readSpecTaskDocument(host.sessionWorkspaceRoot(r.id), path, r.id, r.activePlanPath);
}

export async function prepareSpecTaskExecution(host: SpecsHost, path: string, expectedVersion: string, sessionId: string): Promise<SessionState> {
  const r = host.rt(sessionId);
  const root = host.sessionWorkspaceRoot(r.id);
  const feature = specTaskFeature(path, r.id);
  if (!feature) throw new Error("任务清单不属于当前会话");
  const document = await getSpecTaskDocument(host, path, sessionId);
  if (!document || document.version !== expectedVersion) throw new Error("任务清单已修改，请重新加载后执行");
  if (document.tasks.some((task) => task.status === "in_progress")) throw new Error("任务正在执行");
  const runnable = selectNextPendingTask(document.tasks.map((task) => task.status === "failed" ? { ...task, status: "pending" } : task));
  if (!runnable) throw new Error("没有可执行的任务，请检查任务状态和依赖");
  if (!document.approvedAt) {
    const body = await readSpecPhase(root, feature, "tasks", r.id);
    const documentDigest = specTaskVersion(body);
    if (documentDigest !== expectedVersion) throw new Error("任务清单已修改，请重新加载后执行");
    const design = await readSpecPhase(root, feature, "design", r.id).catch(() => undefined);
    validateTasksContent(body, design);
    const tasks = normalizeTasks(parseTasksFromMarkdown(body, true));
    // Legacy on-disk fields identify the active execution snapshot, not an approval action.
    const meta: ActivePlanMeta = {
      path,
      approvedAt: new Date().toISOString(),
      documentDigest,
      title: extractTitle(body, path) || feature,
      tasks,
      currentTaskId: runnable.id,
      status: "approved",
      sessionId: r.id,
    };
    await writeActiveMeta(root, meta, r.id);
    await writeFeatureState(root, feature, "approved", r.id);
  }

  r.currentFeature = feature;
  r.activePlanPath = path;
  r.lastPlanPath = path;
  r.mode = "agent";
  r.todoAnchor = null;
  if (r.id === host.focusSessionId()) host.setFocusMode("agent");
  await host.persist(sessionId);
  return host.getState(sessionId);
}
