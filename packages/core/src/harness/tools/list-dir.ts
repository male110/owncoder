import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ToolContext, ToolResult } from "./types.ts";
import { assertInside, fail, normalizeInputPath, normalizeRel, ok, toAbs } from "./shared.ts";
import { isSkipDirName } from "./fs-shared.ts";

export async function toolList(ctx: ToolContext, path: string, recursive: boolean): Promise<ToolResult> {
  path = normalizeInputPath(path);
  const abs = toAbs(ctx.workspaceRoot, path);
  assertInside(ctx.workspaceRoot, abs);
  const entries: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const it of items) {
      if (isSkipDirName(it.name)) continue;
      const full = join(dir, it.name);
      const rel = normalizeRel(ctx.workspaceRoot, full);
      entries.push(it.isDirectory() ? `${rel}/` : rel);
      if (recursive && it.isDirectory() && depth < 3) await walk(full, depth + 1);
      if (entries.length >= 200) return;
    }
  }
  try {
    await walk(abs, 0);
  } catch (e: any) {
    if (e.code === "ENOENT") {
      return fail(
        `Directory not found: "${path}". Use list_dir(".") to see the workspace root, or check the spelling.`,
      );
    }
    if (e.code === "ENOTDIR") {
      return fail(`"${path}" is not a directory. Use read_file("${path}") to read it as a file.`);
    }
    return fail(`Cannot list directory "${path}": ${e.message}`);
  }
  return ok(entries.join("\n") || "(empty)");
}
