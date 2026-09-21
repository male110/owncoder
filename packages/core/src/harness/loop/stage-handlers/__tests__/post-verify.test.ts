import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@owncoder/llm";
import {
  createTaskRunState,
  normalizeVerificationResult,
  type VerificationResult,
} from "../../../../task-run.ts";
import type { AgentLoopOpts } from "../../types.ts";
import type { ToolContext } from "../../../execute.ts";
import type { MemoryManager } from "../../../memory.ts";
import type { Tracer } from "../../../observability.ts";

const verifyMock = vi.fn();

vi.mock("../../../verification.ts", () => ({
  VerificationEngine: class {
    async verify(files: string[]) {
      return verifyMock(files);
    }
  },
}));

import { runPostVerify, sealPostVerifyFailure } from "../verify.ts";

function failedResult(summary = "typecheck failed"): VerificationResult {
  return normalizeVerificationResult({
    status: "failed",
    passed: false,
    checks: [{
      name: "typecheck",
      type: "typecheck",
      status: "failed",
      passed: false,
      output: "error",
      duration: 1,
      errors: [{ message: "TS2322", severity: "error", file: "src/a.ts" }],
    }],
    summary,
    suggestions: ["fix types"],
  });
}

function passedResult(): VerificationResult {
  return normalizeVerificationResult({
    status: "passed",
    passed: true,
    checks: [{
      name: "typecheck",
      type: "typecheck",
      status: "passed",
      passed: true,
      output: "ok",
      duration: 1,
      errors: [],
    }],
    summary: "ok",
    suggestions: [],
  });
}

function makeOpts(partial?: Partial<AgentLoopOpts>): AgentLoopOpts {
  return {
    workspaceRoot: process.cwd(),
    mode: "agent",
    userMessage: "test",
    history: [],
    enableVerification: true,
    onEvent: vi.fn(),
    ...partial,
  } as AgentLoopOpts;
}

function makeToolCtx(touched: string[] = ["src/a.ts"]): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    touchedPaths: touched,
  } as ToolContext;
}

function makeMemory(): MemoryManager {
  return {
    addError: vi.fn(),
  } as unknown as MemoryManager;
}

function makeTracer(): Tracer {
  return {
    startSpan: vi.fn(() => "span-1"),
    endSpan: vi.fn(),
  } as unknown as Tracer;
}

describe("sealPostVerifyFailure", () => {
  it("将 post_verify 硬失败收口为 failed + successRejected/blocked，并写入 terminalReason", () => {
    const state = {
      taskRunState: createTaskRunState("post-verify-1"),
      postVerifyFailed: false,
      successRejected: false,
      blocked: false,
      blockedReason: undefined as string | undefined,
      lastAssistant: "看起来完成了",
    };

    sealPostVerifyFailure(state, failedResult("post_verify 未通过"));

    expect(state.postVerifyFailed).toBe(true);
    expect(state.successRejected).toBe(true);
    expect(state.blocked).toBe(true);
    expect(state.blockedReason).toMatch(/post_verify 未通过/);
    expect(state.taskRunState?.phase).toBe("failed");
    expect(state.taskRunState?.verification.passed).toBe(false);
    expect(state.taskRunState?.metrics.terminalReason).toMatch(/post_verify 未通过/);
    expect(state.lastAssistant).toMatch(/src\/a\.ts 验证失败/);
  });

  it("无 taskRunState 时仍设置门禁标志，禁止成功路径", () => {
    const state = {
      taskRunState: null,
      postVerifyFailed: false,
      successRejected: false,
      blocked: false,
      blockedReason: undefined as string | undefined,
      lastAssistant: "",
    };

    sealPostVerifyFailure(state, failedResult());

    expect(state.postVerifyFailed).toBe(true);
    expect(state.successRejected).toBe(true);
    expect(state.blocked).toBe(true);
    expect(state.taskRunState).toBeNull();
  });
});

