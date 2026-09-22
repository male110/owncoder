/** 任务执行的统一状态、事件和验证协议。 */

export type TaskRunPhase = "planning" | "executing" | "verifying" | "repairing" | "completed" | "failed" | "blocked" | "interrupted";
export type VerificationStatus = "passed" | "failed" | "blocked" | "skipped" | "not_run";

export interface VerificationError { file?: string; line?: number; column?: number; message: string; severity: "error" | "warning" | "info"; code?: string; }
export interface VerificationCheck {
  name: string;
  type: "typecheck" | "lint" | "execution" | "semantic_diff" | "lsp";
  status: VerificationStatus;
  passed: boolean;
  output: string;
  duration: number;
  errors: VerificationError[];
  /**
   * 是否阻断成功门禁。
   * - skipped / passed / 纯建议性 semantic_diff（warning）→ false
   * - 硬失败（typecheck/lint/execution / lsp error）→ true
   */
  blocking?: boolean;
  /** 与 status==="skipped" 对齐，便于旧消费者不读 status。 */
  skipped?: boolean;
  /** 检查来源，如 tsc / eslint / semantic_diff / lsp / post_verify。 */
  source?: string;
}
export interface VerificationResult {
  status: VerificationStatus;
  passed: boolean;
  checks: VerificationCheck[];
  summary: string;
  suggestions: string[];
}
/** 单次任务运行的可观测性指标（阶段四）。 */
export interface TaskRunMetrics {
  /** 任务开始时间（ISO）。 */
  startedAt: string;
  /** 当前 phase 进入时刻（epoch ms），用于累计阶段耗时。 */
  phaseStartedAtMs: number;
  /** 各阶段累计耗时（毫秒）。 */
  phaseDurationsMs: Partial<Record<TaskRunPhase, number>>;
  /** 模型采样（LLM 调用）次数。 */
  modelSampleCount: number;
  /** 工具调用次数。 */
  toolCallCount: number;
  /** 重试次数（含 LLM 重试与步骤重试）。 */
  retryCount: number;
  /** 上下文压缩次数。 */
  contextCompressionCount: number;
  /** 验证失败原因列表（按发生顺序，去重保留首次）。 */
  verificationFailureReasons: string[];
  /** 自动修复完成次数（含成功与失败）。 */
  repairCompletedCount: number;
  /** 自动修复成功次数。 */
  repairResolvedCount: number;
  /**
   * 自动修复成功率：resolved/completed；尚无修复记录时为 null。
   * 由 applyTaskEvent 在 repair_completed 时重算。
   */
  repairSuccessRate: number | null;
  /** 最终完成 / 失败 / 阻塞原因；运行中为 null。 */
  terminalReason: string | null;
}

export interface TaskRunState {
  taskId: string;
  phase: TaskRunPhase;
  currentStepId: string | null;
  verification: VerificationResult;
  repairAttempts: number;
  maxRepairAttempts: number;
  updatedAt: string;
  /** 本轮任务可观测性指标。 */
  metrics: TaskRunMetrics;
}

const TERMINAL_PHASES: ReadonlySet<TaskRunPhase> = new Set([
  "completed",
  "failed",
  "blocked",
  "interrupted",
]);

export function createTaskRunMetrics(now = Date.now()): TaskRunMetrics {
  return {
    startedAt: new Date(now).toISOString(),
    phaseStartedAtMs: now,
    phaseDurationsMs: {},
    modelSampleCount: 0,
    toolCallCount: 0,
    retryCount: 0,
    contextCompressionCount: 0,
    verificationFailureReasons: [],
    repairCompletedCount: 0,
    repairResolvedCount: 0,
    repairSuccessRate: null,
    terminalReason: null,
  };
}

function nonNegInt(value: unknown, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : fallback;
}

function repairSuccessRateOf(resolved: number, completed: number): number | null {
  if (completed <= 0) return null;
  return resolved / completed;
}

