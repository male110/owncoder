import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ToolContext, ToolResult } from "./types.ts";
import { fail, normalizeInputPath, normalizeRel, ok, toAbs } from "./shared.ts";
import { createGlobMatcher, isSkipDirName } from "./fs-shared.ts";
import { loadWorkspaceIgnoreRules, pathIgnored, type IgnoreRule } from "./grep.ts";

export { createGlobMatcher, normalizeGlobPattern, globPatternToRegExp } from "./fs-shared.ts";

/** Maximum number of paths returned by one glob call. */
export const GLOB_MAX_RESULTS = 100;

/**
 * Find workspace files by glob pattern. The traversal shares grep's ignore
 * rules so .gitignore and workflow extraIgnore are always respected.
 */
export async function toolGlob(
  ctx: ToolContext,
  pattern: string,
  path: string,
  maxResults: number,
): Promise<ToolResult> {
  if (!pattern || !pattern.trim()) return fail("glob requires a non-empty pattern");

  const searchPath = normalizeInputPath(path);
  const root = toAbs(ctx.workspaceRoot, searchPath);
  const cap = maxResults > 0 ? Math.floor(maxResults) : GLOB_MAX_RESULTS;

  let rootStat;
  try {
    rootStat = await fs.stat(root);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      return fail(`Directory not found: "${path}". Use glob("**/*", ".") to inspect the workspace.`);
    }
    return fail(`Cannot access "${path}": ${e?.message ?? String(e)}`);
  }
  if (!rootStat.isDirectory()) return fail(`glob path must be a directory: "${path}"`);

  let matcher: (relativePath: string, fileName: string) => boolean;
  try {
    matcher = createGlobMatcher(pattern);
  } catch {
    return fail(`glob pattern cannot be compiled: "${pattern}"`);
  }

  const ignoreRules: IgnoreRule[] = await loadWorkspaceIgnoreRules(
    ctx.workspaceRoot,
    ctx.workflow.index?.extraIgnore ?? [],
  );
  // 用户显式指定的搜索起点：即使它本身（或其后代）命中 .gitignore/extraIgnore
  // 也不跳过——显式路径优先于忽略规则。node_modules/.git 等硬过滤仍生效。
  const explicitRootRel = normalizeRel(ctx.workspaceRoot, root);
  const isExplicitRoot = (rel: string): boolean =>
    rel === explicitRootRel || (explicitRootRel !== "" && rel.startsWith(`${explicitRootRel}/`));
  const matches: Array<{ path: string; mtimeMs: number }> = [];

  async function walk(dir: string): Promise<void> {
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = join(dir, item.name);
      const rel = normalizeRel(ctx.workspaceRoot, full);
      const exempt = isExplicitRoot(rel);
      if (item.isDirectory()) {
        if (isSkipDirName(item.name) || (!exempt && pathIgnored(rel, true, ignoreRules))) continue;
        await walk(full);
        continue;
      }
      if (!item.isFile() || (!exempt && pathIgnored(rel, false, ignoreRules))) continue;

      const relativeToSearch = normalizeRel(root, full);
      if (!matcher(relativeToSearch, item.name)) continue;
      try {
        const stat = await fs.stat(full);
        matches.push({ path: rel, mtimeMs: stat.mtimeMs });
      } catch {
        // The file may disappear during a concurrent workspace change.
      }
    }
  }

  await walk(root);
  matches.sort((a, b) => {
    const byTime = b.mtimeMs - a.mtimeMs;
    return byTime === 0 ? a.path.localeCompare(b.path) : byTime;
  });

  const truncated = matches.length > cap;
  const files = matches.slice(0, cap).map((entry) => entry.path);
  if (files.length === 0) return ok("No files found");
  const notice = truncated
    ? `\n[${cap} files shown, results truncated — narrow the path or pattern, or raise maxResults]`
    : "";
  return ok(files.join("\n") + notice);
}
