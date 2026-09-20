import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const IGNORE = new Set([
  "node_modules",
  ".git",
  ".owncoder",
  "dist",
  "out",
  "target",
  ".pnpm",
  ".vite",
]);

export async function searchWorkspaceFiles(
  root: string,
  query: string,
  limit = 24,
): Promise<string[]> {
  const q = query.trim().toLowerCase();
  const results: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (results.length >= limit || depth > 7) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (IGNORE.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (q && rel.toLowerCase().includes(q)) results.push(`${rel}/`);
        await walk(full, depth + 1);
      } else if (!q || rel.toLowerCase().includes(q)) {
        results.push(rel);
      }
    }
  }

  await walk(root, 0);
  return results.slice(0, limit);
}
