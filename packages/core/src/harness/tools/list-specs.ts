import { formatSpecStatus, getSpecStatus, listSpecs } from "../../specs.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { cap, ok } from "./shared.ts";

export async function toolListSpecs(
  ctx: ToolContext,
  feature: string | undefined,
): Promise<ToolResult> {
  if (feature && feature.trim()) {
    const status = await getSpecStatus(ctx.workspaceRoot, feature);
    return ok(cap(formatSpecStatus(status), ctx.maxOutputChars));
  }
  const features = await listSpecs(ctx.workspaceRoot);
  if (!features.length) return ok("No specs yet. Use save_spec to start one.");
  const lines = features.map(
    (f) => `- ${f.name} [${f.phases.join(",") || "empty"}]${f.complete ? " ✅" : ""} — ${f.title}${f.stage ? ` (${f.stage})` : ""}`,
  );
  return ok(cap(`## Specs\n${lines.join("\n")}`, ctx.maxOutputChars));
}
