import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VerificationResult } from "./verification.ts";

const verifyMock = vi.fn();

vi.mock("./verification.ts", () => ({
  VerificationEngine: class {
    async verify(files: string[]) {
      return verifyMock(files);
    }
  },
}));

import {
  FILE_MODIFYING_TOOLS,
  autoFixAfterTools,
  createAutoFixState,
  getDirtyFiles,
} from "./auto-fix.ts";

function failedResult(summary = "typecheck failed"): VerificationResult {
  return {
    passed: false,
    status: "failed",
    summary,
    suggestions: ["fix types"],
    checks: [
      {
        name: "typecheck",
        type: "typecheck",
        status: "failed",
        passed: false,
        output: "error",
        duration: 1,
        errors: [{ message: "TS2322", severity: "error", file: "src/a.ts" }],
      },
    ],
  };
}

describe("FILE_MODIFYING_TOOLS / getDirtyFiles", () => {
  it("includes append_file and excludes semantic_diff", () => {
    expect(FILE_MODIFYING_TOOLS.has("append_file")).toBe(true);
    expect(FILE_MODIFYING_TOOLS.has("write_file")).toBe(true);
    expect(FILE_MODIFYING_TOOLS.has("apply_patch")).toBe(true);
    expect(FILE_MODIFYING_TOOLS.has("replace_in_file")).toBe(true);
    expect(FILE_MODIFYING_TOOLS.has("semantic_diff")).toBe(false);
  });

  it("collects dirty paths from append_file and ignores semantic_diff", () => {
    expect(
      getDirtyFiles([
        { name: "append_file", arguments: { file_path: "src/big.ts" } },
        { name: "semantic_diff", arguments: { filePath: "src/big.ts" } },
        { name: "write_file", arguments: { file_path: "src/a.ts" } },
        { name: "read_file", arguments: { file_path: "src/b.ts" } },
      ]),
    ).toEqual(["src/big.ts", "src/a.ts"]);
  });
});

describe("autoFixAfterTools", () => {
  beforeEach(() => {
    verifyMock.mockReset();
  });

  it("treats verification exceptions as retryable instead of exhausted", async () => {
    verifyMock.mockRejectedValueOnce(new Error("spawn EPERM"));
    const state = createAutoFixState();

    const result = await autoFixAfterTools("/tmp/ws", ["src/a.ts"], state, {
      maxAttempts: 3,
    });

    expect(result.exhausted).toBe(false);
    expect(result.resolved).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.injectedMessages).toHaveLength(1);
    expect(result.injectedMessages[0]?.content).toContain("验证执行失败: spawn EPERM");
    expect(state.hasUnresolvedErrors).toBe(true);
  });

  it("marks exhausted without injectedMessages when max attempts are reached", async () => {
    verifyMock.mockResolvedValue(failedResult("still broken"));
    const state = createAutoFixState();
    state.fixAttempts = 2;

    const result = await autoFixAfterTools("/tmp/ws", ["src/a.ts"], state, {
      maxAttempts: 3,
    });

    expect(result.exhausted).toBe(true);
    expect(result.resolved).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.injectedMessages).toEqual([]);
    expect(result.summary).toContain("typecheck");
  });

  it("does not inject a chat bubble for advisory semantic_diff warnings", async () => {
    verifyMock.mockResolvedValue({
      passed: true,
      status: "passed",
      summary: "✅ 所有验证通过\n\n✅ semantic_diff: 通过 (1ms)\n   warning: foo.ts: 移除了导出: export function foo",
      suggestions: [],
      checks: [
        {
          name: "semantic_diff",
          type: "semantic_diff",
          status: "passed",
          passed: true,
          output: "",
          duration: 1,
          blocking: false,
          errors: [{ message: "foo.ts: 移除了导出: export function foo", severity: "warning" }],
        },
      ],
    } satisfies VerificationResult);
    const state = createAutoFixState();

    const result = await autoFixAfterTools("/tmp/ws", ["src/a.ts"], state, {
      maxAttempts: 3,
    });

    expect(result.resolved).toBe(true);
    expect(result.exhausted).toBe(false);
    expect(result.injectedMessages).toEqual([]);
    expect(result.summary).toContain("移除了导出");
  });

  it("still injects hard typecheck failures for the model to fix", async () => {
    verifyMock.mockResolvedValue(failedResult("typecheck failed"));
    const state = createAutoFixState();

    const result = await autoFixAfterTools("/tmp/ws", ["src/a.ts"], state, {
      maxAttempts: 3,
    });

    expect(result.resolved).toBe(false);
    expect(result.exhausted).toBe(false);
    expect(result.injectedMessages).toHaveLength(1);
    expect(result.injectedMessages[0]?.content).toContain("验证失败");
  });

  it("exhausts on repeated verification exceptions at the attempt limit", async () => {
    verifyMock.mockRejectedValue(new Error("timeout"));
    const state = createAutoFixState();
    state.fixAttempts = 2;

    const result = await autoFixAfterTools("/tmp/ws", ["src/a.ts"], state, {
      maxAttempts: 3,
    });

    expect(result.exhausted).toBe(true);
    expect(result.injectedMessages).toEqual([]);
    expect(result.summary).toContain("验证执行失败: timeout");
  });
});
