import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { isPlanPath } from "../../plans.ts";
import { snapshotFileBeforeWrite } from "../checkpoint.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { assertPlanMutationAllowed, fail } from "./shared.ts";
import { okMutation, resolveEditPath } from "./fs-shared.ts";

interface ResolvedPath {
  path: string;
}

interface PathResolutionError {
  error: string;
}

/**
 * When path is missing/empty, provide a clear error message.
 * 
 * Previously this function would auto-infer the path from readSet when only
 * one file was read, but this was dangerous — it could accidentally overwrite
 * the wrong file (e.g., writing Design.md but overwriting PRD.md because PRD
 * was the only file in readSet).
 * 
 * Now we always require an explicit path parameter for safety.
 */
function resolvePathFromReadSet(
  readSet: Set<string>,
  toolName: string,
): ResolvedPath | PathResolutionError {
  const candidates = [...readSet];
  
  const hint =
    candidates.length > 1
      ? ` Multiple files were read: ${JSON.stringify(candidates.slice(0, 5))}${candidates.length > 5 ? '...' : ''}`
      : candidates.length === 1
      ? ` One file was read (${candidates[0]}), but auto-using it is unsafe — you must specify the target path explicitly.`
      : ` No file was read first.`;
  
  return {
    error: 
      `${toolName} requires an explicit "file_path" parameter. The file_path field is missing or empty.${hint}\n\n` +
      `This typically happens when:\n` +
      `1. Content is too large and JSON payload was truncated (less likely now with 16K max_tokens)\n` +
      `2. The file_path parameter was accidentally omitted\n\n` +
      `Solutions:\n` +
      `- Always include the "file_path" parameter explicitly in the tool call\n` +
      `- For very large files: use write_file for first part (<60KB), then append_file for rest\n` +
      `- If you intended to write to a recently-read file, specify its path explicitly`,
  };
}

/**
 * Below this size a "shrink" is not worth guarding — tiny config/stub files get
 * legitimately rewritten to a fraction of their size all the time.
 */
const SHRINK_GUARD_MIN_BYTES = 400;
/** Overwriting an existing file with less than this share of its content needs opt-in. */
const SHRINK_GUARD_RATIO = 0.5;

export async function toolWrite(
  ctx: ToolContext,
  path: string,
  content: string,
  allowShrink = false,
): Promise<ToolResult> {
  // Reject empty/falsy paths — they produce a nonsensical relative path and
  // an unhelpful "read-before-write: call read_file on """ error downstream.
  if (!path || !path.trim()) {
    const resolved = resolvePathFromReadSet(ctx.readSet, "write_file");
    if ("error" in resolved) return fail(resolved.error);
    path = resolved.path;
  }
  if (!content) {
    return fail("write_file requires non-empty content; got an empty string. Pass the full file text in `content`. If you intended to clear the file, use apply_patch with an empty REPLACE block instead.");
  }
  const { abs, rel, external } = resolveEditPath(ctx, path);
  const planBlock = assertPlanMutationAllowed(ctx, rel);
  if (planBlock) return planBlock;
  // Read the current file (when present) so we can both report accurately and
  // refuse a suspicious shrink below.
  let existing: string | null = null;
  try {
    existing = await fs.readFile(abs, "utf8");
  } catch {
    existing = null;
  }
  const exists = existing !== null;

  // Defense in depth against silent data loss: write_file replaces the ENTIRE
  // file, so a model that emits only the first half of a long file (without the
  // JSON payload itself being truncated, which parser.ts catches separately)
  // would wipe the rest and still get a success result. Make that case opt-in.
  const isLargeShrink =
    exists &&
    existing!.length >= SHRINK_GUARD_MIN_BYTES &&
    content.length < existing!.length * SHRINK_GUARD_RATIO;

  if (isLargeShrink) {
    const pct = Math.round((content.length / existing!.length) * 100);
    const scale = `${existing!.length} → ${content.length} chars (${pct}% of the original)`;
    if (!allowShrink) {
      return fail(
        `write_file would shrink ${rel}: ${scale} — refusing, because write_file replaces the whole file and this looks like truncated or incomplete content.\n\n` +
          `If you only meant to change part of the file, use apply_patch instead.\n` +
          `If the file really should become this much smaller, repeat the call with "allow_shrink": true.`,
      );
    }
    // `allow_shrink` is supplied by the model, so on its own it is only an
    // assertion — and write_file has no read-before-write guard of its own,
    // meaning the model could be confirming the deletion of content it has
    // never seen. Require evidence for this one destructive case: the file must
    // have been read (or written) in this session.
    if (!ctx.readSet.has(rel)) {
      return fail(
        `write_file with "allow_shrink": true would drop most of ${rel} (${scale}), but that file has not been read in this session — so this call cannot know what it is deleting.\n\n` +
          `Call read_file on ${rel} first, then either use apply_patch for a partial edit, or repeat write_file with the complete intended content.`,
      );
    }
    // Bypass accepted. The shrink is already noted in the tool result message,
    // so we don't emit a separate warning event here.
    console.log(`[write_file] large shrink accepted for ${rel}: ${scale}`);
  }

  // Workspace checkpoints and index only cover workspace files.
  if (!external && ctx.fileSnapshots) {
    await snapshotFileBeforeWrite(ctx.workspaceRoot, rel, ctx.fileSnapshots);
  }
  
  // Write file directly - no length limits, no patchFirst conversion
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  
  // Update tracking
  ctx.readSet.add(rel);
  if (!external) {
    ctx.touchedPaths?.push(rel);
    if (isPlanPath(rel)) ctx.lastPlanPath = rel;
    ctx.index.invalidate(rel);
    void ctx.index.ragUpdate?.(ctx.workspaceRoot, [], [rel], []);
  }
  
  if (ctx.memory) {
    ctx.memory.addEdit(rel, "write_file", exists ? "(existing)" : "(new)", content.slice(0, 100));
    ctx.memory.updateHotspot(rel, true, false);
  }
  
  // Keep the shrink in the tool output too, so it stays on the record the model
  // and the user both read back.
  const shrinkNote = isLargeShrink
    ? ` - shrank from ${existing!.length} chars via allow_shrink`
    : "";
  return okMutation(
    `Wrote ${rel} (${content.length} chars)${exists ? " - overwritten" : " - created"}${shrinkNote}${external ? " - outside workspace, not tracked for session undo" : ""}`,
    rel,
  );
}