/** 规范化/恢复 metrics；兼容无 metrics 的旧快照。 */
export function normalizeTaskRunMetrics(value: unknown, now = Date.now()): TaskRunMetrics {
  const base = createTaskRunMetrics(now);
  if (!value || typeof value !== "object") return base;
  const raw = value as Record<string, unknown>;

  const phaseDurationsMs: Partial<Record<TaskRunPhase, number>> = {};
  if (raw.phaseDurationsMs && typeof raw.phaseDurationsMs === "object") {
    for (const [key, ms] of Object.entries(raw.phaseDurationsMs as Record<string, unknown>)) {
      if (Number.isFinite(ms)) phaseDurationsMs[key as TaskRunPhase] = Math.max(0, Number(ms));
    }
  }

  const reasons = Array.isArray(raw.verificationFailureReasons)
    ? raw.verificationFailureReasons.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    : [];

  const repairCompletedCount = nonNegInt(raw.repairCompletedCount);
  const repairResolvedCount = Math.min(nonNegInt(raw.repairResolvedCount), repairCompletedCount);

  return {
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : base.startedAt,
    phaseStartedAtMs: Number.isFinite(raw.phaseStartedAtMs) ? Number(raw.phaseStartedAtMs) : base.phaseStartedAtMs,
    phaseDurationsMs,
    modelSampleCount: nonNegInt(raw.modelSampleCount),
    toolCallCount: nonNegInt(raw.toolCallCount),
    retryCount: nonNegInt(raw.retryCount),
    contextCompressionCount: nonNegInt(raw.contextCompressionCount),
    verificationFailureReasons: reasons,
    repairCompletedCount,
    repairResolvedCount,
    repairSuccessRate: repairSuccessRateOf(repairResolvedCount, repairCompletedCount),
    terminalReason: typeof raw.terminalReason === "string" ? raw.terminalReason : null,
  };
}

function accumulatePhaseDuration(
  metrics: TaskRunMetrics,
  fromPhase: TaskRunPhase,
  nowMs: number,
): TaskRunMetrics {
  const elapsed = Math.max(0, nowMs - metrics.phaseStartedAtMs);
  const prev = metrics.phaseDurationsMs[fromPhase] ?? 0;
  return {
    ...metrics,
    phaseDurationsMs: {
      ...metrics.phaseDurationsMs,
      [fromPhase]: prev + elapsed,
    },
    phaseStartedAtMs: nowMs,
  };
}

function pushUniqueReason(reasons: readonly string[], reason: string): string[] {
  const trimmed = reason.trim();
  if (!trimmed) return [...reasons];
  if (reasons.includes(trimmed)) return [...reasons];
  return [...reasons, trimmed];
}

function defaultTerminalReason(phase: TaskRunPhase): string | null {
  switch (phase) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "interrupted":
      return "interrupted";
    default:
      return null;
  }
}

