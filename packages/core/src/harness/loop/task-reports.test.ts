import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatMessage } from "@owncoder/llm";
import {
  formatFinalTaskReports,
  isFailureReport,
  isolateMessagesForNextTask,
  type TaskReport,
} from "./task-reports.ts";

test("isolateMessagesForNextTask truncates back to the stable prefix", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "user" },
    { role: "assistant", content: null, tool_calls: [] as never[] },
    { role: "tool", tool_call_id: "c1", name: "read_file", content: "big tool result" },
    { role: "assistant", content: "task 1 report" },
  ];

  isolateMessagesForNextTask(messages, 2);

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.content, "sys");
  assert.equal(messages[1]?.content, "user");
});

test("isolateMessagesForNextTask clamps an oversized prefix", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
  isolateMessagesForNextTask(messages, 99);
  assert.equal(messages.length, 1);
});

test("formatFinalTaskReports composes every retained task report", () => {
  const reports: TaskReport[] = [
    {
      taskId: "task_1",
      executionGuidance: "Fix A",
      status: "completed",
      report: "Changed file A.",
    },
    {
      taskId: "task_2",
      executionGuidance: "Fix B",
      status: "failed",
      report: "Blocked on missing credential.",
    },
  ];

  const text = formatFinalTaskReports(reports);

  assert.equal(text, "Changed file A.\n\nBlocked on missing credential.");
  assert.doesNotMatch(text, /本次对话最终报告/);
  assert.doesNotMatch(text, /进度/);
  assert.doesNotMatch(text, /任务/);
});

test("formatFinalTaskReports keeps one final report for a single task and removes repeated paragraphs", () => {
  const report = "调查结论和代码证据。\n\n修复建议。";
  assert.equal(formatFinalTaskReports([
    { taskId: "task_1", executionGuidance: "Investigate", status: "completed", report: `${report}\n\n${report}` },
  ]), report);
});

test("formatFinalTaskReports keeps the latest retry result for a task", () => {
  assert.equal(formatFinalTaskReports([
    { taskId: "task_1", executionGuidance: "Investigate", status: "failed", report: "中间失败状态" },
    { taskId: "task_1", executionGuidance: "Investigate", status: "completed", report: "最终调查结论及证据" },
  ]), "最终调查结论及证据");
});

test("formatFinalTaskReports removes identical report text but preserves distinct task reports", () => {
  assert.equal(formatFinalTaskReports([
    { taskId: "task_1", executionGuidance: "A", status: "completed", report: "相同结论" },
    { taskId: "task_2", executionGuidance: "B", status: "completed", report: " 相同结论 " },
    { taskId: "task_3", executionGuidance: "C", status: "failed", report: "不同的失败报告" },
  ]), "相同结论\n\n不同的失败报告");
});

test("formatFinalTaskReports returns an empty body when no reports were retained", () => {
  assert.equal(formatFinalTaskReports([]), "");
});

test("isFailureReport detects explicit failure verdicts", () => {
  assert.equal(isFailureReport("Task failed: could not find the entry point."), true);
  assert.equal(isFailureReport("Unable to proceed — the API returns 403."), true);
  assert.equal(isFailureReport("验证失败：目标方法不存在。"), true);
  assert.equal(isFailureReport("无法继续，缺少数据库凭据。"), true);
  assert.equal(isFailureReport("The build is blocked by a missing dependency."), true);
  assert.equal(isFailureReport("未能完成，超时。"), true);
});

test("isFailureReport does not flag negated mentions of error words", () => {
  assert.equal(isFailureReport("验证通过，未发现 error。"), false);
  assert.equal(isFailureReport("Checked all call sites; no failures were observed."), false);
  assert.equal(isFailureReport("Test suite passes without any error."), false);
  assert.equal(isFailureReport("The fix works: did not encounter the error again."), false);
  assert.equal(isFailureReport("没有失败用例，全部通过。"), false);
});
