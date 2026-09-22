import { describe, expect, it } from "vitest";
import {
  applyTaskEvent,
  canReportSuccess,
  createTaskRunState,
  finalizeTaskSuccess,
  formatVerificationFailureNotice,
  normalizeVerificationResult,
  restoreTaskRunState,
  sealTaskRunSuccess,
  taskRunPhaseLabel,
  taskRunTotalDurationMs,
  verificationStatus,
  type VerificationCheck,
  type VerificationResult,
} from "./task-run.ts";

function passedCheck(name = "typecheck"): VerificationCheck {
  return {
    name,
    type: "typecheck",
    status: "passed",
    passed: true,
    output: "ok",
    duration: 1,
    errors: [],
  };
}

function failedCheck(name = "typecheck", file?: string): VerificationCheck {
  return {
    name,
    type: "typecheck",
    status: "failed",
    passed: false,
    output: "error",
    duration: 1,
    errors: [{ message: "boom", severity: "error", ...(file ? { file } : {}) }],
  };
}

function passedResult(checks: VerificationCheck[] = [passedCheck()]): VerificationResult {
  return normalizeVerificationResult({
    status: "passed",
    passed: true,
    checks,
    summary: "ok",
    suggestions: [],
  });
}

describe("task-run success gate", () => {
  it("canReportSuccess 仅在 completed + 验证通过且有 checks 时为 true", () => {
    const base = createTaskRunState("t1");
    expect(canReportSuccess(base)).toBe(false);

    const verified = applyTaskEvent(base, {
      type: "verification_completed",
      taskId: "t1",
      result: passedResult(),
    });
    expect(verified.phase).toBe("executing");
    expect(canReportSuccess(verified)).toBe(false);

    const completed = applyTaskEvent(verified, {
      type: "phase_changed",
      taskId: "t1",
      phase: "completed",
    });
    expect(canReportSuccess(completed)).toBe(true);
  });

  it("sealTaskRunSuccess：无验证需求时允许软成功", () => {
    const state = createTaskRunState("t-soft");
    const sealed = sealTaskRunSuccess(state);
    expect(sealed.ok).toBe(true);
    expect(sealed.state.phase).toBe("completed");
    expect(sealed.state.verification.status).toBe("not_run");
    // 软成功不要求 canReportSuccess（无 checks）
    expect(canReportSuccess(sealed.state)).toBe(false);
  });

  it("sealTaskRunSuccess：有文件改动/验证时必须 canReportSuccess", () => {
    let state = createTaskRunState("t-hard");
    state = applyTaskEvent(state, {
      type: "verification_completed",
      taskId: "t-hard",
      result: {
        status: "failed",
        passed: false,
        checks: [failedCheck()],
        summary: "fail",
        suggestions: [],
      },
    });
    const rejected = sealTaskRunSuccess(state, { requiresVerification: true });
    expect(rejected.ok).toBe(false);
    expect(rejected.state.phase).toBe("failed");
    expect(rejected.reason).toMatch(/验证门禁未通过/);

    let okState = createTaskRunState("t-hard-ok");
    okState = applyTaskEvent(okState, {
      type: "verification_completed",
      taskId: "t-hard-ok",
      result: passedResult(),
    });
    const accepted = sealTaskRunSuccess(okState, { requiresVerification: true });
    expect(accepted.ok).toBe(true);
    expect(accepted.state.phase).toBe("completed");
    expect(canReportSuccess(accepted.state)).toBe(true);
  });

  it("repair 耗尽后 phase=failed，无法报告成功", () => {
    let state = createTaskRunState("t-repair", 2);
    state = applyTaskEvent(state, {
      type: "verification_completed",
      taskId: "t-repair",
      result: {
        status: "failed",
        passed: false,
        checks: [failedCheck()],
        summary: "fail",
        suggestions: [],
      },
    });
    state = applyTaskEvent(state, {
      type: "repair_completed",
      taskId: "t-repair",
      attempt: 2,
      resolved: false,
    });
    expect(state.phase).toBe("failed");
    expect(state.repairAttempts).toBe(2);
    const sealed = sealTaskRunSuccess(state);
    expect(sealed.ok).toBe(false);
    expect(sealed.state.phase).toBe("failed");
  });

  it("恢复旧版缺失 status 的 check 时依据 passed 推导状态", () => {
    const normalized = normalizeVerificationResult({
      status: "failed",
      passed: false,
      checks: [{ ...passedCheck("legacy"), status: undefined as never }],
      summary: "legacy",
      suggestions: [],
    });
    expect(normalized.checks[0].status).toBe("passed");
    expect(normalized.checks[0].passed).toBe(true);
    expect(normalized.checks[0].blocking).toBe(false);
    expect(normalized.checks[0].skipped).toBe(false);
    expect(normalized.checks[0].source).toBe("legacy");
    expect(normalized.status).toBe("passed");
    expect(normalized.passed).toBe(true);
  });

  it("normalize 会补齐 blocking/skipped/source，且仅 blocking 失败才整体失败", () => {
    const normalized = normalizeVerificationResult({
      status: "failed",
      passed: false,
      checks: [
        {
          name: "typecheck",
          type: "typecheck",
          status: "skipped",
          passed: false,
          output: "",
          duration: 0,
          errors: [],
        },
        {
          name: "semantic_diff",
          type: "semantic_diff",
          status: "failed",
          passed: false,
          output: "",
          duration: 1,
          errors: [{ message: "移除了导出: foo", severity: "warning" }],
        },
      ],
      summary: "advisory only",
      suggestions: [],
    });
    expect(normalized.checks[0]?.skipped).toBe(true);
    expect(normalized.checks[0]?.blocking).toBe(false);
    expect(normalized.checks[1]?.blocking).toBe(false);
    expect(normalized.checks[1]?.source).toBe("semantic_diff");
    expect(normalized.passed).toBe(true);
    expect(normalized.status).toBe("passed");
  });

  it("lsp error 级诊断阻断整体验证并进入 auto-fix", () => {
    const normalized = normalizeVerificationResult({
      status: "failed",
      passed: false,
      checks: [
        {
          name: "lsp",
          type: "lsp",
          status: "failed",
          passed: false,
          output: "a.ts:1:1 error: Cannot find name 'foo'",
          duration: 5,
          errors: [{ file: "a.ts", line: 1, message: "Cannot find name 'foo'", severity: "error" }],
        },
      ],
      summary: "lsp error blocks",
      suggestions: [],
    });
    expect(normalized.checks[0]?.blocking).toBe(true);
    expect(normalized.checks[0]?.source).toBe("lsp");
    expect(normalized.passed).toBe(false);
    expect(normalized.status).toBe("failed");
  });

  it("lsp warning 不阻断整体验证（仅建议性汇报）", () => {
    const normalized = normalizeVerificationResult({
      status: "passed",
      passed: true,
      checks: [
        {
          name: "lsp",
          type: "lsp",
          status: "passed",
          passed: true,
          output: "a.ts:1:1 warning: unused variable",
          duration: 5,
          errors: [{ file: "a.ts", line: 1, message: "unused variable", severity: "warning" }],
        },
      ],
      summary: "lsp warning advisory",
      suggestions: [],
    });
    expect(normalized.checks[0]?.blocking).toBe(false);
    expect(normalized.checks[0]?.source).toBe("lsp");
    expect(normalized.passed).toBe(true);
    expect(normalized.status).toBe("passed");
  });

  it("空 checks 的 verificationStatus 为 not_run，且 normalize 保持一致", () => {
    expect(verificationStatus(true, [])).toBe("not_run");
    const normalized = normalizeVerificationResult({
      status: "passed",
      passed: true,
      checks: [],
      summary: "empty",
      suggestions: [],
    });
    expect(normalized.status).toBe("not_run");
    expect(normalized.passed).toBe(false);
  });

  it("finalizeTaskSuccess：无验证需求时软成功，不标记 successRejected", () => {
    const state = createTaskRunState("t-final-soft");
    const out = finalizeTaskSuccess({
      taskRunState: state,
      result: { lastAssistant: "done", aborted: false, correctionCount: 0 },
    });
    expect(out.warning).toBeUndefined();
    expect(out.result.successRejected).toBeUndefined();
    expect(out.result.blocked).toBeUndefined();
    expect(out.taskRunState?.phase).toBe("completed");
  });

  it("finalizeTaskSuccess：requiresVerification 且验证失败时拒绝成功", () => {
    let state = createTaskRunState("t-final-reject");
    state = applyTaskEvent(state, {
      type: "verification_completed",
      taskId: "t-final-reject",
      result: {
        status: "failed",
        passed: false,
        checks: [failedCheck()],
        summary: "typecheck failed",
        suggestions: [],
      },
    });
    const out = finalizeTaskSuccess({
      taskRunState: state,
      result: { lastAssistant: "看起来完成了", aborted: false, correctionCount: 1 },
      requiresVerification: true,
    });
    expect(out.warning).toBeUndefined();
    expect(out.result.successRejected).toBe(true);
    expect(out.result.blocked).toBe(true);
    expect(out.result.blockedReason).toMatch(/验证门禁未通过/);
    expect(out.result.lastAssistant).toMatch(/typecheck 验证失败/);
    expect(out.result.lastAssistant).not.toMatch(/无法报告成功/);
    expect(out.taskRunState?.phase).toBe("failed");
  });

  it("formatVerificationFailureNotice：优先文件名，否则用检查名", () => {
    let withFile = createTaskRunState("t-notice-file");
    withFile = applyTaskEvent(withFile, {
      type: "verification_completed",
      taskId: "t-notice-file",
      result: {
        status: "failed",
        passed: false,
        checks: [failedCheck("typecheck", "src/foo.ts")],
        summary: "fail",
        suggestions: [],
      },
    });
    expect(formatVerificationFailureNotice(withFile)).toBe("src/foo.ts 验证失败");

    let withName = createTaskRunState("t-notice-name");
    withName = applyTaskEvent(withName, {
      type: "verification_completed",
      taskId: "t-notice-name",
      result: {
        status: "failed",
        passed: false,
        checks: [failedCheck("lint")],
        summary: "fail",
        suggestions: [],
      },
    });
    expect(formatVerificationFailureNotice(withName)).toBe("lint 验证失败");
  });

  it("finalizeTaskSuccess：aborted/blocked/handoff/awaiting 时跳过门禁", () => {
    const state = createTaskRunState("t-skip");
    for (const result of [
      { lastAssistant: "a", aborted: true, correctionCount: 0 },
      { lastAssistant: "b", aborted: false, blocked: true, blockedReason: "x", correctionCount: 0 },
      { lastAssistant: "c", aborted: false, handoffRequested: true, correctionCount: 0 },
      { lastAssistant: "d", aborted: false, awaitingUserConfirmation: true, correctionCount: 0 },
    ] as const) {
      const out = finalizeTaskSuccess({
        taskRunState: state,
        result,
        requiresVerification: true,
      });
      expect(out.warning).toBeUndefined();
      expect(out.result.successRejected).toBeUndefined();
      expect(out.taskRunState?.phase).toBe("planning");
    }
  });

  it("taskRunPhaseLabel 覆盖全部 phase", () => {
    expect(taskRunPhaseLabel("executing")).toBe("执行中…");
    expect(taskRunPhaseLabel("verifying")).toBe("验证中…");
    expect(taskRunPhaseLabel("repairing")).toBe("自动修复中…");
    expect(taskRunPhaseLabel("failed")).toBe("失败");
    expect(taskRunPhaseLabel("completed")).toBe("已完成");
  });

  it("restoreTaskRunState 兼容旧数据并校验 taskId", () => {
    const raw = {
      taskId: "sess-1",
      phase: "repairing",
      currentStepId: "s1",
      verification: {
        status: "failed",
        passed: false,
        checks: [failedCheck()],
        summary: "x",
        suggestions: [],
      },
      repairAttempts: 1,
      maxRepairAttempts: 3,
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    const restored = restoreTaskRunState(raw, "sess-1");
    expect(restored).toMatchObject({
      taskId: "sess-1",
      phase: "repairing",
      repairAttempts: 1,
    });
    // 旧快照无 metrics 时自动补齐
    expect(restored?.metrics.modelSampleCount).toBe(0);
    expect(restored?.metrics.terminalReason).toBeNull();
    expect(restoreTaskRunState(raw, "other")).toBeNull();
    expect(restoreTaskRunState(null)).toBeNull();
    expect(restoreTaskRunState({ taskId: 1 })).toBeNull();
  });
});

describe("task-run observability metrics", () => {
  it("createTaskRunState 初始化 metrics 为零值", () => {
    const state = createTaskRunState("m1");
    expect(state.metrics.modelSampleCount).toBe(0);
    expect(state.metrics.toolCallCount).toBe(0);
    expect(state.metrics.retryCount).toBe(0);
    expect(state.metrics.contextCompressionCount).toBe(0);
    expect(state.metrics.verificationFailureReasons).toEqual([]);
    expect(state.metrics.repairSuccessRate).toBeNull();
    expect(state.metrics.terminalReason).toBeNull();
    expect(taskRunTotalDurationMs(state.metrics)).toBeGreaterThanOrEqual(0);
  });

  it("observability 事件累加采样/工具/重试/压缩次数", () => {
    let state = createTaskRunState("m2");
    state = applyTaskEvent(state, {
      type: "observability",
      taskId: "m2",
      modelSamples: 2,
      toolCalls: 3,
      retries: 1,
      contextCompressions: 1,
    });
    expect(state.metrics.modelSampleCount).toBe(2);
    expect(state.metrics.toolCallCount).toBe(3);
    expect(state.metrics.retryCount).toBe(1);
    expect(state.metrics.contextCompressionCount).toBe(1);

    state = applyTaskEvent(state, {
      type: "tool_completed",
      taskId: "m2",
      tool: "read_file",
      ok: true,
      count: 4,
    });
    expect(state.metrics.toolCallCount).toBe(7);
  });

  it("verification_completed 失败时记录原因，repair 更新成功率", () => {
    let state = createTaskRunState("m3", 3);
    state = applyTaskEvent(state, {
      type: "verification_completed",
      taskId: "m3",
      result: {
        status: "failed",
        passed: false,
        checks: [failedCheck()],
        summary: "typecheck failed: boom",
        suggestions: [],
      },
    });
    expect(state.metrics.verificationFailureReasons).toContain("typecheck failed: boom");
    expect(state.phase).toBe("repairing");

    state = applyTaskEvent(state, {
      type: "repair_completed",
      taskId: "m3",
      attempt: 1,
      resolved: true,
    });
    expect(state.metrics.repairCompletedCount).toBe(1);
    expect(state.metrics.repairResolvedCount).toBe(1);
    expect(state.metrics.repairSuccessRate).toBe(1);

    state = applyTaskEvent(state, {
      type: "verification_completed",
      taskId: "m3",
      result: {
        status: "failed",
        passed: false,
        checks: [failedCheck("lint")],
        summary: "lint failed",
        suggestions: [],
      },
    });
    state = applyTaskEvent(state, {
      type: "repair_completed",
      taskId: "m3",
      attempt: 2,
      resolved: false,
    });
    expect(state.metrics.repairCompletedCount).toBe(2);
    expect(state.metrics.repairResolvedCount).toBe(1);
    expect(state.metrics.repairSuccessRate).toBe(0.5);
    expect(state.metrics.verificationFailureReasons).toEqual([
      "typecheck failed: boom",
      "lint failed",
    ]);
  });

  it("phase_changed 累计阶段耗时并写入终态原因", () => {
    let state = createTaskRunState("m4");
    const t0 = state.metrics.phaseStartedAtMs;
    state = {
      ...state,
      metrics: { ...state.metrics, phaseStartedAtMs: t0 - 50 },
    };
    state = applyTaskEvent(state, {
      type: "phase_changed",
      taskId: "m4",
      phase: "executing",
    });
    expect(state.metrics.phaseDurationsMs.planning ?? 0).toBeGreaterThanOrEqual(40);

    state = applyTaskEvent(state, {
      type: "phase_changed",
      taskId: "m4",
      phase: "blocked",
      reason: "等待用户确认危险命令",
    });
    expect(state.phase).toBe("blocked");
    expect(state.metrics.terminalReason).toBe("等待用户确认危险命令");
    expect((state.metrics.phaseDurationsMs.executing ?? 0)).toBeGreaterThanOrEqual(0);
  });

  it("sealTaskRunSuccess 失败时把门禁原因写入 terminalReason", () => {
    let state = createTaskRunState("m5");
    state = applyTaskEvent(state, {
      type: "verification_completed",
      taskId: "m5",
      result: {
        status: "failed",
        passed: false,
        checks: [failedCheck()],
        summary: "fail",
        suggestions: [],
      },
    });
    const sealed = sealTaskRunSuccess(state, { requiresVerification: true });
    expect(sealed.ok).toBe(false);
    expect(sealed.state.metrics.terminalReason).toMatch(/验证门禁未通过/);
  });
});
