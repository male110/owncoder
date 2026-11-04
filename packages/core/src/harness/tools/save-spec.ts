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
  const feat = feature.trim() || inferFeatureFromContent(content);
  if (!feat) return fail("save_spec requires a feature name (pass `feature` explicitly)");
  const rel = await saveSpec(ctx.workspaceRoot, feat, content);
  await writeFeatureState(ctx.workspaceRoot, feat, stageForPhase("spec"));
  ctx.currentFeature = feat;
  return okMutation(
    cap(
      `Spec saved to ${rel}.\nThis phase now PAUSES for the user's review — do NOT write design.md or tasks.md yet. ` +
        `Wait for the user to approve the spec (or ask for changes) in the spec panel.`,
      ctx.maxOutputChars,
    ),
    rel,
  );
}
