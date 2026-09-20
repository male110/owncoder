import type { ChangeFile } from "../../changes.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { fail, normalizeRel, ok, toAbs } from "./shared.ts";

function formatPending(
  checkpointId: string | null,
  files: ChangeFile[],
  expired?: boolean,
): string {
  if (expired) {
    return (
      "Session checkpoint is missing (expired or pruned). " +
      "No pending changes can be listed or undone."
    );
  }
  if (!checkpointId || files.length === 0) {
    return "No pending session changes to undo.";
  }
  const lines = [
    `checkpoint: ${checkpointId}`,
    `pending: ${files.length}`,
    "",
    "Use undo_session_change with exactly one path per call. " +
      "To undo multiple files, call the tool once per path. " +
      "Do not use write_file/apply_patch to fake an undo.",
    "",
  ];
  for (const f of files) {
    lines.push(`- ${f.path} (${f.kind})`);
  }
  return lines.join("\n");
}

/**
 * list_session_changes — same pending set as the UI Changes bar.
 * Read-only; does not mutate the workspace.
 */
export async function toolListSessionChanges(ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.sessionChanges) {
    return fail("Session changes API is not available in this context.");
  }
  const pending = await ctx.sessionChanges.getPendingChanges();
  return ok(formatPending(pending.checkpointId, pending.files, pending.expired));
}

/**
 * undo_session_change — restore one pending file to its checkpoint snapshot,
 * matching the UI single-file Undo action. One path only; multi-file undo is
 * multiple tool calls.
 */
export async function toolUndoSessionChange(
  ctx: ToolContext,
  path: string,
): Promise<ToolResult> {
  if (!ctx.sessionChanges) {
    return fail("Session changes API is not available in this context.");
  }
  if (ctx.mode === "plan") {
    return fail("Plan mode cannot undo session file changes.");
  }
  const raw = path.trim();
  if (!raw) return fail("path is required (single workspace-relative file).");

  let rel: string;
  try {
    const abs = toAbs(ctx.workspaceRoot, raw);
    rel = normalizeRel(ctx.workspaceRoot, abs);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (!rel || rel === "." || rel.endsWith("/")) {
    return fail("path must be a single file, not a directory.");
  }

  const before = await ctx.sessionChanges.getPendingChanges();
  if (before.expired) {
    return fail("Session checkpoint is missing; undo is unavailable.");
  }
  if (!before.checkpointId || before.files.length === 0) {
    return fail("没有可撤销的变更");
  }

  const match =
    before.files.find((f) => f.path === rel) ??
    before.files.find((f) => f.path.replace(/\\/g, "/") === rel);

  if (!match) {
    const available = before.files.map((f) => f.path).join(", ");
    return fail(
      `Not in pending session changes: ${rel}. ` +
        (available
          ? `Pending paths: ${available}. Call list_session_changes first.`
          : "Call list_session_changes first."),
    );
  }

  try {
    await ctx.sessionChanges.undoChange(match.path);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  // Force a fresh read if the model looks at this path again this turn.
  ctx.readSet.delete(match.path);
  ctx.readSet.delete(rel);
  ctx.readMtTimes?.delete(match.path);
  ctx.readMtTimes?.delete(rel);

  // Drop from the live turn touch list so post-verify / present don't treat it
  // as still modified by this turn after a successful undo.
  if (ctx.touchedPaths) {
    for (let i = ctx.touchedPaths.length - 1; i >= 0; i--) {
      const p = ctx.touchedPaths[i]!.replace(/\\/g, "/");
      if (p === match.path || p === rel) ctx.touchedPaths.splice(i, 1);
    }
  }

  const after = await ctx.sessionChanges.getPendingChanges();
  const remaining =
    after.files.length === 0
      ? "No pending session changes remain."
      : `Remaining pending (${after.files.length}): ${after.files.map((f) => f.path).join(", ")}`;

  return ok(
    `Undid session change for ${match.path} (${match.kind}), restored from checkpoint. ${remaining}`,
  );
}
