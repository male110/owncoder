/** P1 bounded recovery classification. Keeps model-private reasoning out of telemetry. */
export type RecoveryErrorType =
  | "type_check_failed"
  | "test_failed"
  | "evidence_expired"
  | "tool_argument_error"
  | "permission_denied"
  | "network_or_environment"
  | "user_decision"
  | "unknown";

export type RecoveryAction =
  | "repair_and_reverify"
  | "inspect_failure_and_retry"
  | "refresh_evidence"
  | "correct_arguments"
  | "request_permission_or_confirmation"
  | "retry_with_backoff_or_report_environment"
  | "wait_for_user_decision";

export interface RecoveryClassification {
  type: RecoveryErrorType;
  action: RecoveryAction;
  retryable: boolean;
  summary: string;
}

const rules: Array<{ type: RecoveryErrorType; action: RecoveryAction; retryable: boolean; patterns: RegExp[]; summary: string }> = [
  { type: "type_check_failed", action: "repair_and_reverify", retryable: true, patterns: [/type.?check/i, /tsc/i, /type error/i], summary: "修复类型错误后重新验证" },
  { type: "test_failed", action: "inspect_failure_and_retry", retryable: true, patterns: [/test failed/i, /tests? failed/i, /jest/i, /vitest/i, /assertion/i], summary: "检查失败测试并在修复后重试" },
  { type: "evidence_expired", action: "refresh_evidence", retryable: true, patterns: [/stale/i, /expired/i, /过期证据/i, /重新读取/i, /not found in the current index/i, /Cannot query the symbol index/i, /is ambiguous in/i, /File not found/i], summary: "刷新当前源码证据" },
  { type: "tool_argument_error", action: "correct_arguments", retryable: true, patterns: [/unknown tool/i, /invalid argument/i, /missing.*field/i, /json arguments/i, /malformed/i], summary: "纠正工具名称或参数后重试" },
  // 权限/用户决策类错误同样回传 LLM，不终止 react 循环；由模型决定改路径、换工具或自行 ask_user/report_blocker。
  { type: "permission_denied", action: "request_permission_or_confirmation", retryable: true, patterns: [/permission denied/i, /access denied/i, /权限不足/i, /not authorized/i], summary: "将权限错误交回模型继续处理" },
  { type: "network_or_environment", action: "retry_with_backoff_or_report_environment", retryable: true, patterns: [/timeout/i, /timed out/i, /network/i, /connection/i, /econn/i, /environment/i], summary: "退避重试；仍失败则报告环境问题" },
  { type: "user_decision", action: "wait_for_user_decision", retryable: true, patterns: [/ask_user/i, /awaiting.*confirmation/i, /用户确认/i], summary: "将用户决策类错误交回模型继续处理" },
];

export function classifyRecoveryError(message: string): RecoveryClassification {
  const text = String(message ?? "");
  const match = rules.find((rule) => rule.patterns.some((pattern) => pattern.test(text)));
  return match
    ? { type: match.type, action: match.action, retryable: match.retryable, summary: match.summary }
    // 未命中规则的工具错误仍回传 LLM，由模型决定下一步（如先 outline 再分段读），不终止循环。
    : { type: "unknown", action: "inspect_failure_and_retry", retryable: true, summary: "将工具错误交回模型继续处理" };
}
