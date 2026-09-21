import { describe, expect, it } from "vitest";
import { isAdvisoryVerificationResult } from "./auto-fix.ts";
import type { VerificationResult } from "./verification.ts";

function result(partial: Partial<VerificationResult> & Pick<VerificationResult, "checks">): VerificationResult {
  return {
    passed: partial.passed ?? false,
    status: partial.status ?? "failed",
    summary: partial.summary ?? "",
    suggestions: partial.suggestions ?? [],
    checks: partial.checks,
  };
}

describe("isAdvisoryVerificationResult", () => {
  it("treats semantic_diff export-removal warnings as advisory even when marked failed", () => {
    expect(
      isAdvisoryVerificationResult(
        result({
          checks: [
            {
              name: "semantic_diff",
              type: "semantic_diff",
              status: "failed",
              passed: false,
              output: "",
              duration: 1,
              errors: [
                {
                  message: "packages/core/src/harness/loop/context.ts: 移除了导出: export function isMeaningfulRepoMap(text: string): boolean {",
                  severity: "warning",
                },
              ],
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("treats passed semantic_diff with warning errors as advisory", () => {
    expect(
      isAdvisoryVerificationResult(
        result({
          passed: true,
          status: "passed",
          checks: [
            {
              name: "semantic_diff",
              type: "semantic_diff",
              status: "passed",
              passed: true,
              output: "",
              duration: 1,
              errors: [{ message: "foo.ts: 移除了导出: export function foo", severity: "warning" }],
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("does not treat typecheck errors as advisory", () => {
    expect(
      isAdvisoryVerificationResult(
        result({
          checks: [
            {
              name: "tsc",
              type: "typecheck",
              status: "failed",
              passed: false,
              output: "",
              duration: 1,
              errors: [{ message: "TS2322", severity: "error" }],
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("does not treat mixed semantic_diff + typecheck as advisory", () => {
    expect(
      isAdvisoryVerificationResult(
        result({
          checks: [
            {
              name: "semantic_diff",
              type: "semantic_diff",
              status: "passed",
              passed: true,
              output: "",
              duration: 1,
              errors: [{ message: "移除了导出: foo", severity: "warning" }],
            },
            {
              name: "tsc",
              type: "typecheck",
              status: "failed",
              passed: false,
              output: "",
              duration: 1,
              errors: [{ message: "TS2322", severity: "error" }],
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("does not treat empty-error semantic_diff as advisory", () => {
    expect(
      isAdvisoryVerificationResult(
        result({
          passed: true,
          status: "passed",
          checks: [
            {
              name: "semantic_diff",
              type: "semantic_diff",
              status: "passed",
              passed: true,
              output: "",
              duration: 1,
              errors: [],
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});
