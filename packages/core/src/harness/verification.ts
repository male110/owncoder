/**
 * Verification Engine — Execution-Grounded Verification
 * 
 * Replaces naive LLM self-review with actual execution verification:
 * - Type checking (TypeScript, Python/mypy, Rust/cargo check)
 * - Lint checking
 * - LSP diagnostics on changed files (error-level diagnostics block + auto-fix)
 * - Semantic diff analysis
 * - Sandboxed code execution
 *
 * Tests are NOT run by verify() — run them via bash when needed.
 *
 * **Adaptive verification**: For large projects, full type checking is
 * automatically skipped to avoid long waits. Only lightweight checks
 * (lint / LSP on changed files, semantic diff) are performed.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, extname } from "node:path";
import { normalizeVerificationResult, type VerificationCheck, type VerificationError, type VerificationResult } from "../task-run.ts";
import { unmatchedExportChanges } from "./diff-heuristics.ts";
import { getLspManager } from "./tools/lsp.ts";
import type { LspDiagnostic } from "./lsp-client.ts";
export type { VerificationCheck, VerificationError, VerificationResult } from "../task-run.ts";

// ── Types ──────────────────────────────────────────────────

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
}

export interface SemanticDiff {
  path: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  breakingChanges: string[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

// ── Project Size Detection ───────────────────────────────

export type ProjectSizeCategory = "small" | "medium" | "large";

export interface ProjectSizeInfo {
  category: ProjectSizeCategory;
  sourceFileCount: number;
  totalFileCount: number;
}

/** Extensions considered as source files for size estimation. */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".swift",
  ".c", ".cpp", ".cc", ".h", ".hpp",
  ".cs", ".rb", ".php", ".scala", ".ex", ".exs",
]);

/** Directories to skip when scanning for project size. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target",
  "__pycache__", ".venv", "venv", ".next", ".nuxt",
  "coverage", ".turbo", ".cache", "tmp", "temp",
]);

/**
 * Thresholds for project size classification.
 * - small:  < 300 source files  → full verification (type check + lint)
 * - medium: 300–1500 source files → type check with incremental + lint
 * - large:  > 1500 source files → skip full type check, lint changed files only
 */
const SIZE_THRESHOLDS = {
  small: 300,
  large: 1500,
} as const;

/**
 * Quickly estimate project size by counting source files.
 * 
 * Strategy:
 * 1. If `indexFileCount` is provided (from IndexClient.status()), use it directly — no filesystem scan needed.
 * 2. Otherwise, perform fast directory traversal with smart skipping of non-source directories.
 * 
 * This avoids expensive recursive walks for projects that already have an index built.
 */
export async function estimateProjectSize(
  workspaceRoot: string,
  indexFileCount?: number,
): Promise<ProjectSizeInfo> {
  // Fast path: use index data if available
  if (indexFileCount !== undefined && indexFileCount > 0) {
    let category: ProjectSizeCategory;
    if (indexFileCount < SIZE_THRESHOLDS.small) {
      category = "small";
    } else if (indexFileCount < SIZE_THRESHOLDS.large) {
      category = "medium";
    } else {
      category = "large";
    }
    return { category, sourceFileCount: indexFileCount, totalFileCount: indexFileCount };
  }

  // Slow path: fallback to directory traversal when index is unavailable
  let sourceFileCount = 0;
  let totalFileCount = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return; // prevent runaway recursion
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission error or similar
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        totalFileCount++;
        const ext = extname(entry.name).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext)) {
          sourceFileCount++;
        }
      }
    }
  }

  await walk(workspaceRoot, 0);

  let category: ProjectSizeCategory;
  if (sourceFileCount < SIZE_THRESHOLDS.small) {
    category = "small";
  } else if (sourceFileCount < SIZE_THRESHOLDS.large) {
    category = "medium";
  } else {
    category = "large";
  }

  return { category, sourceFileCount, totalFileCount };
}

// ── Verification Orchestrator ─────────────────────────────

export class VerificationEngine {
  private workspaceRoot: string;
  private timeout: number;
  private projectSize: ProjectSizeInfo | null = null;
  private indexFileCount?: number;
  private timingContext?: string;

