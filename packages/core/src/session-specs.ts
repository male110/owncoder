/**
 * Spec 工作流审批闸门（Kiro 风格）。
 *
 * spec → design → tasks 三段式，每一段文档生成后暂停等待用户审批：
 * approveSpecPhase 推进闸门（tasks 审批后切换 Agent 模式并复用计划执行器），
 * rejectSpecPhase 把用户反馈推入对话让模型修订重写。
 *
 * 设计与 session-plans.ts 对称：通过 SpecsHost 桥接编排器，只依赖会话
 * 运行时、项目根与持久化，编排器方法退化为委托。
 */
import type { AgentMode } from "@owncoder/shared";
import type { SessionRuntime, SessionState } from "./session-runtime.ts";
import {
  extractTitle,
  normalizeTasks,
  parseTasksFromMarkdown,
  selectNextPendingTask,
  writeActiveMeta,
  type ActivePlanMeta,
} from "./plans.ts";
import {
  featureDirRel,
  getSpecStatus as readSpecStatusFromDisk,
  listSpecs,
  phaseUnderReview,
  readFeatureState,
  readSpecPhase,
  saveDesign,
  saveSpec,
  saveTasks,
  writeFeatureState,
  type SpecFeature,
  type SpecPhase,
  type SpecStatus,
  type SpecStage,
} from "./specs.ts";

const ERR_NO_WORKSPACE = "请先打开项目文件夹";

const STAGE_LABEL: Record<SpecStage, string> = {
  awaiting_spec_approval: "spec 待审批",
  spec_approved: "spec 已批准",
  awaiting_design_approval: "design 待审批",
  design_approved: "design 已批准",
  awaiting_tasks_approval: "tasks 待审批",
  approved: "tasks 已批准，执行中",
};

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
  const root = sessionId ? host.sessionWorkspaceRoot(sessionId) : host.sessionWorkspaceRoot();
  if (!root) return [];
  return listSpecs(root);
}

export async function readSpecDocument(
  host: SpecsHost,
  feature: string,
  phase: SpecPhase,
): Promise<string> {
  const root = host.sessionWorkspaceRoot();
  if (!root) throw new Error(ERR_NO_WORKSPACE);
  return readSpecPhase(root, feature, phase);
}

export async function getSpecStatus(
  host: SpecsHost,
  feature: string,
): Promise<SpecStatus> {
  const root = host.sessionWorkspaceRoot();
  if (!root) throw new Error(ERR_NO_WORKSPACE);
  return readSpecStatusFromDisk(root, feature);
}

/** UI 内联编辑后保存某阶段文档（不改变审批闸门状态）。 */
export async function saveSpecDocument(
  host: SpecsHost,
  feature: string,
  phase: SpecPhase,
  content: string,
  sessionId?: string,
): Promise<SessionState> {
  const root = sessionId ? host.sessionWorkspaceRoot(sessionId) : host.sessionWorkspaceRoot();
  if (!root) throw new Error(ERR_NO_WORKSPACE);
  if (phase === "spec") await saveSpec(root, feature, content);
  else if (phase === "design") await saveDesign(root, feature, content);
  else await saveTasks(root, feature, content);
  await host.persist(sessionId);
  return host.getState(sessionId);
}

/**
 * 批准当前等待审批的阶段。
 * - spec → design：标记 spec 已批准，等待生成 design。
 * - design → tasks：标记 design 已批准，等待生成 tasks。
 * - tasks：解析任务、写入 ActivePlanMeta、切换 Agent 模式（复用计划执行器）。
 */
