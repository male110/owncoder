import { saveSpec, stageForPhase, writeFeatureState } from "../../specs.ts";
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
  // otherwise create a second `.owncoder/specs/<feature>/` directory for the
  // same feature.
  const feat = feature.trim() || ctx.currentFeature?.trim() || inferFeatureFromContent(content);
  if (!feat) return fail("save_spec requires a feature name (pass `feature` explicitly)");
  const rel = await saveSpec(ctx.workspaceRoot, feat, content, ctx.sessionId!);
  await writeFeatureState(ctx.workspaceRoot, feat, stageForPhase("spec"), ctx.sessionId!);
  ctx.currentFeature = feat;
  return okMutation(
    cap(
      `Spec saved to ${rel}.\nThis phase now PAUSES for the user's review — do NOT write design.md or tasks.md yet. ` +
        `Confirm the document in the chat: the user replies "下一步"/"next" to approve, or describes changes to request a revision.`,
      ctx.maxOutputChars,
    ),
    rel,
  );
}
