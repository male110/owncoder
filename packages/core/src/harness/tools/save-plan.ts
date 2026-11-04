import { classifyPlanKind, extractTitle, writePlanFile } from "../../plans.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { fail } from "./shared.ts";
import { okMutation } from "./fs-shared.ts";

export async function toolSavePlan(
  ctx: ToolContext,
  content: string,
  title: string,
  filename: string,
): Promise<ToolResult> {
  if (ctx.mode === "spec" && !ctx.workflow.modes.spec.allowSpecFiles) {
    return fail("Spec mode: plan file writes disabled in settings");
  }
  if (!content.trim()) return fail("save_plan requires non-empty content");
  // 硬护栏：文档交付物（PRD/TDD 等）不得写入 .owncoder/plans/，
  // 否则会被误标为可执行计划并显示"批准"按钮。应落到工作区根目录或 docs/。
  const planTitle = extractTitle(content, filename || title || "plan");
  if (classifyPlanKind(filename || title || "plan", planTitle) === "document") {
    return fail(
      "This content looks like a document deliverable (PRD/TDD/etc.), not an executable plan. " +
        "Save it with write_file to the workspace root or docs/ (e.g. PRD.md), not under .owncoder/plans/. " +
        "Use save_plan only for the final implementation plan.",
    );
  }
  const rel = await writePlanFile(ctx.workspaceRoot, content, {
    title: planTitle || undefined,
    filename: filename || undefined,
    sessionId: ctx.sessionId,
  });
  if (ctx.fileSnapshots) {
    if (!ctx.fileSnapshots.some((f) => f.path === rel)) {
      ctx.fileSnapshots.push({ path: rel, existed: false });
    }
  }
  ctx.touchedPaths?.push(rel);
  ctx.lastPlanPath = rel;
  ctx.readSet.add(rel);
  return okMutation(`Saved plan: ${rel}`, rel);
}