describe("runPostVerify → TaskRunState / 成功门禁", () => {
  beforeEach(() => {
    verifyMock.mockReset();
  });

  it("硬失败时写入 TaskRunState.failed，并设置 successRejected/blocked/postVerifyFailed", async () => {
    verifyMock.mockResolvedValue(failedResult("post_verify 未通过"));
    const state = {
      taskRunState: createTaskRunState("post-verify-run"),
      postVerifyFailed: false,
      successRejected: false,
      blocked: false,
      blockedReason: undefined as string | undefined,
      lastAssistant: "看起来完成了",
    };
    const messages: ChatMessage[] = [];
    const memory = makeMemory();
    const tracer = makeTracer();
    const opts = makeOpts();

    await runPostVerify(opts, makeToolCtx(), messages, memory, tracer, state);

    expect(state.postVerifyFailed).toBe(true);
    expect(state.successRejected).toBe(true);
    expect(state.blocked).toBe(true);
    expect(state.taskRunState?.phase).toBe("failed");
    expect(state.taskRunState?.verification.status).toBe("failed");
    expect(state.taskRunState?.metrics.terminalReason).toMatch(/post_verify 未通过/);
    expect(state.lastAssistant).toMatch(/src\/a\.ts 验证失败/);
    expect(messages.some((m) => String(m.content).includes("Final Verification Report"))).toBe(true);
    expect(memory.addError).toHaveBeenCalled();
    expect(opts.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "verification_result", passed: false }),
    );
  });

  it("通过时写入 verification_completed，不设置失败门禁", async () => {
    verifyMock.mockResolvedValue(passedResult());
    const state = {
      taskRunState: createTaskRunState("post-verify-ok"),
      postVerifyFailed: false,
      successRejected: false,
      blocked: false,
      blockedReason: undefined as string | undefined,
      lastAssistant: "done",
    };

    await runPostVerify(makeOpts(), makeToolCtx(), [], makeMemory(), makeTracer(), state);

    expect(state.postVerifyFailed).toBeFalsy();
    expect(state.successRejected).toBeFalsy();
    expect(state.blocked).toBeFalsy();
    expect(state.taskRunState?.phase).not.toBe("failed");
    expect(state.taskRunState?.verification.passed).toBe(true);
    expect(state.taskRunState?.verification.status).toBe("passed");
  });

  it("verify 抛错时同样收口为 failed + successRejected", async () => {
    verifyMock.mockRejectedValue(new Error("engine boom"));
    const state = {
      taskRunState: createTaskRunState("post-verify-throw"),
      postVerifyFailed: false,
      successRejected: false,
      blocked: false,
      blockedReason: undefined as string | undefined,
      lastAssistant: "",
    };

    await runPostVerify(makeOpts(), makeToolCtx(), [], makeMemory(), makeTracer(), state);

    expect(state.postVerifyFailed).toBe(true);
    expect(state.successRejected).toBe(true);
    expect(state.blocked).toBe(true);
    expect(state.taskRunState?.phase).toBe("failed");
    expect(state.blockedReason).toMatch(/engine boom/);
    expect(state.taskRunState?.verification.checks[0]?.source).toBe("post_verify");
    expect(state.taskRunState?.verification.checks[0]?.blocking).toBe(true);
  });
});

describe("normalizeVerificationResult contract fields", () => {
  it("补齐 blocking/skipped/source，且 skipped 不阻断成功", () => {
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
          status: "passed",
          passed: true,
          output: "",
          duration: 1,
          errors: [{ message: "移除了导出: foo", severity: "warning" }],
        },
      ],
      summary: "mixed",
      suggestions: [],
    });

    expect(normalized.checks[0]?.skipped).toBe(true);
    expect(normalized.checks[0]?.blocking).toBe(false);
    expect(normalized.checks[0]?.source).toBe("typecheck");
    expect(normalized.checks[1]?.blocking).toBe(false);
    expect(normalized.checks[1]?.source).toBe("semantic_diff");
    expect(normalized.passed).toBe(true);
    expect(normalized.status).toBe("passed");
  });

  it("硬失败 check 保持 blocking=true 且整体失败", () => {
    const normalized = normalizeVerificationResult(failedResult());
    expect(normalized.checks[0]?.blocking).toBe(true);
    expect(normalized.checks[0]?.skipped).toBe(false);
    expect(normalized.passed).toBe(false);
    expect(normalized.status).toBe("failed");
  });
});
