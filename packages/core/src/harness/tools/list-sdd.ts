import { formatFeatureStatus, getFeatureStatus, listFeatures } from "../../sdd.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { cap, ok } from "./shared.ts";

export async function toolListSdd(
  ctx: ToolContext,
  feature: string | undefined,
): Promise<ToolResult> {
  if (feature && feature.trim()) {
    const status = await getFeatureStatus(ctx.workspaceRoot, feature);
    return ok(cap(formatFeatureStatus(status), ctx.maxOutputChars));
  }
  const features = await listFeatures(ctx.workspaceRoot);
  if (!features.length) return ok("No SDD features yet. Use save_spec to start one.");
  const lines = features.map(
    (f) => `- ${f.name} [${f.phases.join(",") || "empty"}]${f.complete ? " ✅" : ""} — ${f.title}`,
  );
  return ok(cap(`## SDD features\n${lines.join("\n")}`, ctx.maxOutputChars));
}
