/**
 * ReAct 步骤配置查询与循环控制常量。
 *
 * 从 react.ts 拆分：ReactSteps 参数查询 helper、探索完成判定、
 * 工具名模糊匹配（编辑距离），以及循环终止/只读转换相关阈值常量。
 * 本模块为纯函数模块，不依赖 react.ts。
 */
import { defaultReactSteps, type ReactStepConfig } from "@owncoder/settings";
import type { TaskItem } from "../../plans.ts";

/** Look up a single step's config from the node's reactSteps, falling back to defaults. */
function getStepConfig(steps: ReactStepConfig[], id: string): ReactStepConfig {
  return steps.find((s) => s.id === id) ?? defaultReactSteps().find((s: ReactStepConfig) => s.id === id)!;
}

/** Return numeric param from a step, with a module-level fallback value. */
export function stepNum(steps: ReactStepConfig[], id: string, key: string, fallback: number): number {
  const step = getStepConfig(steps, id);
  if (!step || step.enabled === false) return fallback;
  const v = step.params[key];
  return typeof v === "number" ? v : fallback;
}

/** Return boolean param from a step, with a fallback. */
export function stepBool(steps: ReactStepConfig[], id: string, key: string, fallback: boolean): boolean {
  const step = getStepConfig(steps, id);
  if (!step || step.enabled === false) return fallback;
  const v = step.params[key];
  return typeof v === "boolean" ? v : fallback;
}

/** Is a given step enabled? Defaults to true. */
export function stepEnabled(steps: ReactStepConfig[], id: string): boolean {
  const step = steps.find((s) => s.id === id);
  return step?.enabled !== false;
}

/**
 * Check if exploration is complete for a given task.
 * A task's exploration is considered complete when it has reached a terminal status
 * (completed, failed, or skipped) or when sufficient evidence has been gathered.
 * Returns true if no further exploration is needed for this task.
 */
export function isExplorationComplete(task: TaskItem): boolean {
  // Task is complete if it has reached a terminal status
  if (task.status === "completed" || task.status === "failed" || task.status === "skipped") {
    return true;
  }
  // For in-progress or pending tasks, exploration is not complete
  return false;
}

/**
 * Find the closest known tool name via simple edit-distance so we can give
 * the model a concrete suggestion instead of dumping the full tool list.
 */
export function findClosestToolName(candidate: string, known: Set<string>): string | null {
  let best = null as string | null;
  let bestDist = Infinity;
  const lower = candidate.toLowerCase();
  for (const name of known) {
    // Prefer exact match on known aliases
    if (lower === name.toLowerCase()) return name;
    const dist = levenshtein(lower, name.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  // Only suggest when it's a plausible typo, not a completely different name
  return bestDist <= 3 ? best : null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! : 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Max identical tool+args+result calls before termination treats it as a loop. */
export const MAX_REPEAT_TOOL_CALLS = 2;
/** Hard cap on total tool invocations across the entire loop (fed to termination). */
export const MAX_TOTAL_TOOL_CALLS = 100;

/** Max consecutive iterations where the model produces ONLY read-only tool calls (no text content).
 *  This catches infinite exploration/browsing loops where the model calls list_dir/read_file
 *  with different paths each time, evading the fingerprint-based repeat detection. */
export const MAX_CONSECUTIVE_READONLY_ITERS = 6;
/** Soft transition threshold: when consecutive read-only iterations reach this
 *  count, inject a nudge pushing the model from exploration to implementation.
 *  Set to half the hard cap — gives the model a warning before checkTermination.
 *  This directly addresses the "总中断" bug where the agent keeps exploring
 *  without transitioning to implementation. */
export const READONLY_TRANSITION_THRESHOLD = 3;

// READONLY_TOOLS 已迁移到 enhanced-tools.ts：从各工具定义的 readOnly 标记派生，
// 避免手写名单与清单漂移（旧的 search_code 死别名、漏掉 list_specs / list_sdd /
// list_memories / list_session_changes）。

/** File-modifying tool names (used to push user-visible action summaries to the conversation stream, solving the silent-execution problem). */
export const USER_FACING_WRITE_TOOLS = new Set(["save_spec", "save_design", "save_tasks", "write_file", "apply_patch"]);
export const READ_INVALIDATING_TOOLS = new Set(["write_file", "apply_patch", "append_file", "replace_in_file"]);

/** Source-content read tools whose per-file repeat count is capped by maxSameFileReads. */
export const SOURCE_READ_TOOLS = new Set(["read_file", "read_symbol", "read_outline"]);
/** Default cap on reads of the same file within one task (overridable via stuck_detect.maxReadCount). */
export const MAX_SAME_FILE_READS = 3;
