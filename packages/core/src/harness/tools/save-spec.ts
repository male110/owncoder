import { readFeatureState, saveSpec, stageForPhase, writeFeatureState } from "../../specs.ts";
import { isSpecRequirementsReview, matchesSpecSnapshot, readSpecRequirementsSnapshot } from "../loop/spec-design-intent.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { cap, fail } from "./shared.ts";
import { inferFeatureFromContent, okMutation } from "./fs-shared.ts";

export async function toolSaveSpec(
  ctx: ToolContext,
  feature: string,
  content: string,
): Promise<ToolResult> {
  if (ctx.mode === "spec" && !ctx.workflow.modes.spec.allowSpecFiles) {
    return fail("Spec mode: spec file writes disabled in settings");
  }
  if (!content.trim()) return fail("save_spec requires non-empty content");
  // Reuse the session's active feature before inferring a new name from the
  // document heading: a re-save that names the feature differently would
  // otherwise create a second `docs/<feature>-requirement.md` file for the
  // same feature.
  const feat = feature.trim() || ctx.currentFeature?.trim() || inferFeatureFromContent(content);
  if (!feat) return fail("save_spec requires a feature name (pass `feature` explicitly)");
  const sid = ctx.sessionId;
  if (!sid) return fail("save_spec requires a session");
  const state = await readFeatureState(ctx.workspaceRoot, feat, sid);
  const revision = ctx.specRequirementsRevision;
  if (ctx.specDesignFollowup) return fail("Do not rewrite requirements during the design review.");
  if (ctx.specRequirementsFollowup || revision || isSpecRequirementsReview(state?.stage)) {
    if (!revision || revision.sessionId !== sid) {
      return fail("Only revise the current requirements when the user requests changes.");
    }
    const current = await readSpecRequirementsSnapshot(ctx.workspaceRoot, feat, sid);
    if (!matchesSpecSnapshot(current, revision)) {
      return fail("The Spec requirements or stage changed. Ask the user to review the current requirements before revising them.");
    }
  }
  if (ctx.signal?.aborted) return fail("操作已停止");
  const target = state?.feature ?? feat;
  const rel = await saveSpec(ctx.workspaceRoot, target, content, sid);
  await writeFeatureState(ctx.workspaceRoot, target, stageForPhase("spec"), sid);
  ctx.currentFeature = target;
  return okMutation(
    cap(
      `Spec saved to ${rel}.\nPause so the user can read the requirements. Do not draft the design this turn. ` +
        "When the user asks to continue in their own words, draft the design. Questions or revision requests do not advance the workflow.",
      ctx.maxOutputChars,
    ),
    rel,
  );
}
