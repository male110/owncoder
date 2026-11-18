import { saveDesign, stageForPhase, writeFeatureState } from "../../specs.ts";
import { matchesSpecSnapshot, readSpecDesignSnapshot, readSpecRequirementsSnapshot } from "../loop/spec-design-intent.ts";
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
  const feat = feature.trim() || ctx.currentFeature?.trim() || inferFeatureFromContent(content);
  if (!feat) return fail("save_design requires a feature name (pass `feature` explicitly)");
  const sid = ctx.sessionId;
  if (!sid) return fail("save_design requires a session");
  const generation = ctx.specDesignGeneration;
  const revision = ctx.specDesignRevision;
  if ((!generation && !revision) || (generation && revision)) {
    return fail("Only save a design when the user asks to continue from the current requirements or requests a revision to the current design.");
  }
  const authorized = generation ?? revision!;
  if (authorized.sessionId !== sid) return fail("The Spec review belongs to a different session.");
  const current = generation
    ? await readSpecRequirementsSnapshot(ctx.workspaceRoot, feat, sid)
    : await readSpecDesignSnapshot(ctx.workspaceRoot, feat, sid);
  if (!matchesSpecSnapshot(current, authorized)) {
    return fail("The Spec requirements, design, or stage changed. Ask the user to review the current document before saving the design.");
  }
  if (ctx.signal?.aborted) return fail("操作已停止");
  const rel = await saveDesign(ctx.workspaceRoot, authorized.feature, content, sid);
  await writeFeatureState(ctx.workspaceRoot, authorized.feature, stageForPhase("design"), sid);
  ctx.currentFeature = authorized.feature;
  return okMutation(
    cap(
      `Design saved to ${rel}.\nPause so the user can read the design. ` +
        `When the user clearly wants to continue, draft tasks.md without requiring a particular phrase or separate approval. Handle questions or revision requests without advancing.`,
      ctx.maxOutputChars,
    ),
    rel,
  );
}
