import type { ToolContext, ToolResult } from "./types.ts";
import { ok } from "./shared.ts";

/**
 * Return the project's declared dependencies across ecosystems (npm, cargo,
 * python, go, maven, gradle, nuget, etc.). Parses root-level manifests
 * best-effort. Returns an empty string when no recognizable manifest is found.
 */
export async function toolProjectDeps(ctx: ToolContext): Promise<ToolResult> {
  const { buildProjectDeps } = await import("../loop/project-deps.js");
  const deps = await buildProjectDeps(ctx.workspaceRoot);
  if (!deps.trim()) {
    return ok(
      "No dependency manifests found in the workspace root. " +
        "If you need dependency information, read the relevant manifest files directly " +
        "(e.g. package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml, build.gradle, etc.).",
    );
  }
  return ok(deps);
}
