/**
 * 预算耗尽时的强制最终报告轮。
 *
 * 当 ReAct 循环把迭代预算全部花在工具调用上、始终没有输出结论文本时，
 * 普通的终态只能拿到空内容，父智能体会收到一句无信息量的占位语，之前
 * 所有搜索证据被静默丢弃。这里在循环耗尽后追加一次**无工具**模型调用：
 * 强制模型基于已有证据写出报告（含已确认事实与未确认缺口）。
 * 该调用失败或仍无文本时，回退为拼接历史中已有的 assistant 文本。
 */
import { chatCompletionStream, type ChatMessage } from "@owncoder/llm";
import type { ReActLoopContext } from "./react-loop-context.ts";

export const PLANNER_BUDGET_DEGRADED_MARKER = "<!--planner-budget-degraded-->";


const FORCED_REPORT_INSTRUCTION = [
  "Your search budget is exhausted. Stop searching now.",
  "Write your final report immediately in Markdown based ONLY on the evidence already gathered above. Do not call any tools. Do not create files.",
  "Format the report with headings: `## Searched` (paths and patterns), `## Findings` (confirmed results with workspace-relative paths and line numbers as bullets), `## Gaps` (what remains unverified or could not be found). Partial findings are acceptable; returning no report is not.",
].join(" ");

/**
 * Planner 子代理的强制总结指令：按计划报告契约收口（五段结构），
 * 未知点显式写入风险段，而不是继续猜测或搜索。
 */
export const PLANNER_FORCED_REPORT_INSTRUCTION = [
  "Your planning budget is exhausted. Stop researching now.",
  "Write the complete execution plan immediately in Markdown based ONLY on the evidence already gathered above. Do not call any tools. Do not create files.",
  "The plan must contain these five sections, each as its own markdown heading: `目标` (the goal, one or two sentences), `编号步骤` (numbered steps — each naming which file, which symbol, and what change to make), `相关文件` (workspace-relative paths with line or symbol evidence, one line of reason each), `风险与不确定性` (unknowns, assumptions, and anything that could not be verified — state them explicitly instead of guessing), `验证方式` (how to verify the change works).",
  "Partial evidence is acceptable: unresolved points belong under 风险与不确定性. Returning no plan is not acceptable.",
].join(" ");

/** 收集历史中已有的 assistant 文本（去重、限量），作为无文本时的兜底。 */
function collectAssistantNotes(ctx: ReActLoopContext): string {
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const turn of ctx.history) {
    if (turn.role !== "assistant") continue;
    const text = turn.content.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    notes.push(text);
  }
  return notes.slice(-5).join("\n\n");
}

/**
 * 发起一次无工具的强制总结调用并返回报告文本。任何失败都降级为已有文本，
 * 绝不抛错——调用方处于终态路径，不能再因报告失败而丢失全部结果。
 * instruction 允许调用方按循环类型覆盖收口契约（Planner 用计划报告契约）。
 */
export async function forcedFinalReport(
  ctx: ReActLoopContext,
  reason: string,
  instruction: string = FORCED_REPORT_INSTRUCTION,
): Promise<string> {
  const { text } = await forcedFinalReportWithStatus(ctx, reason, instruction);
  return text;
}

/**
 * 带产出状态的强制总结：fromModel=true 表示模型真的按指令生成了新文本，
 * 而不是失败后回退到历史过渡文本。Planner 循环据此决定打满上限时
 * 是否以"已降级的完整计划"成功收口，还是维持 blocked 终态。
 */
export async function forcedFinalReportWithStatus(
  ctx: ReActLoopContext,
  reason: string,
  instruction: string = FORCED_REPORT_INSTRUCTION,
): Promise<{ text: string; fromModel: boolean }> {
  const existing = ctx.lastAssistant.trim() || collectAssistantNotes(ctx);
  const callMessages: ChatMessage[] = [
    ...ctx.messages,
    { role: "user", content: instruction },
  ];

  try {
    const result = await chatCompletionStream(ctx.model, callMessages, {
      // 该轮机制上不给任何工具，模型只能输出文本。
      tools: [],
      signal: ctx.opts.signal,
      apiKey: ctx.opts.llmApiKey,
      purpose: `react_loop#${ctx.stageId}#forced_final_report`,
      taskId: ctx.opts.sessionId,
      onDelta: (text: string) => ctx.opts.onEvent?.({ type: "assistant_delta", text }),
      onThinkingDelta: (text: string) => ctx.opts.onEvent?.({ type: "thinking_delta", text }),
    });
    const text = result.choices[0]?.message?.content?.trim() ?? "";
    if (text) return { text, fromModel: true };
  } catch (error) {
    if (ctx.opts.signal?.aborted) {
      // 中止：保留已收集到的文本，不强行总结。
      return { text: existing, fromModel: false };
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.opts.onEvent?.({ type: "warning", message: `强制最终报告调用失败，已回退到已有文本：${message}` });
  }

  return {
    text: existing || `Explore reached the iteration limit (${reason}); no report text was produced.`,
    fromModel: false,
  };
}
