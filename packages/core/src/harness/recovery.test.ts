import { describe, expect, it } from "vitest";
import { classifyRecoveryError } from "./recovery.ts";

describe("classifyRecoveryError", () => {
  it("将类型错误分类为可重试修复", () => {
    const out = classifyRecoveryError("Type check failed: TS2322");
    expect(out.type).toBe("type_check_failed");
    expect(out.retryable).toBe(true);
    expect(out.action).toBe("repair_and_reverify");
  });

  it("将权限/用户决策分类为可重试，交回模型继续处理", () => {
    const permission = classifyRecoveryError("permission denied writing file");
    expect(permission.retryable).toBe(true);
    expect(permission.action).toBe("request_permission_or_confirmation");
    const decision = classifyRecoveryError("awaiting user confirmation");
    expect(decision.retryable).toBe(true);
    expect(decision.action).toBe("wait_for_user_decision");
  });

  it("未知工具错误可重试，交回模型继续处理", () => {
    const out = classifyRecoveryError("something completely unexpected");
    expect(out.type).toBe("unknown");
    expect(out.retryable).toBe(true);
    expect(out.action).toBe("inspect_failure_and_retry");
  });

  it("历史整文件读取超限错误不再被当作参数错误", () => {
    const out = classifyRecoveryError(
      'Error: File "packages/core/src/harness/loop/termination.ts" is 32137 bytes. Whole-file reads are limited to 10000 bytes. Call read_outline first, then decide which lines to read with read_symbol or read_file(offset+limit).',
    );
    expect(out.type).toBe("unknown");
    expect(out.retryable).toBe(true);
    expect(out.action).toBe("inspect_failure_and_retry");
  });

  it("符号索引未命中/查询失败应可重试，不停止流程", () => {
    const miss = classifyRecoveryError(
      'Symbol "syncSharedTaskChangesToChildTasks" was not found in the current index for "paper-server/TaskCreateImplService.java"',
    );
    expect(miss.type).toBe("evidence_expired");
    expect(miss.retryable).toBe(true);
    expect(miss.action).toBe("refresh_evidence");

    const queryFail = classifyRecoveryError('Cannot query the symbol index for "src/foo.ts": db locked');
    expect(queryFail.type).toBe("evidence_expired");
    expect(queryFail.retryable).toBe(true);

    const ambiguous = classifyRecoveryError('Symbol "foo" is ambiguous in "src/bar.ts" (fn at line 10)');
    expect(ambiguous.type).toBe("evidence_expired");
    expect(ambiguous.retryable).toBe(true);
  });

  it("File not found 路径未命中应可重试，不停止流程", () => {
    const out = classifyRecoveryError(
      'Error: File not found: "packages/core/src/harness/react.ts". Use search_symbols or grep to locate the actual path, then read the outline of the confirmed path.',
    );
    expect(out.type).toBe("evidence_expired");
    expect(out.retryable).toBe(true);
    expect(out.action).toBe("refresh_evidence");
  });

  it("权限/用户决策与普通未知错误均可重试，不打断循环", () => {
    const permission = classifyRecoveryError("permission denied writing file");
    expect(permission.retryable).toBe(true);
    expect(permission.action).toBe("request_permission_or_confirmation");

    const decision = classifyRecoveryError("awaiting user confirmation");
    expect(decision.retryable).toBe(true);
    expect(decision.action).toBe("wait_for_user_decision");

    const unknown = classifyRecoveryError("something completely unexpected");
    expect(unknown.retryable).toBe(true);
    expect(unknown.action).toBe("inspect_failure_and_retry");
  });
});
