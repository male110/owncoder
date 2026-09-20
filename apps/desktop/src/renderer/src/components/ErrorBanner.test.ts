import { describe, expect, it } from "vitest";
import { extractHistoryError, isVerificationGateError } from "./ErrorBanner";

describe("isVerificationGateError", () => {
  it("matches gate failure strings", () => {
    expect(isVerificationGateError("无法报告成功：验证门禁未通过（phase=failed, verification=failed）")).toBe(true);
    expect(isVerificationGateError("成功门禁未通过")).toBe(true);
  });

  it("matches JSON-serialized AppError payloads", () => {
    expect(
      isVerificationGateError(
        JSON.stringify({
          code: "UNKNOWN",
          message: "无法报告成功：验证门禁未通过（phase=failed, verification=failed, checks=2, repairAttempts=3/3）",
        }),
      ),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isVerificationGateError("未配置 LLM API Key")).toBe(false);
    expect(isVerificationGateError({ code: "UNKNOWN", message: "其他警告" })).toBe(false);
  });
});

describe("extractHistoryError", () => {
  it("does not surface verification-gate failures as the top banner", () => {
    expect(
      extractHistoryError([
        { role: "user", content: "改一下" },
        { role: "assistant", content: "Error: 无法报告成功：验证门禁未通过（phase=failed）" },
      ]),
    ).toBeNull();
  });

  it("still extracts other assistant Error: turns", () => {
    const err = extractHistoryError([
      { role: "assistant", content: "Error: 未配置 LLM API Key" },
    ]);
    expect(err?.message).toMatch(/API Key/);
  });
});
