import { beforeEach, describe, expect, it } from "vitest";
import { applyChatEvent, toolStatusLabel } from "./apply-chat-event";
import { useChatStore } from "../store/chat-store";
import { useSessionStore } from "../store/session-store";
import type { ChatEventDto } from "../../../preload/index";

function resetChat(sessionId = "s1") {
  useChatStore.setState({
    activeSessionId: sessionId,
    bySession: {},
    history: [],
    historyBeforeSeq: null,
    historyHasMore: false,
    historyLoading: false,
    sending: false,
    queuedMessages: [],
    liveEvents: [],
    terminal: [],
    liveStatus: "",
    errorAlert: null,
    taskRun: null,
    dangerousConfirmations: [],
    askRequests: [],
    status: "idle",
  });
}

function apply(ev: ChatEventDto, sessionId: string | null = "s1") {
  applyChatEvent(useChatStore.getState(), useSessionStore.getState(), sessionId, ev);
}

describe("applyChatEvent task_run_state", () => {
  beforeEach(() => resetChat());

  it("mirrors task_run_state into taskRun + liveStatus", () => {
    apply({
      type: "task_run_state",
      sessionId: "s1",
      phase: "repairing",
      taskId: "s1",
      verificationStatus: "failed",
      verificationPassed: false,
      verificationSummary: "typecheck failed",
      repairAttempts: 1,
      maxRepairAttempts: 3,
      label: "自动修复中…",
      totalDurationMs: 1200,
      metrics: {
        startedAt: "2020-01-01T00:00:00.000Z",
        phaseStartedAtMs: 1,
        phaseDurationsMs: { executing: 800 },
        modelSampleCount: 3,
        toolCallCount: 5,
        retryCount: 1,
        contextCompressionCount: 0,
        verificationFailureReasons: ["typecheck failed"],
        repairCompletedCount: 1,
        repairResolvedCount: 0,
        repairSuccessRate: 0,
        terminalReason: null,
      },
    });

    const next = useChatStore.getState();
    expect(next.liveStatus).toBe("自动修复中…");
    expect(next.taskRun).toMatchObject({
      phase: "repairing",
      taskId: "s1",
      verificationStatus: "failed",
      repairAttempts: 1,
      label: "自动修复中…",
      totalDurationMs: 1200,
      metrics: {
        modelSampleCount: 3,
        toolCallCount: 5,
        retryCount: 1,
        verificationFailureReasons: ["typecheck failed"],
      },
    });
  });

  it("updates phase snapshot on successive task_run_state events", () => {
    apply({
      type: "task_run_state",
      sessionId: "s1",
      phase: "executing",
      taskId: "s1",
      verificationStatus: "not_run",
      verificationPassed: false,
      verificationSummary: "尚未验证",
      repairAttempts: 0,
      maxRepairAttempts: 3,
      label: "执行中…",
    });
    apply({
      type: "task_run_state",
      sessionId: "s1",
      phase: "failed",
      taskId: "s1",
      verificationStatus: "failed",
      verificationPassed: false,
      verificationSummary: "gate",
      repairAttempts: 2,
      maxRepairAttempts: 2,
      label: "失败",
    });

    const next = useChatStore.getState();
    expect(next.taskRun?.phase).toBe("failed");
    expect(next.liveStatus).toBe("失败");
  });
});

describe("applyChatEvent streaming / turn_complete", () => {
  beforeEach(() => resetChat());

  it("atomically upserts thinking and seals before text", () => {
    apply({ type: "thinking_delta", sessionId: "s1", text: "想…" });
    apply({ type: "thinking_delta", sessionId: "s1", text: "想一下" });
    apply({ type: "assistant_delta", sessionId: "s1", text: "你好" });

    const events = useChatStore.getState().liveEvents;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "thinking", text: "想一下", streaming: false });
    expect(events[1]).toMatchObject({ kind: "text", text: "你好", streaming: true });
  });

  it("suppresses deltas while decomposing", () => {
    apply({
      type: "stage_start",
      sessionId: "s1",
      id: "d1",
      nodeType: "task_decompose",
      label: "分解",
    });
    apply({ type: "thinking_delta", sessionId: "s1", text: "secret" });
    apply({ type: "assistant_delta", sessionId: "s1", text: "leak" });

    const next = useChatStore.getState();
    expect(next.liveStatus).toBe("正在分解任务…");
    expect(next.liveEvents).toEqual([]);
  });

  it("suppresses verification-gate warnings from the top error banner", () => {
    apply({
      type: "warning",
      sessionId: "s1",
      message: "无法报告成功：验证门禁未通过（phase=failed, verification=failed）",
    });
    expect(useChatStore.getState().errorAlert).toBeNull();

    apply({
      type: "warning",
      sessionId: "s1",
      message: "自动修复达到上限（3 次）：### semantic_diff (semantic_diff) ⚠️ packages/core/src/harness/loop/context.ts: 移除了导出: export function isMeaningfulRepoMap",
    });
    expect(useChatStore.getState().errorAlert).toBeNull();

    apply({
      type: "warning",
      sessionId: "s1",
      message: "自动修复达到上限（3 次）：### semantic_diff (semantic_diff) ⚠️ packages/core/src/harness/loop/context.ts: 移除了导出: export function isMeaningfulRepoMap",
    });
    expect(useChatStore.getState().errorAlert).toBeNull();

    apply({ type: "warning", sessionId: "s1", text: "其他警告" } as ChatEventDto);
    apply({ type: "warning", sessionId: "s1", message: "其他警告" });
    expect(useChatStore.getState().errorAlert?.message).toBe("其他警告");
  });

  it("suppresses verification-gate errors from the top error banner", () => {
    apply({
      type: "error",
      sessionId: "s1",
      message: "无法报告成功：验证门禁未通过（phase=failed, verification=failed）",
    });
    expect(useChatStore.getState().errorAlert).toBeNull();
    expect(useChatStore.getState().liveStatus).toBe("");
  });

  it("suppresses JSON-serialized verification-gate errors from the top error banner", () => {
    apply({
      type: "error",
      sessionId: "s1",
      message: JSON.stringify({
        code: "UNKNOWN",
        message: "无法报告成功：验证门禁未通过（phase=failed, verification=failed, checks=2, repairAttempts=3/3）",
      }),
    });
    expect(useChatStore.getState().errorAlert).toBeNull();
  });

  it("shows verification failure only in the LLM body, not the error banner", () => {
    apply({
      type: "assistant_delta",
      sessionId: "s1",
      text: "src/foo.ts 验证失败",
    });
    const next = useChatStore.getState();
    expect(next.errorAlert).toBeNull();
    expect(next.liveEvents).toEqual([
      expect.objectContaining({ kind: "text", text: "src/foo.ts 验证失败", streaming: true }),
    ]);
  });

  it("turn_complete keeps structured/decompose and clears sending", () => {
    apply({ type: "thinking_delta", sessionId: "s1", text: "t" });
    apply({ type: "assistant_delta", sessionId: "s1", text: "a" });
    useChatStore.getState().setSending(true, "s1");

    apply({
      type: "turn_complete",
      sessionId: "s1",
      parts: [{ type: "text", text: "done" }],
      metadata: {},
    });

    const next = useChatStore.getState();
    expect(next.sending).toBe(false);
    expect(next.liveEvents.every((e) => e.kind === "structured" || e.kind === "decompose")).toBe(true);
    expect(next.liveEvents.some((e) => e.kind === "structured")).toBe(true);
  });
});

