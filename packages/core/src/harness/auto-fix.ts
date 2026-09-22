/**
 * Auto-Fix Loop — Execution-Grounded Verification with Auto-Correction
 *
 * Inspired by GitHub Copilot Agent Mode's auto-correct capability:
 *   1. After file-modifying tools execute → auto-run type check
 *   2. Parse errors → structured error report
 *   3. Inject errors back into conversation context
 *   4. Let the model produce a fix in the next iteration
 *   5. Max 3 fix attempts per step, then escalate to the user
 *
 * This creates a verify→fix→re-verify closed loop that mimics
 * a human developer's "make change → build → fix → build" cycle.
 */

import { VerificationEngine, type VerificationResult } from "./verification.ts";
import type { ChatMessage } from "@owncoder/llm";

// ── Types ──────────────────────────────────────────────────

/** File-modifying tool names that should trigger verification */
export const FILE_MODIFYING_TOOLS = new Set([
  "write_file",
  "append_file",
  "apply_patch",
  "replace_in_file",
]);

export interface AutoFixResult {
  /** Whether all errors were resolved */
  resolved: boolean;
  /** Number of fix attempts made */
  attempts: number;
  /** The final verification result (after all fix attempts) */
  finalVerification: VerificationResult | null;
  /** Messages to inject into the conversation for context */
  injectedMessages: ChatMessage[];
  /** Summary of what happened */
  summary: string;
  /** Whether the repair budget is exhausted and the task must terminate. */
  exhausted: boolean;
  /** Whether this was skipped (no errors, no verification needed) */
  skipped: boolean;
}

export interface AutoFixConfig {
  /** Max auto-fix attempts per step */
  maxAttempts?: number;
  /** Whether to auto-run type check after file writes */
  autoTypeCheck?: boolean;
  /** Maximum time (ms) for each verification run */
  verificationTimeout?: number;
  /** Callback for emitting status events */
  onEvent?: (e: { type: "fix_start" | "fix_end" | "fix_error"; message: string }) => void;
}

const DEFAULT_CONFIG: Required<AutoFixConfig> = {
  maxAttempts: 3,
  autoTypeCheck: true,
  verificationTimeout: 120_000,
  onEvent: () => {},
};

// ── Track state across loop iterations ──

export interface AutoFixState {
  /** Files modified in the current step (for targeted verification) */
  dirtyFiles: string[];
  /** How many fix attempts have been made for the current step */
  fixAttempts: number;
  /** Whether there are unresolved errors from the last verification */
  hasUnresolvedErrors: boolean;
  /** Last verification result for error context */
  lastErrors: string;
}

export function createAutoFixState(): AutoFixState {
  return {
    dirtyFiles: [],
    fixAttempts: 0,
    hasUnresolvedErrors: false,
    lastErrors: "",
  };
}

const ADVISORY_CHECK_TYPES = new Set(["semantic_diff", "lsp"]);

/** semantic_diff / lsp warning 等建议性检查：不阻断任务、不弹窗。 */
export function isAdvisoryVerificationResult(result: VerificationResult | null | undefined): boolean {
  if (!result || result.checks.length === 0) return false;
  // 收窄：必须全部是非阻断的建议性检查（semantic_diff / lsp warning），且没有任何 error 级问题。
  // 硬检查（typecheck/lint/execution）与 lsp error 即使被误标也不能降级为 advisory。
  return result.checks.every((check) => {
    if (check.skipped) return true;
    if (!ADVISORY_CHECK_TYPES.has(check.type)) return false;
    if (check.blocking === true) return false;
    if (check.errors.some((error) => error.severity === "error")) return false;
    // 无错误的纯通过结果不算 advisory（走正常 passed 路径即可）
    return check.errors.length > 0 && check.errors.every((error) => error.severity !== "error");
  }) && result.checks.some((check) => !check.skipped && ADVISORY_CHECK_TYPES.has(check.type) && check.errors.length > 0);
}

// ── Main Auto-Fix Loop ─────────────────────────────────────

/**
 * Run the auto-fix loop after tool execution:
 * checks → fix → re-check → fix → ... (up to maxAttempts)
 *
 * This should be called from within the ReAct loop after all tools
 * from a single iteration have been executed, but before the next
 * LLM call generates the next set of tool calls.
 *
 * Returns messages to inject, or empty if everything is clean.
 */