/** 将磁盘/旧调用方输入恢复为完整且可安全继续的运行状态。 */
export function restoreTaskRunState(value: unknown, taskId?: string): TaskRunState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.taskId !== "string" || (taskId && raw.taskId !== taskId)) return null;
  const phases: TaskRunPhase[] = ["planning", "executing", "verifying", "repairing", "completed", "failed", "blocked", "interrupted"];
  const phase = phases.includes(raw.phase as TaskRunPhase) ? raw.phase as TaskRunPhase : "planning";
  const verification = raw.verification && typeof raw.verification === "object"
    ? normalizeVerificationResult(raw.verification as VerificationResult)
    : createTaskRunState(raw.taskId).verification;
  return {
    taskId: raw.taskId,
    phase,
    currentStepId: typeof raw.currentStepId === "string" ? raw.currentStepId : null,
    verification,
    repairAttempts: Number.isFinite(raw.repairAttempts) ? Math.max(0, Number(raw.repairAttempts)) : 0,
    maxRepairAttempts: Number.isFinite(raw.maxRepairAttempts) ? Math.max(1, Number(raw.maxRepairAttempts)) : 3,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    metrics: normalizeTaskRunMetrics(raw.metrics),
  };
}
export type TaskEvent =
  | { type: "phase_changed"; phase: TaskRunPhase; taskId: string; reason?: string }
  | { type: "tool_completed"; taskId: string; tool: string; ok: boolean; output?: string; count?: number }
  | { type: "verification_completed"; taskId: string; result: VerificationResult }
  | { type: "repair_completed"; taskId: string; attempt: number; resolved: boolean }
  | {
      type: "observability";
      taskId: string;
      /** 增量：模型采样次数 */
      modelSamples?: number;
      /** 增量：工具调用次数 */
      toolCalls?: number;
      /** 增量：重试次数 */
      retries?: number;
      /** 增量：上下文压缩次数 */
      contextCompressions?: number;
      /** 覆盖写入最终原因（非增量） */
      terminalReason?: string;
    };

export function verificationStatus(passed: boolean, checks: readonly VerificationCheck[]): VerificationStatus {
  if (checks.length === 0) return "not_run";
  const active = checks.filter((check) => check.status !== "skipped" && check.skipped !== true);
  if (active.length === 0) return "skipped";
  const hasBlockingFailure = active.some((check) => {
    const blocking =
      typeof check.blocking === "boolean"
        ? check.blocking
        : deriveCheckBlocking({
            type: check.type,
            status: check.status,
            passed: check.passed,
            errors: check.errors ?? [],
          });
    return blocking && !(check.status === "passed" && check.passed);
  });
  if (hasBlockingFailure) return "failed";
  if (active.every((check) => (check.status === "passed" && check.passed) || check.blocking === false)) {
    return "passed";
  }
  return passed ? "passed" : "failed";
}

function defaultCheckSource(check: Pick<VerificationCheck, "name" | "type" | "source">): string {
  if (typeof check.source === "string" && check.source.trim()) return check.source.trim();
  if (check.name && check.name !== check.type) return check.name;
  return check.type;
}

function deriveCheckBlocking(check: {
  type: VerificationCheck["type"];
  status: VerificationStatus;
  passed: boolean;
  errors: VerificationError[];
  blocking?: boolean;
}): boolean {
  if (typeof check.blocking === "boolean") return check.blocking;
  if (check.status === "skipped") return false;
  if (check.status === "passed" && check.passed) return false;
  if (check.type === "semantic_diff") {
    // semantic_diff 仅在存在 error 级问题时阻断；warning/info 为建议性。
    return check.errors.some((error) => error.severity === "error");
  }
  if (check.type === "lsp") {
    // LSP：仅 error 级诊断阻断并进入 auto-fix；warning/info 仍为建议性。
    return check.errors.some((error) => error.severity === "error");
  }
  return check.status === "failed" || check.passed === false;
}

/** 将旧的 passed-only 结果规范化，避免 status 与 passed 相互矛盾。 */
export function normalizeVerificationResult(result: VerificationResult): VerificationResult {
  const checks = result.checks.map((check) => {
    // 旧快照没有 status：先依据旧 passed 字段推导，再按统一规则计算 passed。
    const status = check.status ?? (check.passed === true ? "passed" : check.skipped === true ? "skipped" : "failed");
    const skipped = status === "skipped" || check.skipped === true;
    const normalizedErrors = Array.isArray(check.errors) ? check.errors : [];
    const checkPassed = skipped ? false : status === "passed" && check.passed === true;
    const blocking = deriveCheckBlocking({
      type: check.type,
      status: skipped ? "skipped" : status,
      passed: checkPassed,
      errors: normalizedErrors,
      blocking: check.blocking,
    });
    return {
      ...check,
      status: skipped ? ("skipped" as const) : status,
      passed: checkPassed,
      skipped,
      blocking,
      source: defaultCheckSource(check),
      errors: normalizedErrors,
    };
  });
  const active = checks.filter((check) => !check.skipped);
  // 只有 blocking 失败才让整体失败；纯建议性检查（blocking=false）不挡成功。
  const hasBlockingFailure = active.some(
    (check) => check.blocking && !(check.status === "passed" && check.passed),
  );
  const passed = active.length > 0 && !hasBlockingFailure;
  return { ...result, checks, passed, status: verificationStatus(passed, checks) };
}

