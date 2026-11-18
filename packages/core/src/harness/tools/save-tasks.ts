import { readFeatureState, saveTasks, stageForPhase, writeFeatureState } from "../../specs.ts";
import { matchesSpecSnapshot, readSpecDesignSnapshot } from "../loop/spec-design-intent.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { cap, fail } from "./shared.ts";
import { inferFeatureFromContent, okMutation } from "./fs-shared.ts";

export async function toolSaveTasks(
  ctx: ToolContext,
  feature: string,
  content: string,
): Promise<ToolResult> {
  if (ctx.mode === "spec" && !ctx.workflow.modes.spec.allowSpecFiles) {
    return fail("Spec mode: spec file writes disabled in settings");
  }
  if (!content.trim()) return fail("save_tasks requires non-empty content");
  const feat = feature.trim() || ctx.currentFeature?.trim() || inferFeatureFromContent(content);
  if (!feat) return fail("save_tasks requires a feature name (pass `feature` explicitly)");
  const sid = ctx.sessionId;
  if (!sid) return fail("save_tasks requires a session");
  const state = await readFeatureState(ctx.workspaceRoot, feat, sid);
  const authorized = ctx.specTaskGeneration;
  if (ctx.specRequirementsFollowup) return fail("Do not draft tasks during the requirements review.");
  if (ctx.specDesignFollowup || authorized || (state?.stage !== "awaiting_tasks_approval" && state?.stage !== "approved")) {
    if (!authorized || authorized.sessionId !== sid || authorized.feature !== state?.feature) {
      return fail("Only generate tasks after the user asks to continue from the current design.");
    }
    const current = await readSpecDesignSnapshot(ctx.workspaceRoot, state.feature, sid);
    if (!matchesSpecSnapshot(current, authorized)) {
      return fail("The Spec design or its stage changed. Ask the user to review the current design before drafting tasks.");
    }
  }
  if (ctx.signal?.aborted) return fail("操作已停止");
  const target = state?.feature ?? feat;
  const rel = await saveTasks(ctx.workspaceRoot, target, content, sid);
  await writeFeatureState(ctx.workspaceRoot, target, stageForPhase("tasks"), sid);
  ctx.currentFeature = target;
  return okMutation(
    cap(
      `Tasks saved to ${rel}.\nPause and let the user review the task list. ` +
        "In the tasks.md preview, select 执行 for one task or 全部执行 for the list.",
      ctx.maxOutputChars,
    ),
    rel,
  );
}
