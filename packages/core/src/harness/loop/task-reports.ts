import type { ChatMessage } from "@owncoder/llm";

/** One completed/failed task's report, kept across task switches. */
export interface TaskReport {
  taskId: string;
  /** 该任务的执行指引（仅用于标识，报告合成不依赖它）。 */
  executionGuidance: string;
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

/**
 * 否定语境窗口：先剔除 "no error found" / "未发现 error" / "without any
 * failure" 这类**提及**错误而非报告失败的片段，再匹配失败信号——
 * 仅出现错误名词不应把任务判负。
 */
const NEGATED_MENTION =
  /(?:\b(?:no|none|without|never|didn'?t|did\s+not|doesn'?t|does\s+not|isn'?t|is\s+not|was\s+not|cannot\s+find|cannot\s+locate)\b|未|没有|无)[\s\w\p{Script=Han}-]{0,16}?(?:\b(?:error|errors|failure|failures|failed|incomplete|unable|block|blocks|blocked)\b|失败)/giu;

/** 报告正文的失败信号（中英双语）。 */
const FAILURE_SIGNAL =
  /\b(?:failed|failure|unable\s+to|cannot|could\s+not|can'?t|not\s+possible|blocked|incomplete)\b|失败|无法|未能|未完成|不能完成|做不了|无法继续/i;

/**
 * 判定任务的终态报告是否给出失败结论。
 *
 * 只在**剔除否定语境**之后匹配失败信号：报告里写 "验证通过，未发现 error"
 * 或 "no failure was observed" 是完成，写 "failed to fix" / "无法继续" 才是
 * 失败。中英文报告都覆盖。
 */
export function isFailureReport(content: string): boolean {
  const verdict = content.replace(NEGATED_MENTION, " ");
  return FAILURE_SIGNAL.test(verdict);
}