export function createTaskRunState(taskId: string, maxRepairAttempts = 3): TaskRunState {
  return {
    taskId,
    phase: "planning",
    currentStepId: null,
    verification: { status: "not_run", passed: false, checks: [], summary: "尚未验证", suggestions: [] },
    repairAttempts: 0,
    maxRepairAttempts,
    updatedAt: new Date().toISOString(),
    metrics: createTaskRunMetrics(),
  };
}
export function applyTaskEvent(state: TaskRunState, event: TaskEvent): TaskRunState {
  if (event.taskId !== state.taskId) return state;
  const nowMs = Date.now();
  const updatedAt = new Date(nowMs).toISOString();
  const metrics = state.metrics ?? createTaskRunMetrics(nowMs);
  switch (event.type) {
    case "phase_changed": {
      if (event.phase === state.phase && !event.reason) {
        return { ...state, updatedAt };
      }
      let nextMetrics = event.phase === state.phase
        ? metrics
        : accumulatePhaseDuration(metrics, state.phase, nowMs);
      if (TERMINAL_PHASES.has(event.phase)) {
        nextMetrics = {
          ...nextMetrics,
          terminalReason: event.reason?.trim() || nextMetrics.terminalReason || defaultTerminalReason(event.phase),
        };
      } else if (event.reason?.trim()) {
        // 非终态也可记录原因（例如即将阻塞的提示），但不覆盖已有 terminalReason。
        nextMetrics = {
          ...nextMetrics,
          terminalReason: nextMetrics.terminalReason ?? event.reason.trim(),
        };
      }
      return { ...state, phase: event.phase, metrics: nextMetrics, updatedAt };
    }
    case "verification_completed": {
      const verification = normalizeVerificationResult(event.result);
      const nextPhase: TaskRunPhase = verification.status === "passed" ? "executing" : "repairing";
      let nextMetrics = accumulatePhaseDuration(metrics, state.phase, nowMs);
      if (verification.status !== "passed") {
        const reason =
          verification.summary?.trim() ||
          verification.checks
            .flatMap((c) => c.errors.map((e) => e.message))
            .filter(Boolean)
            .slice(0, 3)
            .join("; ") ||
          `verification ${verification.status}`;
        nextMetrics = {
          ...nextMetrics,
          verificationFailureReasons: pushUniqueReason(nextMetrics.verificationFailureReasons, reason),
        };
      }
      return { ...state, verification, phase: nextPhase, metrics: nextMetrics, updatedAt };
    }
    case "repair_completed": {
      const attempts = Math.max(state.repairAttempts, event.attempt);
      const nextPhase: TaskRunPhase =
        event.resolved ? "executing" : attempts >= state.maxRepairAttempts ? "failed" : "repairing";
      let nextMetrics = accumulatePhaseDuration(metrics, state.phase, nowMs);
      const repairCompletedCount = nextMetrics.repairCompletedCount + 1;
      const repairResolvedCount = nextMetrics.repairResolvedCount + (event.resolved ? 1 : 0);
      nextMetrics = {
        ...nextMetrics,
        repairCompletedCount,
        repairResolvedCount,
        repairSuccessRate: repairSuccessRateOf(repairResolvedCount, repairCompletedCount),
      };
      if (nextPhase === "failed" && !nextMetrics.terminalReason) {
        nextMetrics = {
          ...nextMetrics,
          terminalReason: `自动修复耗尽（${attempts}/${state.maxRepairAttempts}）`,
        };
      }
      return {
        ...state,
        repairAttempts: attempts,
        phase: nextPhase,
        metrics: nextMetrics,
        updatedAt,
      };
    }
    case "tool_completed": {
      const by = event.count && event.count > 0 ? Math.floor(event.count) : 1;
      return {
        ...state,
        metrics: {
          ...metrics,
          toolCallCount: metrics.toolCallCount + by,
        },
        updatedAt,
      };
    }
    case "observability": {
      const modelSamples = nonNegInt(event.modelSamples);
      const toolCalls = nonNegInt(event.toolCalls);
      const retries = nonNegInt(event.retries);
      const contextCompressions = nonNegInt(event.contextCompressions);
      const terminalReason =
        typeof event.terminalReason === "string" && event.terminalReason.trim()
          ? event.terminalReason.trim()
          : metrics.terminalReason;
      return {
        ...state,
        metrics: {
          ...metrics,
          modelSampleCount: metrics.modelSampleCount + modelSamples,
          toolCallCount: metrics.toolCallCount + toolCalls,
          retryCount: metrics.retryCount + retries,
          contextCompressionCount: metrics.contextCompressionCount + contextCompressions,
          terminalReason,
        },
        updatedAt,
      };
    }
  }
}

