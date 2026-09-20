import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import type { FileSnapshot, TurnCheckpoint } from "./harness/checkpoint.ts";

export interface ChangeFile {
  path: string;
  kind: "added" | "modified" | "deleted";
  before: string;
  after: string;
  /** 
   * Short unified-style preview (legacy format).
   * UI now uses before/after directly with Monaco DiffEditor,
   * but this field is kept for logging and backward compatibility.
   */
  preview: string;
}

function previewDiff(before: string, after: string, maxLines = 40): string {
  if (before === after) return "(无差异)";
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && lines.length < maxLines; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    if (left !== undefined && right === undefined) lines.push(`- ${left}`);
    else if (left === undefined && right !== undefined) lines.push(`+ ${right}`);
    else {
      lines.push(`- ${left}`);
      lines.push(`+ ${right}`);
    }
  }
  if (lines.length === 0) {
    // Fallback: show heads
    return [`--- before (${before.length} chars)`, `+++ after (${after.length} chars)`].join("\n");
  }
  if (n > maxLines) lines.push("…");
  return lines.join("\n");
}

export async function buildChangesFromCheckpoint(
  workspaceRoot: string,
  cp: TurnCheckpoint,
): Promise<ChangeFile[]> {
  const snaps = cp.files?.length
    ? cp.files
    : (cp.touched ?? []).map(
        (p): FileSnapshot => ({
          path: p,
          existed: true,
          content: undefined,
        }),
      );

  const out: ChangeFile[] = [];
  for (const snap of snaps) {
    const abs = resolve(workspaceRoot, snap.path);
    let after = "";
    let existsAfter = true;
    try {
      after = await fs.readFile(abs, "utf8");
    } catch {
      existsAfter = false;
    }

    const before = snap.existed ? (snap.content ?? "") : "";
    let kind: ChangeFile["kind"] = "modified";
    if (!snap.existed && existsAfter) kind = "added";
    else if (snap.existed && !existsAfter) kind = "deleted";
    else if (snap.existed && existsAfter) kind = "modified";
    else continue;

    if (kind === "modified" && before === after) continue;

    out.push({
      path: snap.path,
      kind,
      before,
      after,
      preview: previewDiff(before, after),
    });
  }
  return out;
}

export async function restoreSingleFile(
  workspaceRoot: string,
  snap: FileSnapshot,
): Promise<void> {
  const abs = resolve(workspaceRoot, snap.path);
  if (!snap.existed) {
    await fs.unlink(abs).catch(() => undefined);
    return;
  }
  const { dirname } = await import("node:path");
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, snap.content ?? "", "utf8");
}