export async function approveSpecPhase(
  host: SpecsHost,
  feature: string,
  sessionId?: string,
): Promise<SessionState> {
  const r = host.rt(sessionId);
  const root = host.sessionWorkspaceRoot(r.id);
  if (!root) throw new Error(ERR_NO_WORKSPACE);

  const state = await readFeatureState(root, feature);
  if (!state) {
    throw new Error(`特性 ${feature} 尚未生成任何 spec 文档`);
  }
  const phase = phaseUnderReview(state.stage);
  if (!phase) {
    const next: Record<string, string> = {
      spec_approved: "spec 已批准，请让模型生成 design.md",
      design_approved: "design 已批准，请让模型生成 tasks.md",
      approved: "tasks 已批准并进入执行，无需重复操作",
    };
    throw new Error(next[state.stage] ?? `当前状态 ${STAGE_LABEL[state.stage]} 无需审批`);
  }

  r.currentFeature = feature;

  if (phase === "spec" || phase === "design") {
    await writeFeatureState(root, feature, phase === "spec" ? "spec_approved" : "design_approved");
    const nextDoc = phase === "spec" ? "design.md（技术设计）" : "tasks.md（任务清单）";
    r.history.push({
      role: "assistant",
      content:
        `✅ ${feature} 的 ${phase}.md 已批准。\n\n` +
        `📋 **下一步**：生成 ${nextDoc}。` +
        (phase === "spec"
          ? "请基于已批准的 spec 探索代码库，产出 design.md。"
          : "请基于已批准的 spec 和 design 产出 tasks.md 任务清单。"),
    });
    await host.persist(sessionId);
    return host.getState(sessionId);
  }

  // tasks 审批 → 激活执行（与 approvePlan 同款机制）
  const path = `${featureDirRel(feature)}/tasks.md`;
  const body = await readSpecPhase(root, feature, "tasks");
  const tasks = normalizeTasks(parseTasksFromMarkdown(body));
  if (tasks.length === 0) {
    throw new Error("tasks.md 中没有解析到任务，无法执行");
  }
  const firstPending = selectNextPendingTask(tasks);
  const meta: ActivePlanMeta = {
    path,
    approvedAt: new Date().toISOString(),
    title: extractTitle(body, path) || feature,
    tasks,
    currentTaskId: firstPending?.id ?? null,
    status: "approved",
    sessionId: r.id,
  };
  await writeActiveMeta(root, meta, r.id);

  // 清除 checkpoint 引用：生成的 spec 文档以 existed=false 记录在 checkpoint 中，
  // 若不清除，后续 rollback 会将其删除。批准即视为用户确认所有生成产物。
  r.keptPaths.clear();
  r.lastCheckpointId = null;

  r.activePlanPath = path;
  r.lastPlanPath = path;
  r.mode = "agent";
  r.todoAnchor = null;
  if (r.id === host.focusSessionId()) {
    host.setFocusMode("agent");
  }

  await writeFeatureState(root, feature, "approved");

  r.history.push({
    role: "assistant",
    content:
      `✅ ${feature} 的 tasks.md 已批准 → 已切换到 Agent 模式。\n\n` +
      `📋 **活动计划**：${path}\n📊 **任务总数**：${tasks.length}\n\n` +
      `💡 **下一步**：在下方输入框发送消息（如"开始执行"）即可触发 Agent 按顺序执行任务。`,
  });

  await host.persist(sessionId);
  return host.getState(sessionId);
}

/**
 * 驳回当前等待审批的阶段：把用户反馈推入对话历史，模型据此修订并重新保存。
 * 闸门状态保持不变（仍是 awaiting_*_approval），重写后再次等待审批。
 */
export async function rejectSpecPhase(
  host: SpecsHost,
  feature: string,
  feedback: string,
  sessionId?: string,
): Promise<SessionState> {
  const r = host.rt(sessionId);
  const root = host.sessionWorkspaceRoot(r.id);
  if (!root) throw new Error(ERR_NO_WORKSPACE);

  const state = await readFeatureState(root, feature);
  if (!state) {
    throw new Error(`特性 ${feature} 尚未生成任何 spec 文档`);
  }
  const phase = phaseUnderReview(state.stage);
  if (!phase) {
    throw new Error(`当前状态「${STAGE_LABEL[state.stage]}」不在等待审批，无法驳回`);
  }

  r.currentFeature = feature;
  r.history.push({
    role: "user",
    content:
      `↩️ ${feature} 的 ${phase}.md 未通过审批。请修改后重新保存。\n\n` +
      `**用户反馈**：${feedback.trim() || "（未填写具体意见，请重新审视该文档）"}`,
  });

  await host.persist(sessionId);
  return host.getState(sessionId);
}
