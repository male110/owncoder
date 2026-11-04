import { readFeatureState, saveDesign, stageForPhase, writeFeatureState } from "../../specs.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { cap, fail } from "./shared.ts";
import { inferFeatureFromContent, okMutation } from "./fs-shared.ts";

export async function toolSaveDesign(
  ctx: ToolContext,
  feature: string,
  content: string,
): Promise<ToolResult> {
  if (ctx.mode === "spec" && !ctx.workflow.modes.spec.allowSpecFiles) {
    return fail("Spec mode: spec file writes disabled in settings");
  }
  if (!content.trim()) return fail("save_design requires non-empty content");
  const feat = feature.trim() || inferFeatureFromContent(content);
  if (!feat) return fail("save_design requires a feature name (pass `feature` explicitly)");
  // Gate: the design phase only starts after the user approved the spec.
  const state = await readFeatureState(ctx.workspaceRoot, feat);
  if (state && (state.stage === "awaiting_spec_approval" || state.stage === "spec_approved" && false )) {
    // awaiting_spec_approval means the spec has not been approved yet.
  }
  if (state?.stage === "awaiting_spec_approval") {
    return fail(
      `The spec for "${feat}" is still awaiting the user's approval. Do not write design.md until the user approves the spec.`,
    );
  }
  const rel = await saveDesign(ctx.workspaceRoot, feat, content);
  await writeFeatureState(ctx.workspaceRoot, feat, stageForPhase("design"));
  ctx.currentFeature = feat;
  return okMutation(
    cap(
      `Design saved to ${rel}.\nThis phase now PAUSES for the user's review — do NOT write tasks.md yet. ` +
        `Wait for the user to approve the design (or ask for changes) in the spec panel.`,
      ctx.maxOutputChars,
    ),
    rel,
  );
}