export async function autoFixAfterTools(
  workspaceRoot: string,
  dirtyFiles: string[],
  state: AutoFixState,
  config?: AutoFixConfig,
): Promise<AutoFixResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // No dirty files → nothing to verify
  if (dirtyFiles.length === 0) {
    return {
      resolved: true,
      attempts: 0,
      finalVerification: null,
      injectedMessages: [],
      summary: "",
      exhausted: false,
      skipped: true,
    };
  }

  // Track dirty files
  for (const f of dirtyFiles) {
    if (!state.dirtyFiles.includes(f)) {
      state.dirtyFiles.push(f);
    }
  }

  // Only run verification if there are file-modifying tools
  if (!cfg.autoTypeCheck) {
    return {
      resolved: true,
      attempts: 0,
      finalVerification: null,
      injectedMessages: [],
      summary: "",
      exhausted: false,
      skipped: true,
    };
  }

  state.fixAttempts++;
  cfg.onEvent?.({ type: "fix_start", message: `自动验证中... (第 ${state.fixAttempts} 次)` });

  try {
    const engine = new VerificationEngine(workspaceRoot, {
      timeout: cfg.verificationTimeout,
    });

    const result = await engine.verify(state.dirtyFiles);

    if (result.passed || isAdvisoryVerificationResult(result)) {
      // ✅ 硬检查通过，或只剩 semantic_diff / lsp warning 等建议性诊断 — 不阻断、不耗尽修复预算。
      const attempts = state.fixAttempts;
      state.dirtyFiles = [];
      state.fixAttempts = 0;
      state.hasUnresolvedErrors = false;
      state.lastErrors = "";
      const hasAdvisory = isAdvisoryVerificationResult(result);
      cfg.onEvent?.({
        type: "fix_end",
        message: hasAdvisory ? "✅ 验证通过（含建议性诊断，不阻断）" : "✅ 验证通过",
      });

      return {
        resolved: true,
        attempts,
        finalVerification: result,
        // 建议性诊断只留在验证报告（summary / checks.errors），不再注入对话气泡。
        injectedMessages: [],
        summary: result.summary,
        exhausted: false,
        skipped: false,
      };
    }

    // ❌ Verification failed
    state.hasUnresolvedErrors = true;
    state.lastErrors = result.summary;

    if (state.fixAttempts < cfg.maxAttempts) {
      // ⚠️ Has fix attempts remaining — inject errors for the model to fix
      const errorSummary = buildErrorSummary(result);
      cfg.onEvent?.({ type: "fix_error", message: `❌ 验证失败 (${state.fixAttempts}/${cfg.maxAttempts})，注入错误上下文` });

      return {
        resolved: false,
        attempts: state.fixAttempts,
        finalVerification: result,
        injectedMessages: [
          {
            role: "system",
            content: buildAutoFixPrompt(state, errorSummary, cfg.maxAttempts),
          },
        ],
        summary: errorSummary,
        exhausted: false,
        skipped: false,
      };
    }

    // 🚫 Max attempts reached — terminate via blockedReason; do not inject
    // messages the caller will never consume after exhausted=true.
    const errorSummary = buildErrorSummary(result);
    cfg.onEvent?.({ type: "fix_error", message: `❌ 达到最大修复次数 (${cfg.maxAttempts})，报告错误` });

    return {
      resolved: false,
      attempts: state.fixAttempts,
      finalVerification: result,
      injectedMessages: [],
      summary: errorSummary,
      exhausted: true,
      skipped: false,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const summary = `验证执行失败: ${msg}`;
    cfg.onEvent?.({ type: "fix_error", message: `验证异常: ${msg}` });

    // Verification infrastructure failures are retryable — do not burn the
    // whole repair budget as "exhausted" on a transient engine/tool error.
    if (state.fixAttempts < cfg.maxAttempts) {
      state.hasUnresolvedErrors = true;
      state.lastErrors = summary;
      return {
        resolved: false,
        attempts: state.fixAttempts,
        finalVerification: null,
        injectedMessages: [
          {
            role: "system",
            content: [
              `## ⚠️ 自动验证异常 (第 ${state.fixAttempts}/${cfg.maxAttempts} 次)`,
              ``,
              `验证引擎执行失败，尚未确认代码是否有问题：`,
              summary,
              ``,
              `请检查刚才的修改是否引入了语法/配置错误；必要时用 read_file 核对改动后再继续。`,
              state.fixAttempts >= cfg.maxAttempts - 1
                ? `⚠️ 这是最后一次修复机会。如果这次仍失败，任务将终止并报告给用户。`
                : `你还有 ${cfg.maxAttempts - state.fixAttempts} 次修复尝试。`,
            ].join("\n"),
          },
        ],
        summary,
        exhausted: false,
        skipped: false,
      };
    }

    return {
      resolved: false,
      attempts: state.fixAttempts,
      finalVerification: null,
      injectedMessages: [],
      summary,
      exhausted: true,
      skipped: false,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Extract dirty file paths from tool calls that modify files.
 */
export function getDirtyFiles(
  calls: Array<{ name: string; arguments?: Record<string, unknown> }>,
): string[] {
  const dirty: string[] = [];
  for (const call of calls) {
    if (!FILE_MODIFYING_TOOLS.has(call.name)) continue;
    const path = (call.arguments?.path ?? call.arguments?.file ?? call.arguments?.target) as string | undefined;
    if (path) dirty.push(path);
  }
  return [...new Set(dirty)];
}

/**
 * Build a human-readable error summary from verification results.
 */
function buildErrorSummary(result: VerificationResult): string {
  const lines: string[] = [];
  // Include hard failures, plus advisory checks that still have diagnostics to report.
  const relevantChecks = result.checks.filter(
    (c) => (!c.skipped && !c.passed) || (!c.skipped && ADVISORY_CHECK_TYPES.has(c.type) && c.errors.length > 0),
  );

  if (relevantChecks.length === 0) return "未发现检查失败";

  for (const check of relevantChecks) {
    const advisoryTag = ADVISORY_CHECK_TYPES.has(check.type) && check.blocking === false ? " · 建议性" : "";
    lines.push(`### ${check.name} (${check.type}${advisoryTag})`);
    for (const err of check.errors.slice(0, 8)) {
      const loc = err.file
        ? `\`${err.file}${err.line ? `:${err.line}` : ""}${err.column ? `:${err.column}` : ""}\``
        : "";
      const prefix = err.severity === "error" ? "🔴" : "⚠️";
      lines.push(`${prefix} ${err.message} ${loc}`);
    }
    if (check.errors.length > 8) {
      lines.push(`... 还有 ${check.errors.length - 8} 个问题`);
    }
  }

  return lines.join("\n");
}

/**
 * Build the auto-fix injection prompt for the model.
 */
function buildAutoFixPrompt(state: AutoFixState, errorSummary: string, maxAttempts: number): string {
  return [
    `## ⚠️ 自动验证失败 (第 ${state.fixAttempts}/${maxAttempts} 次修复尝试)`,
    ``,
    `你刚才的代码修改导致以下错误：`,
    ``,
    errorSummary,
    ``,
    `### 接下来应该做什么`,
    `1. 逐个分析错误的根因；如果错误涉及的代码不在上下文中，先用 read_file 查看报错位置`,
    `2. 只修复你引入的错误，不要修改不相关的代码，也不要用删除功能或绕过检查的方式“修复”`,
    `3. 用 apply_patch 修复已有文件（仅新文件才用 write_file）`,
    `4. 修复完成后停止调用工具，我会重新验证`,
    `5. 如果报错含义不清楚、仓库里没有对应文档，或这是第 2 次及以上修复尝试，先用 web_search 搜索完整报错再改，不要靠猜测连改`,
    ``,
    state.fixAttempts >= maxAttempts - 1
      ? `⚠️ 这是最后一次修复机会。如果这次失败，错误将被报告给用户。`
      : `你还有 ${maxAttempts - state.fixAttempts} 次修复尝试。`,
    ``,
    `修改的文件: ${state.dirtyFiles.map((f) => `\`${f}\``).join(", ") || "未知"}`,
  ].join("\n");
}
