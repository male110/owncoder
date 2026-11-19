/**
 * 任务接力（upstream relay）。
 *
 * 任务切换时把上游任务的终态报告压成下游执行者需要的 brief 摘要——
 * 对照 Codex：root 读完 worker 返回的结果与改动后，再派下一个 worker。
 * owncoder 里这步由 loop 在切换点装配，下游任务一开局就拿到"已被上游
 * 刷新过"的事实，而不是分解阶段冻结的旧 brief。
 *
 * 生成方式：一次无工具、低思考的 LLM 调用；输入合计很短时直接拼接原文
 * （跳过 LLM）；调用失败/超时/空结果时降级为规则截断。接力只缓存一次
 * （按下游 taskId），不落任务数据结构。
 */
import { chatCompletionStream, writeEventLog } from "@owncoder/llm";
import { withRetry } from "../model-coordinator.ts";
import type { TaskItem } from "../../plans.ts";
import type { TaskReport } from "./task-reports.ts";
import type { ReActLoopContext } from "./react-loop-context.ts";

/** 上游报告合计短于此字符数时跳过 LLM，直接拼接原文（截断到上限）。 */
const RAW_RELAY_THRESHOLD = 1500;
/** 单个上游报告在降级/直传路径下的截断上限。 */
const RAW_RELAY_PER_TASK = 1200;
/** LLM 摘要输出的字符上限。 */
const RELAY_MAX_CHARS = 4000;

const RELAY_SYSTEM_PROMPT = `You are the relay between finished tasks and a pending task in a coding agent's sequential worklist.

Input: the terminal reports of the finished upstream tasks, plus the pending task's execution brief.
Output **only** what the next executor needs, as Markdown, in this order:

1. **Verified anchors**: file paths, symbols, and line ranges the upstream tasks actually confirmed during execution. The downstream executor uses them directly and must not relocate them.
2. **Changed files**: every file path the upstream tasks actually changed.
3. **Reusable conclusions**: conclusions the downstream executor can treat as verified fact without re-checking.
4. **Open unknowns**: unknowns the upstream tasks explicitly left open and the downstream executor must resolve itself.
5. **Premise conflicts**: any place the downstream brief's premise (anchors, scope, assumed state) is contradicted by the upstream results. Name the conflict explicitly.

Rules:
- Extract only from the supplied reports and brief; never infer, guess, or invent paths, symbols, or conclusions.
- Keep the whole relay under 800 tokens; drop tangential detail rather than the anchors.
- Write in the same language as the reports. No preamble, no explanations of your process.`;

function ruleBasedRelay(reports: readonly TaskReport[]): string {
  return reports
    .map(
      (report) =>
        `### Upstream task ${report.taskId} (${report.status})\n${report.report.slice(0, RAW_RELAY_PER_TASK)}`,
    )
    .join("\n\n");
}

/**
 * 为下游任务构建接力包。返回 null 表示无需接力（没有已终态的上游任务）。
 *
 * LLM 路径带 1 次重试；任何失败（超时、中止、空文本）都降级为规则截断，
 * 接力不断路——下游总能拿到上游报告的某种形态。
 */
export async function buildUpstreamRelay(
  ctx: ReActLoopContext,
  next: TaskItem,
): Promise<string | null> {
  const upstream = next.dependsOn
    .map((id) => ctx.taskReports.find((report) => report.taskId === id))
    .filter((report): report is TaskReport => report !== undefined);

  if (upstream.length === 0) return null;

  const totalChars = upstream.reduce((sum, report) => sum + report.report.length, 0);
  if (totalChars <= RAW_RELAY_THRESHOLD) {
    return ruleBasedRelay(upstream);
  }

  const userContent = [
    `# Pending task brief (id: ${next.id})`,
    next.progressStatus ? `Title: ${next.progressStatus}` : "",
    `Execution guidance:\n${next.executionGuidance}`,
    "",
    `# Upstream task reports (${upstream.length})`,
    ...upstream.map(
      (report) =>
        `## Upstream task ${report.taskId} (status: ${report.status})\n${report.report}`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages = [
    { role: "system" as const, content: RELAY_SYSTEM_PROMPT },
    { role: "user" as const, content: userContent },
  ];

  try {
    const relayResult = await withRetry(
      () =>
        chatCompletionStream(ctx.model, messages, {
          signal: ctx.opts.signal,
          apiKey: ctx.opts.llmApiKey,
          purpose: "upstream_relay",
          taskId: ctx.opts.sessionId,
          thinking: { effort: "low" },
          timeout: 120_000,
        }),
      { maxRetries: 1, baseDelay: 3000, signal: ctx.opts.signal },
    );
    const content = relayResult.result.choices[0]?.message?.content?.trim() ?? "";
    if (!content) throw new Error("empty relay content");
    writeEventLog({
      category: "react_loop",
      message: `upstream relay built for ${next.id} (llm, ${content.length} chars)`,
      details: {
        stageId: ctx.stageId,
        nextTaskId: next.id,
        upstreamTaskIds: upstream.map((report) => report.taskId),
        mode: "llm",
        chars: content.length,
      },
    });
    return content.slice(0, RELAY_MAX_CHARS);
  } catch (error) {
    writeEventLog({
      category: "react_loop",
      message: `upstream relay fell back to rule-based for ${next.id}: ${(error as Error).message}`,
      details: {
        stageId: ctx.stageId,
        nextTaskId: next.id,
        upstreamTaskIds: upstream.map((report) => report.taskId),
        mode: "fallback",
      },
    });
    return ruleBasedRelay(upstream);
  }
}