/** 供 UI / 事件快照使用的精简 metrics 视图。 */
export function taskRunMetricsSnapshot(metrics: TaskRunMetrics): TaskRunMetrics {
  return {
    startedAt: metrics.startedAt,
    phaseStartedAtMs: metrics.phaseStartedAtMs,
    phaseDurationsMs: { ...metrics.phaseDurationsMs },
    modelSampleCount: metrics.modelSampleCount,
    toolCallCount: metrics.toolCallCount,
    retryCount: metrics.retryCount,
    contextCompressionCount: metrics.contextCompressionCount,
    verificationFailureReasons: [...metrics.verificationFailureReasons],
    repairCompletedCount: metrics.repairCompletedCount,
    repairResolvedCount: metrics.repairResolvedCount,
    repairSuccessRate: metrics.repairSuccessRate,
    terminalReason: metrics.terminalReason,
  };
}

/** 总耗时（各阶段累计 + 当前阶段尚未封账的时间）。 */
export function taskRunTotalDurationMs(metrics: TaskRunMetrics, nowMs = Date.now()): number {
  const sealed = Object.values(metrics.phaseDurationsMs).reduce((sum, ms) => sum + (ms ?? 0), 0);
  const current = Math.max(0, nowMs - metrics.phaseStartedAtMs);
  return sealed + current;
}
export function canReportSuccess(state: TaskRunState): boolean {
  return state.phase === "completed" && state.verification.status === "passed" && state.verification.passed && state.verification.checks.length > 0;
}

/**
 * 最终成功门禁：在宣称成功前将 phase 收口为 completed，并在需要验证时强制 canReportSuccess。
 * - 无文件改动且从未跑过验证/修复：允许软成功（phase=completed, verification 仍可为 not_run）
 * - 一旦有验证/修复/文件改动：必须 canReportSuccess，否则 phase=failed 并返回拒绝原因
 */
