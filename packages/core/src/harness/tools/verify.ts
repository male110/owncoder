import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ToolContext, ToolResult } from "./types.ts";
import { cap, fail, ok, runCommand } from "./shared.ts";

// ── Verification Tools ─────────────────────────────────────

export async function toolTypeCheck(ctx: ToolContext): Promise<ToolResult> {
  try {
    const pt = await detectProjectTypeForLsp(ctx);

    // Detect project size for timeout and user feedback
    // Prefer index data to avoid recursive directory scan
    const indexStatus = ctx.index.status();
    const indexFileCount = indexStatus.kind === "ready" ? indexStatus.fileCount : undefined;
    const { estimateProjectSize } = await import("../verification.ts");
    const size = await estimateProjectSize(ctx.workspaceRoot, indexFileCount);

    let command: string | null = null;
    // Use incremental mode for medium/large projects
    const incrementalFlag = size.category === "medium" || size.category === "large";
    switch (pt.typeChecker) {
      case "tsc":
        command = incrementalFlag ? "npx tsc --noEmit --incremental 2>&1" : "npx tsc --noEmit 2>&1";
        break;
      case "cargo-check": command = "cargo check 2>&1"; break;
      case "mypy":
        command = incrementalFlag ? "mypy . --incremental 2>&1" : "mypy . 2>&1";
        break;
      case "go-vet": command = "go vet ./... 2>&1"; break;
    }

    if (!command) {
      return ok("No type checker configured for this project.");
    }

    // Increase timeout for larger projects
    const timeout = size.category === "large" ? 300_000 : size.category === "medium" ? 180_000 : 60_000;
    const sizeWarning = size.category === "large"
      ? `⚠️ 检测到大型项目（${size.sourceFileCount} 个源文件），类型检查可能需要较长时间...\n`
      : size.category === "medium"
      ? `ℹ️ 检测到中型项目（${size.sourceFileCount} 个源文件），使用增量模式加速检查...\n`
      : "";

    const result = await runCommand(command, ctx.workspaceRoot, timeout, ctx.signal);
    const output = (result.stdout + "\n" + result.stderr).trim();

    if (result.code === 0 && !output) {
      return ok(sizeWarning + "Type check passed — no errors!");
    }

    return ok(cap(
      sizeWarning + `Type Check: ${result.code === 0 ? "PASSED" : "FAILED"}\n\n${output}`,
      ctx.bashMaxChars,
    ));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Project Type Detection (for LSP/verification) ──────────

export interface LspProjectType {
  typeChecker?: "tsc" | "mypy" | "cargo-check" | "go-vet";
  linter?: "eslint" | "ruff" | "clippy";
}

export async function detectProjectTypeForLsp(ctx: ToolContext): Promise<LspProjectType> {
  const result: LspProjectType = {};

  try {
    const pkgPath = join(ctx.workspaceRoot, "package.json");
    await fs.access(pkgPath);
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as Record<string, unknown>;
    const dd = (pkg.devDependencies ?? {}) as Record<string, string>;
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const all = { ...dd, ...deps };

    if ("typescript" in all) result.typeChecker = "tsc";
    if ("eslint" in all) result.linter = "eslint";
  } catch {
    // Not Node
  }

  try {
    await fs.access(join(ctx.workspaceRoot, "Cargo.toml"));
    result.typeChecker = "cargo-check";
    result.linter = "clippy";
  } catch { /* Not Rust */ }

  try {
    await fs.access(join(ctx.workspaceRoot, "pyproject.toml"));
    result.typeChecker = "mypy";
    result.linter = "ruff";
  } catch { /* Not Python */ }

  try {
    await fs.access(join(ctx.workspaceRoot, "go.mod"));
    result.typeChecker = "go-vet";
  } catch { /* Not Go */ }

  return result;
}
