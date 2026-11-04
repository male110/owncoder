import { readFeatureState, saveTasks, stageForPhase, writeFeatureState } from "../../specs.ts";
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
  const feat = feature.trim() || inferFeatureFromContent(content);
  if (!feat) return fail("save_tasks requires a feature name (pass `feature` explicitly)");
  // Gate: the tasks phase only starts after the user approved the design.
  const state = await readFeatureState(ctx.workspaceRoot, feat);
  if (state?.stage === "awaiting_design_approval") {
    return fail(
      `The design for "${feat}" is still awaiting the user's approval. Do not write tasks.md until the user approves the design.`,
    );
  }
  if (state?.stage === "awaiting_spec_approval") {
    return fail(
      `The spec for "${feat}" is still awaiting the user's approval. Do not write tasks.md yet.`,
    );
  }
  const rel = await saveTasks(ctx.workspaceRoot, feat, content);
  await writeFeatureState(ctx.workspaceRoot, feat, stageForPhase("tasks"));
  ctx.currentFeature = feat;
  return okMutation(
    cap(
      `Tasks saved to ${rel}.\nThis phase now PAUSES for the user's review. ` +
        `Once the user approves the tasks, the workspace switches to Agent mode and executes them in order.`,
      ctx.maxOutputChars,
    ),
    rel,
  );
}
