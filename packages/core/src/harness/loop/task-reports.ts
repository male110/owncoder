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

/** Compose one final report per task, ignoring duplicate events and repeated paragraphs. */
export function formatFinalTaskReports(reports: readonly TaskReport[]): string {
  const latestByTask = new Map<string, TaskReport>();
  for (const report of reports) latestByTask.set(report.taskId, report);

  const seenReports = new Set<string>();
  const finalReports: string[] = [];
  for (const report of latestByTask.values()) {
    const paragraphs = report.report
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    const uniqueParagraphs = [...new Set(paragraphs)];
    const text = uniqueParagraphs.join("\n\n") || "(无报告内容)";
    const key = text.replace(/\s+/g, " ").trim();
    if (seenReports.has(key)) continue;
    seenReports.add(key);
    finalReports.push(text);
  }
  return finalReports.join("\n\n");
}