  constructor(workspaceRoot: string, opts?: {
    timeout?: number;
    /** 控制台耗时日志的关联标识，不包含消息正文。 */
    timingContext?: string;
    /** Pre-computed project size info; if omitted, will be estimated automatically. */
    projectSize?: ProjectSizeInfo;
    /** File count from IndexClient.status(). When provided, avoids recursive directory scan. */
    indexFileCount?: number;
  }) {
    this.workspaceRoot = workspaceRoot;
    this.timeout = opts?.timeout ?? 120_000; // 2 min default
    this.projectSize = opts?.projectSize ?? null;
    this.indexFileCount = opts?.indexFileCount;
    this.timingContext = opts?.timingContext;
  }

  /**
   * Run all applicable verifications for changed files.
   * 
   * For large projects (>1500 source files), full type checking is skipped
   * to avoid long compilation waits. Only lightweight checks are performed:
   * - Lint on changed files (fast, file-scoped)
   * - Semantic diff analysis (fast, no compilation)
   * 
   * For medium projects (300–1500 files), type check is run with incremental mode.
   * For small projects (<300 files), full verification is performed.
   */
  async verify(changedFiles: string[]): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];
    const suggestions: string[] = [];

    const timed = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      let status = "error";
      console.log(`[verify] ${this.timingContext ?? ""} step=${step} start`);
      try {
        const result = await run();
        const check = result as Partial<VerificationCheck>;
        status = check.skipped || check.status === "skipped" ? "skipped" : check.passed === false ? "failed" : "done";
        return result;
      } finally {
        console.log(`[verify] ${this.timingContext ?? ""} step=${step} status=${status} duration=${Math.round(performance.now() - started)}ms`);
      }
    };
    const skipped = (step: string, reason: string) => console.log(`[verify] ${this.timingContext ?? ""} step=${step} status=skipped duration=0ms reason=${reason}`);

    // Detect project type and size
    const projectType = await timed("detect_project", () => this.detectProjectType());
    const size = await timed("estimate_project_size", async () => this.projectSize ?? await estimateProjectSize(this.workspaceRoot, this.indexFileCount));
    this.projectSize = size;

    // 1. Type checking — adaptive based on project size
    if (projectType.typeChecker) {
      if (size.category === "large") {
        skipped("typecheck", "large_project");
        // Large project: skip full type check, add informational note
        suggestions.push(
          `项目较大（${size.sourceFileCount} 个源文件），已跳过全量类型检查以避免长时间等待。` +
          `建议在 CI 中运行完整检查，或手动运行类型检查命令。`
        );
      } else {
        const typeCheck = await timed("typecheck", () => this.runTypeCheck(projectType, size));
        checks.push(typeCheck);
        if (!typeCheck.passed) {
          suggestions.push("类型检查未通过，请修复类型错误后重试");
        }
      }
    }

    if (!projectType.typeChecker) skipped("typecheck", "no_checker");

    // 2. Lint checking (always run on changed files — it's fast)
    if (projectType.linter && changedFiles.length > 0) {
      const lintCheck = await timed("lint", () => this.runLint(changedFiles, projectType));
      checks.push(lintCheck);
      if (!lintCheck.passed) {
        suggestions.push("Lint 检查发现警告，建议修复以保持代码风格一致");
      }
    }

    if (!projectType.linter || changedFiles.length === 0) skipped("lint", changedFiles.length === 0 ? "no_changed_files" : "no_linter");
    if (changedFiles.length === 0) {
      skipped("lsp_diagnostics", "no_changed_files");
      skipped("semantic_diff", "no_changed_files");
    }

    // 3. LSP diagnostics on changed files (error-level → hard fail + auto-fix)
    if (changedFiles.length > 0) {
      const lspCheck = await timed("lsp_diagnostics", () => this.runLspDiagnostics(changedFiles));
      checks.push(lspCheck);
      if (lspCheck.errors.some((e) => e.severity === "error")) {
        suggestions.push("LSP 诊断发现了错误，请修复以避免错误累积");
      } else if (lspCheck.errors.length > 0) {
        suggestions.push("LSP 诊断发现了警告，建议尽快处理");
      }
    }

    // Tests are intentionally NOT part of automatic verify().
    // Agents can still run tests via bash when needed.

    // 4. Semantic diff analysis (always run — it's lightweight)
    if (changedFiles.length > 0) {
      const diffCheck = await timed("semantic_diff", () => this.analyzeSemanticDiff(changedFiles));
      checks.push(diffCheck);
    }

    // 统一走 normalize：补齐 blocking/skipped/source，并按阻断性判定整体结果。
    const summary = this.buildSummary(checks, checks.every((c) => c.status === "passed" || c.status === "skipped"), size);
    return normalizeVerificationResult({
      passed: false,
      status: "failed",
      checks,
      summary,
      suggestions,
    });
  }

  /**
   * Execute a command in a sandboxed manner.
   */
  async sandboxExec(command: string, opts?: {
    cwd?: string;
    env?: Record<string, string>;
    maxOutput?: number;
  }): Promise<SandboxResult> {
    const cwd = opts?.cwd ?? this.workspaceRoot;
    const maxOutput = opts?.maxOutput ?? 100_000;
    const startTime = Date.now();

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, ...opts?.env },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.timeout);

      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
        if (stdout.length > maxOutput) stdout = stdout.slice(0, maxOutput);
      });

      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
        if (stderr.length > maxOutput) stderr = stderr.slice(0, maxOutput);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 1,
          stdout: stdout.slice(0, maxOutput),
          stderr: stderr.slice(0, maxOutput),
          duration: Date.now() - startTime,
          timedOut,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout,
          stderr: err.message,
          duration: Date.now() - startTime,
          timedOut: false,
        });
      });
    });
  }

  // ── Project Detection ───────────────────────────────────

  private async detectProjectType(): Promise<ProjectType> {
    const result: ProjectType = {};

    try {
      const pkgJson = await fs.readFile(join(this.workspaceRoot, "package.json"), "utf8");
      const pkg = JSON.parse(pkgJson) as Record<string, unknown>;

      // TypeScript project
      if (pkg.devDependencies && typeof pkg.devDependencies === "object") {
        const dd = pkg.devDependencies as Record<string, string>;
        if ("typescript" in dd) {
          result.typeChecker = "tsc";
          result.linter = "eslint" in dd ? "eslint" : undefined;
        }
      }
    } catch {
      // Not a Node project
    }

    // Check for Python
    try {
      await fs.access(join(this.workspaceRoot, "pyproject.toml"));
      result.typeChecker = "mypy";
      result.linter = "ruff";
    } catch {
      // Not Python
    }

    // Check for Rust
    try {
      await fs.access(join(this.workspaceRoot, "Cargo.toml"));
      result.typeChecker = "cargo-check";
      result.linter = "clippy";
    } catch {
      // Not Rust
    }

    // Check for Go
    try {
      await fs.access(join(this.workspaceRoot, "go.mod"));
      result.typeChecker = "go-vet";
    } catch {
      // Not Go
    }

    return result;
  }

  // ── Type Checking ───────────────────────────────────────

  private async runTypeCheck(pt: ProjectType, size?: ProjectSizeInfo): Promise<VerificationCheck> {
    const start = Date.now();
    const errors: VerificationError[] = [];

    try {
      const command = this.getTypeCheckCommand(pt, size);
      if (!command) {
        // 无可用命令时静默跳过，不输出「未配置」文案，也不记为失败
        return {
          name: "typecheck",
          type: "typecheck",
          status: "skipped",
          passed: false,
          output: "",
          duration: 0,
          errors: [],
          blocking: false,
          skipped: true,
          source: pt.typeChecker ?? "typecheck",
        };
      }

      const result = await this.sandboxExec(command);

      // Parse errors from output
      const parsed = this.parseTypeErrors(result.stdout + result.stderr, pt.typeChecker!);
      const passed = result.exitCode === 0;

      return {
        name: "typecheck",
        type: "typecheck",
        status: passed ? "passed" : "failed",
        passed,
        output: (result.stdout + "\n" + result.stderr).trim(),
        duration: Date.now() - start,
        errors: parsed,
        blocking: !passed,
        skipped: false,
        source: pt.typeChecker ?? "typecheck",
      };
    } catch (e) {
      return {
        name: "typecheck",
        type: "typecheck",
        status: "failed",
        passed: false,
        output: String(e),
        duration: Date.now() - start,
        errors,
        blocking: true,
        skipped: false,
        source: pt.typeChecker ?? "typecheck",
      };
    }
  }

  private getTypeCheckCommand(pt: ProjectType, size?: ProjectSizeInfo): string | null {
    switch (pt.typeChecker) {
      case "tsc":
        // Medium projects: use incremental mode for faster type checking
        if (size?.category === "medium") {
          return "npx tsc --noEmit --incremental";
        }
        return "npx tsc --noEmit";
      case "mypy":
        // mypy with incremental caching enabled by default, add --incremental for medium
        if (size?.category === "medium") {
          return "mypy . --incremental";
        }
        return "mypy .";
      case "cargo-check": return "cargo check 2>&1";
      case "go-vet": return "go vet ./...";
      default: return null;
    }
  }

  private parseTypeErrors(output: string, checker: string): VerificationError[] {
    const errors: VerificationError[] = [];

    if (checker === "tsc") {
      // tsc error format: file(line,col): error TS1234: message
      const re = /(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(output))) {
        errors.push({
          file: m[1]!.trim(),
          line: Number(m[2]),
          column: Number(m[3]),
          message: m[6]!.trim(),
          severity: m[4] === "error" ? "error" : "warning",
          code: `TS${m[5]}`,
        });
      }
    } else if (checker === "mypy") {
      const re = /(.+?):(\d+):\s+(error|warning):\s+(.+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(output))) {
        errors.push({
          file: m[1]!.trim(),
          line: Number(m[2]),
          message: m[4]!.trim(),
          severity: m[3] === "error" ? "error" : "warning",
        });
      }
    } else if (checker === "cargo-check") {
      const re = /error\[(\w+)\]:\s+(.+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(output))) {
        errors.push({
          message: m[2]!.trim(),
          severity: "error",
          code: m[1],
        });
      }
    }

    return errors;
  }

  // ── Lint Checking ───────────────────────────────────────

  private async runLint(files: string[], pt: ProjectType): Promise<VerificationCheck> {
    const start = Date.now();
    const errors: VerificationError[] = [];

    try {
      const command = this.getLintCommand(pt, files);
      if (!command) {
        return {
          name: "lint",
          type: "lint",
          status: "skipped",
          passed: false,
          output: "No linter configured",
          duration: 0,
          errors: [],
          blocking: false,
          skipped: true,
          source: pt.linter ?? "lint",
        };
      }

      const result = await this.sandboxExec(command);
      const parsed = this.parseLintOutput(result.stdout + result.stderr, pt.linter!);
      const passed = parsed.filter((e) => e.severity === "error").length === 0;

      return {
        name: "lint",
        type: "lint",
        status: passed ? "passed" : "failed",
        passed,
        output: (result.stdout + "\n" + result.stderr).trim(),
        duration: Date.now() - start,
        errors: parsed,
        blocking: !passed,
        skipped: false,
        source: pt.linter ?? "lint",
      };
    } catch (e) {
      return {
        name: "lint",
        type: "lint",
        status: "failed",
        passed: false,
        output: String(e),
        duration: Date.now() - start,
        errors,
        blocking: true,
        skipped: false,
        source: pt.linter ?? "lint",
      };
    }
  }

  private getLintCommand(pt: ProjectType, files: string[]): string | null {
    const fileList = files.slice(0, 20).join(" ");
    switch (pt.linter) {
      case "eslint": return `npx eslint ${fileList || "."} --format compact`;
      case "ruff": return `ruff check ${fileList || "."}`;
      case "clippy": return "cargo clippy 2>&1";
      default: return null;
    }
  }

  private parseLintOutput(output: string, linter: string): VerificationError[] {
    const errors: VerificationError[] = [];

    if (linter === "eslint") {
      // eslint compact: file: line X, col Y, Error/Warning - message (rule)
      const re = /(.+?):\s+line\s+(\d+),\s+col\s+(\d+),\s+(Error|Warning)\s+-\s+(.+?)\s+\((.+?)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(output))) {
        errors.push({
          file: m[1]!.trim(),
          line: Number(m[2]),
          column: Number(m[3]),
          message: m[5]!.trim(),
          severity: m[4]!.toLowerCase() === "error" ? "error" : "warning",
          code: m[6]!.trim(),
        });
      }
    } else if (linter === "ruff") {
      const re = /(.+?):(\d+):(\d+):\s+(\w+)\s+(.+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(output))) {
        errors.push({
          file: m[1]!.trim(),
          line: Number(m[2]),
          column: Number(m[3]),
          message: m[5]!.trim(),
          severity: "warning",
          code: m[4]!.trim(),
        });
      }
    }

    return errors;
  }

  // ── LSP Diagnostics ─────────────────────────────────────

  /**
   * Collect language-server diagnostics for changed files.
   * Error-level diagnostics → failed + blocking (enter auto-fix).
   * Warning/info only → passed + non-blocking (soft advisory report).
   * Unavailable LSP / unsupported files → skipped silently (same spirit as type_check).
   */
  private async runLspDiagnostics(files: string[]): Promise<VerificationCheck> {
    const start = Date.now();
    // Do not maintain a second "supported extension" allow-list here. The
    // catalog and manager are the source of truth, so newly added/common
    // language servers automatically participate in post-edit validation.
    const targetFiles = files.slice(0, 20);

    if (targetFiles.length === 0) {
      return {
        name: "lsp",
        type: "lsp",
        status: "skipped",
        passed: false,
        output: "",
        duration: 0,
        errors: [],
        blocking: false,
        skipped: true,
        source: "lsp",
      };
    }

    try {
      const manager = await getLspManager(this.workspaceRoot);
      const errors: VerificationError[] = [];
      const outputLines: string[] = [];
      let anyClient = false;

      for (const file of targetFiles) {
        const client = manager.getClientForFile(file);
        if (!client) continue;
        anyClient = true;

        try {
          const abs = join(this.workspaceRoot, file);
          const content = await fs.readFile(abs, "utf8");
          await manager.openFile(file, content);
          const uri = manager.pathToUri(file);
          const diagnostics = await client.getDiagnostics(uri);
          for (const d of diagnostics) {
            const severity = mapLspSeverity(d.severity);
            errors.push({
              file,
              line: (d.range?.start?.line ?? 0) + 1,
              column: (d.range?.start?.character ?? 0) + 1,
              message: d.message,
              severity,
              code: d.code != null ? String(d.code) : undefined,
            });
            outputLines.push(
              `${file}:${(d.range?.start?.line ?? 0) + 1}:${(d.range?.start?.character ?? 0) + 1} ${severity}: ${d.message}`,
            );
          }
        } catch {
          // Per-file LSP failures should not abort the whole check.
        }
      }

      if (!anyClient) {
        return {
          name: "lsp",
          type: "lsp",
          status: "skipped",
          passed: false,
          output: "",
          duration: Date.now() - start,
          errors: [],
          blocking: false,
          skipped: true,
          source: "lsp",
        };
      }

      const hasError = errors.some((e) => e.severity === "error");
      const passed = !hasError;
      return {
        name: "lsp",
        type: "lsp",
        status: passed ? "passed" : "failed",
        passed,
        output: outputLines.join("\n"),
        duration: Date.now() - start,
        errors,
        blocking: hasError,
        skipped: false,
        source: "lsp",
      };
    } catch {
      // No language server available — silent skip (do not surface as failure).
      return {
        name: "lsp",
        type: "lsp",
        status: "skipped",
        passed: false,
        output: "",
        duration: Date.now() - start,
        errors: [],
        blocking: false,
        skipped: true,
        source: "lsp",
      };
    }
  }

  // ── Semantic Diff ───────────────────────────────────────

  private async analyzeSemanticDiff(files: string[]): Promise<VerificationCheck> {
    const start = Date.now();
    const diffs: SemanticDiff[] = [];

    for (const file of files.slice(0, 10)) {
      try {
        // Get git diff for the file
        const result = await this.sandboxExec(
          `git diff HEAD -- "${file}"`,
          { maxOutput: 50_000 },
        );
        if (result.exitCode === 0 && result.stdout.trim()) {
          const diff = this.parseUnifiedDiff(file, result.stdout);
          diffs.push(diff);
        }
      } catch {
        // File might not be in git
      }
    }

    const breakingChanges: string[] = [];
    for (const diff of diffs) {
      breakingChanges.push(...diff.breakingChanges);
    }

    // 「移除了导出」等是启发式提示，不能当验证失败：否则会耗尽自动修复并弹窗中断。
    return {
      name: "semantic_diff",
      type: "semantic_diff",
      status: "passed",
      passed: true,
      output: diffs.map((d) =>
        `${d.path}: +${d.additions} -${d.deletions} (${d.hunks.length} hunks)`
      ).join("\n"),
      duration: Date.now() - start,
      errors: breakingChanges.map((msg) => ({
        message: msg,
        severity: "warning" as const,
      })),
      blocking: false,
      skipped: false,
      source: "semantic_diff",
    };
  }

  private parseUnifiedDiff(path: string, diffText: string): SemanticDiff {
    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;
    const breakingChanges: string[] = [];

    const lines = diffText.split("\n");
    let currentHunk: DiffHunk | null = null;
    let hunkContent = "";

    for (const line of lines) {
      // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@
      const hunkMatch = line.match(/^@@\s+-(\d+),?(\d*)\s+\+(\d+),?(\d*)\s+@@/);
      if (hunkMatch) {
        if (currentHunk) {
          currentHunk.content = hunkContent.trim();
          hunks.push(currentHunk);
        }
        currentHunk = {
          oldStart: Number(hunkMatch[1]),
          oldLines: Number(hunkMatch[2] || 1),
          newStart: Number(hunkMatch[3]),
          newLines: Number(hunkMatch[4] || 1),
          content: "",
        };
        hunkContent = "";
        continue;
      }

      if (!currentHunk) continue;

      if (line.startsWith("+") && !line.startsWith("+++")) {
        additions++;
        hunkContent += line + "\n";

        // Detect potential breaking changes
        const code = line.slice(1).trim();
        if (/^(delete|remove|drop)\b/i.test(code)) {
          breakingChanges.push(`${path}: 删除了关键代码: ${code.slice(0, 80)}`);
        }
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        deletions++;
        hunkContent += line + "\n";
      } else if (!line.startsWith("diff") && !line.startsWith("index") && !line.startsWith("---")) {
        hunkContent += line + "\n";
      }
    }

    if (currentHunk) {
      currentHunk.content = hunkContent.trim();
      hunks.push(currentHunk);
    }

    // 同名导出在 +/- 两侧都出现 = 内容修改，不能报「移除了导出」。
    for (const code of unmatchedExportChanges(diffText).removed) {
      breakingChanges.push(`${path}: 移除了导出: ${code.slice(0, 80)}`);
    }

    return { path, additions, deletions, hunks, breakingChanges };
  }

  // ── Summary ─────────────────────────────────────────────

  private buildSummary(checks: VerificationCheck[], passed: boolean, size?: ProjectSizeInfo): string {
    const lines: string[] = [];
    lines.push(passed ? "✅ 所有验证通过" : "❌ 验证未通过");

    // Show project size info
    if (size) {
      const sizeLabel = size.category === "small" ? "小型"
        : size.category === "medium" ? "中型"
        : "大型";
      lines.push(`📊 项目规模: ${sizeLabel} (${size.sourceFileCount} 个源文件)`);
      if (size.category === "large") {
        lines.push("⚠️  大型项目已跳过全量类型检查，仅执行轻量验证");
      } else if (size.category === "medium") {
        lines.push("ℹ️  中型项目使用增量模式进行类型检查");
      }
    }

    lines.push("");

    const advisoryNotes: string[] = [];
    for (const check of checks) {
      const icon = check.skipped || check.status === "skipped" ? "⏭️" : check.passed ? "✅" : "❌";
      const label = check.skipped || check.status === "skipped" ? "跳过" : check.passed ? "通过" : "失败";
      lines.push(`${icon} ${check.name}: ${label} (${check.duration}ms)`);
      const isAdvisory =
        !check.skipped &&
        (check.type === "semantic_diff" || check.type === "lsp") &&
        check.blocking !== true &&
        check.errors.length > 0 &&
        check.errors.every((e) => e.severity !== "error");
      if (check.errors.length > 0) {
        for (const err of check.errors.slice(0, 5)) {
          const loc = err.file ? `${err.file}:${err.line ?? ""}` : "";
          lines.push(`   ${err.severity}: ${err.message} ${loc}`);
        }
        if (check.errors.length > 5) {
          lines.push(`   ... 还有 ${check.errors.length - 5} 个问题`);
        }
        if (isAdvisory) {
          advisoryNotes.push(
            ...check.errors.slice(0, 3).map((err) => `${check.name}: ${err.message}`),
          );
        }
      }
    }

    if (advisoryNotes.length > 0) {
      lines.push("");
      lines.push("ℹ️ 建议性诊断（不阻断任务，仅供参考）：");
      for (const note of advisoryNotes) {
        lines.push(`   - ${note}`);
      }
    }

    return lines.join("\n");
  }
}

// ── Types ──────────────────────────────────────────────────

function mapLspSeverity(severity: LspDiagnostic["severity"] | undefined): VerificationError["severity"] {
  switch (severity) {
    case 1: return "error";
    case 2: return "warning";
    default: return "info";
  }
}

interface ProjectType {
  typeChecker?: "tsc" | "mypy" | "cargo-check" | "go-vet";
  linter?: "eslint" | "ruff" | "clippy";
}