/**
 * Closest-to-E2E path available without Electron Playwright:
 * simulate agent file edit → verification failure → UI taskRun/liveStatus
 * (failed / repairing) via the same applyChatEvent entry the hook uses.
 */
describe("E2E-ish: agent edit → verification fail → UI failed/repairing", () => {
  beforeEach(() => {
    resetChat("s-e2e");
    useChatStore.getState().setSending(true, "s-e2e");
  });

  it("surfaces repairing after file-modifying tool + failed verification", () => {
    const sid = "s-e2e";

    // Agent starts executing
    apply(
      {
        type: "task_run_state",
        sessionId: sid,
        phase: "executing",
        taskId: sid,
        verificationStatus: "not_run",
        verificationPassed: false,
        verificationSummary: "尚未验证",
        repairAttempts: 0,
        maxRepairAttempts: 3,
        label: "执行中…",
      },
      sid,
    );

    // Real agent edits a file
    apply(
      {
        type: "tool_start",
        sessionId: sid,
        id: "tool-1",
        name: "apply_patch",
        args: { path: "src/foo.ts" },
      },
      sid,
    );
    expect(useChatStore.getState().liveStatus).toBe(
      toolStatusLabel("running", "apply_patch", { path: "src/foo.ts" }),
    );

    apply(
      {
        type: "tool_end",
        sessionId: sid,
        id: "tool-1",
        name: "apply_patch",
        ok: true,
        output: "patched",
      },
      sid,
    );

    // Post-edit verification
    apply(
      {
        type: "task_run_state",
        sessionId: sid,
        phase: "verifying",
        taskId: sid,
        verificationStatus: "not_run",
        verificationPassed: false,
        verificationSummary: "运行验证…",
        repairAttempts: 0,
        maxRepairAttempts: 3,
        label: "验证中…",
      },
      sid,
    );
    expect(useChatStore.getState().taskRun?.phase).toBe("verifying");
    expect(useChatStore.getState().liveStatus).toBe("验证中…");

    // Verification failed → auto-repair
    apply(
      {
        type: "task_run_state",
        sessionId: sid,
        phase: "repairing",
        taskId: sid,
        verificationStatus: "failed",
        verificationPassed: false,
        verificationSummary: "typecheck failed: Cannot find name 'x'",
        repairAttempts: 1,
        maxRepairAttempts: 3,
        label: "自动修复中…",
      },
      sid,
    );

    let ui = useChatStore.getState();
    expect(ui.taskRun).toMatchObject({
      phase: "repairing",
      verificationStatus: "failed",
      verificationPassed: false,
      verificationSummary: "typecheck failed: Cannot find name 'x'",
      repairAttempts: 1,
      label: "自动修复中…",
    });
    expect(ui.liveStatus).toBe("自动修复中…");
    // File-modifying tool still visible in the live stream
    expect(ui.liveEvents.some((e) => e.kind === "tool" && e.tool.name === "apply_patch")).toBe(true);

    // Exhausted repairs → failed (UI must show 失败)
    apply(
      {
        type: "task_run_state",
        sessionId: sid,
        phase: "failed",
        taskId: sid,
        verificationStatus: "failed",
        verificationPassed: false,
        verificationSummary: "typecheck failed: Cannot find name 'x'",
        repairAttempts: 3,
        maxRepairAttempts: 3,
        label: "失败",
      },
      sid,
    );

    ui = useChatStore.getState();
    expect(ui.taskRun?.phase).toBe("failed");
    expect(ui.liveStatus).toBe("失败");
    expect(ui.taskRun?.verificationStatus).toBe("failed");
  });
});
