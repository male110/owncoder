import { saveExperience, type ExperienceRecord } from "../experience.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { cap, fail } from "./shared.ts";
import { okMutation } from "./fs-shared.ts";

export async function toolSaveExperience(
  ctx: ToolContext,
  symptom: string,
  rootCause: string,
  fix: string,
  files: string[],
  tags: string[],
): Promise<ToolResult> {
  if (!symptom.trim() || !rootCause.trim() || !fix.trim()) {
    return fail("save_experience requires non-empty symptom, rootCause, and fix");
  }
  const exp: ExperienceRecord = {
    id: `exp_${Date.now().toString(36)}_manual`,
    symptom: symptom.slice(0, 500),
    rootCause: rootCause.slice(0, 1000),
    fix: fix.slice(0, 1000),
    files: files.slice(0, 20),
    tags: tags.length ? tags.slice(0, 10) : ["general"],
    traceId: "manual",
    timestamp: Date.now(),
    success: true,
  };
  const rel = await saveExperience(ctx.workspaceRoot, exp);
  return okMutation(cap(`Experience saved to ${rel}.`, ctx.maxOutputChars), rel);
}