export function sealTaskRunSuccess(
  state: TaskRunState,
  opts?: { requiresVerification?: boolean },
): { state: TaskRunState; ok: boolean; reason?: string } {
  const requiresVerification =
    opts?.requiresVerification === true ||
    state.repairAttempts > 0 ||
    state.verification.status !== "not_run" ||
    state.phase === "verifying" ||
    state.phase === "repairing" ||
    state.phase === "failed";

  if (!requiresVerification) {
    const completed = applyTaskEvent(state, {
      type: "phase_changed",
      taskId: state.taskId,
      phase: "completed",
      reason: "completed",
    });
    return { state: completed, ok: true };
  }

  const verified =
    state.verification.status === "passed" &&
    state.verification.passed &&
    state.verification.checks.length > 0;

  if (verified) {
    const completed = applyTaskEvent(state, {
      type: "phase_changed",
      taskId: state.taskId,
      phase: "completed",
      reason: "completed",
    });
    if (canReportSuccess(completed)) return { state: completed, ok: true };
  }

  const reason =
    `无法报告成功：验证门禁未通过（phase=${state.phase}, verification=${state.verification.status}, ` +
    `checks=${state.verification.checks.length}, repairAttempts=${state.repairAttempts}/${state.maxRepairAttempts}）`;
  const failed = applyTaskEvent(state, {
    type: "phase_changed",
    taskId: state.taskId,
    phase: "failed",
    reason,
  });
  return {
    state: failed,
    ok: false,
    reason,
  };
}

/** UI / live-status 文案：把 phase 映射为简短中文状态。 */
export function taskRunPhaseLabel(phase: TaskRunPhase): string {
  switch (phase) {
    case "planning":
      return "规划中…";
    case "executing":
      return "执行中…";
    case "verifying":
      return "验证中…";
    case "repairing":
      return "自动修复中…";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "blocked":
      return "已阻塞";
    case "interrupted":
      return "已中断";
  }
}

/** 从验证结果里抽出失败文件，生成正文区短提示（不走顶部错误条）。 */
export function formatVerificationFailureNotice(state: TaskRunState): string {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const check of state.verification.checks) {
    if (check.passed && check.status === "passed") continue;
    for (const err of check.errors) {
      const file = err.file?.trim();
      if (file && !seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  if (files.length > 0) {
    return files.map((file) => `${file} 验证失败`).join("\n");
  }
  const failedNames = state.verification.checks
    .filter((check) => !check.passed || check.status === "failed")
    .map((check) => check.name.trim())
    .filter(Boolean);
  if (failedNames.length > 0) {
    return failedNames.map((name) => `${name} 验证失败`).join("\n");
  }
  return "验证失败";
}

/**
 * ReAct 最终成功路径的纯函数门禁（供 runReActLoop.finalizeSuccess 与单测共用）。
 * - 无 taskRunState / 已 aborted / blocked / handoff / 等待确认：原样返回
 * - seal 失败：phase=failed，blocked+successRejected；只把短提示写入 lastAssistant，不发 warning
 * - seal 成功：返回更新后的 taskRunState，不改写业务结果
 */
export function finalizeTaskSuccess<T extends {
  lastAssistant: string;
  aborted: boolean;
  blocked?: boolean;
  blockedReason?: string;
  handoffRequested?: boolean;
  awaitingUserConfirmation?: boolean;
  correctionCount: number;
}>(args: {
  taskRunState: TaskRunState | null;
  result: T;
  requiresVerification?: boolean;
}): {
  taskRunState: TaskRunState | null;
  result: T & { successRejected?: boolean; blocked?: boolean; blockedReason?: string };
  warning?: string;
} {
  const { taskRunState, result, requiresVerification } = args;
  if (
    !taskRunState ||
    result.aborted ||
    result.blocked ||
    result.handoffRequested ||
    result.awaitingUserConfirmation
  ) {
    return { taskRunState, result };
  }

  const sealed = sealTaskRunSuccess(taskRunState, { requiresVerification });
  if (!sealed.ok) {
    const reason = sealed.reason ?? "成功门禁未通过";
    const notice = formatVerificationFailureNotice(sealed.state);
    const lastAssistant = result.lastAssistant?.trim()
      ? `${result.lastAssistant}\n\n${notice}`
      : notice;
    return {
      taskRunState: sealed.state,
      result: {
        ...result,
        lastAssistant,
        aborted: false,
        blocked: true,
        blockedReason: reason,
        successRejected: true,
      },
    };
  }

  return { taskRunState: sealed.state, result };
}
