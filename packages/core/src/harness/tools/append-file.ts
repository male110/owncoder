import { promises as fs } from "node:fs";
import { isPlanPath } from "../../plans.ts";
import { snapshotFileBeforeWrite } from "../checkpoint.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { assertPlanMutationAllowed, fail } from "./shared.ts";
import { okMutation, resolveEditPath } from "./fs-shared.ts";

export async function toolAppend(ctx: ToolContext, path: string, content: string): Promise<ToolResult> {
  if (!path || !path.trim()) {
    return fail("append_file requires a non-empty file path");
  }
  if (!content) {
    return fail("append_file requires non-empty content to append");
  }
  
  const { abs, rel, external } = resolveEditPath(ctx, path);
  const planBlock = assertPlanMutationAllowed(ctx, rel);
  if (planBlock) return planBlock;

  // Check if file exists
  let originalSize = 0;
  try {
    const stats = await fs.stat(abs);
    originalSize = stats.size;
  } catch {
    return fail(`File "${rel}" does not exist. Use write_file to create it first, then append_file to add content.`);
  }
  
  // Create snapshot before appending for workspace files only.
  if (!external && ctx.fileSnapshots) {
    await snapshotFileBeforeWrite(ctx.workspaceRoot, rel, ctx.fileSnapshots);
  }
  
  // Append content to file
  await fs.appendFile(abs, content, "utf8");
  
  // Update tracking
  ctx.readSet.add(rel);
  if (!external) {
    ctx.touchedPaths?.push(rel);
    if (isPlanPath(rel)) ctx.lastPlanPath = rel;
    ctx.index.invalidate(rel);
    void ctx.index.ragUpdate?.(ctx.workspaceRoot, [], [rel], []);
  }
  
  if (ctx.memory) {
    ctx.memory.addEdit(rel, "append_file", `(+${content.length} chars)`, content.slice(0, 100));
    ctx.memory.updateHotspot(rel, true, false);
  }
  
  const newSize = originalSize + Buffer.byteLength(content, "utf8");
  return okMutation(`Appended to ${rel} (added ${content.length} chars, total now ${newSize} bytes)${external ? " - outside workspace, not tracked for session undo" : ""}`, rel);
}
