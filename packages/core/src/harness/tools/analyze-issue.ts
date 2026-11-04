import { bugfixWorkflow, formatBugfixPlan } from "../bugfix.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { cap, fail, ok } from "./shared.ts";

export async function toolAnalyzeIssue(
  ctx: ToolContext,
  description: string,
): Promise<ToolResult> {
  if (!description.trim()) return fail("analyze_issue requires a non-empty issue description");
  const plan = await bugfixWorkflow(ctx.workspaceRoot, description, { search: undefined });
  return ok(cap(formatBugfixPlan(plan), ctx.maxOutputChars));
}
