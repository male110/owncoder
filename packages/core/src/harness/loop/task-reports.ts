import type { ChatMessage } from "@owncoder/llm";

/** One completed/failed task's report, kept across task switches. */
export interface TaskReport {
  taskId: string;
  description: string;
  status: "completed" | "failed";
  /** Full assistant report text for this task (not truncated). */
  report: string;
}

/**
 * Truncate `messages` back to the stable prefix captured at ReAct loop start
 * (system / context / decompose / user). Drops the previous task's assistant
 * turns and tool results so the next task starts with an isolated context.
 */
export function isolateMessagesForNextTask(
  messages: ChatMessage[],
  prefixLen: number,
): void {
  const keep = Math.max(0, Math.min(prefixLen, messages.length));
  messages.splice(keep);
}

/** Compose every task report into the conversation's final report. */
export function formatFinalTaskReports(
  reports: readonly TaskReport[],
  progress: { done: number; total: number },
): string {
  if (reports.length === 0) {
    return `All tasks processed (${progress.done}/${progress.total} completed).`;
  }

  const sections = reports.map((r, index) => {
    const heading = `### 任务 ${index + 1} (${r.taskId}) — ${r.status}`;
    const desc = r.description.trim() ? `\n${r.description.trim()}` : "";
    const body = r.report.trim() || "(无报告内容)";
    return `${heading}${desc}\n\n${body}`;
  });

  return [
    `## 本次对话最终报告`,
    ``,
    `进度：${progress.done}/${progress.total} 任务完成。`,
    ``,
    ...sections,
  ].join("\n");
}
