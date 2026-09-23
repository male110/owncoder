import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatMessage } from "@owncoder/llm";
import {
  formatFinalTaskReports,
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
      description: "Fix A",
      status: "completed",
      report: "Changed file A.",
    },
    {
      taskId: "task_2",
      description: "Fix B",
      status: "failed",
      report: "Blocked on missing credential.",
    },
  ];

  const text = formatFinalTaskReports(reports, { done: 1, total: 2 });

  assert.match(text, /本次对话最终报告/);
  assert.match(text, /进度：1\/2/);
  assert.match(text, /任务 1 \(task_1\) — completed/);
  assert.match(text, /Fix A/);
  assert.match(text, /Changed file A\./);
  assert.match(text, /任务 2 \(task_2\) — failed/);
  assert.match(text, /Blocked on missing credential\./);
});

test("formatFinalTaskReports falls back when no reports were retained", () => {
  assert.equal(
    formatFinalTaskReports([], { done: 0, total: 2 }),
    "All tasks processed (0/2 completed).",
  );
});
