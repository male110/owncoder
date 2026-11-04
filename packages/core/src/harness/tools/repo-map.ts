import type { ToolContext, ToolResult } from "./types.ts";
import { cap, ok } from "./shared.ts";

export async function toolRepoMap(ctx: ToolContext, hint: string): Promise<ToolResult> {
  const map = await ctx.index.buildRepoMap({
    mapTokens: ctx.workflow.context.mapTokens,
    mentionedPaths: hint ? [hint] : [],
  });
  return ok(cap(map || "(empty map)", ctx.maxOutputChars));
}
