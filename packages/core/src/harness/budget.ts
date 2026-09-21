import type { SystemWorkflowConfig, ContextConfig } from "@owncoder/settings";

// ── New interfaces ──────────────────────────────────────────────────────────

/**
 * Fixed (non-negotiable) segment sizes known at context-build time.
 *
 * - `systemPrompt`: the built-in system prompt template + tool definitions.
 *   This is the core instruction that is never trimmed.
 * - `platformInfo`: platform information (OS, shell, etc). Always sent.
 * - `promptOptimizer`: adaptive prompt optimizer output (performance feedback,
 *   failure patterns). Always sent, never truncated.
 * - `userInput`: the user's current message.
 * - `taskDecomposition`: output from task decomposition (when active).
 *
 * Optional/truncatable content (tech stack, project size, project rules) are
 * handled as candidates in the selection pipeline.
 *
 * The remaining budget is computed as:
 * `remaining = inputBudget - systemPrompt - platformInfo - promptOptimizer - userInput - taskDecomposition - activePlan`
 */
export interface FixedSegments {
  /** Built-in system prompt template + tool definitions. Never trimmed. */
  systemPrompt: number;
  /** Platform information (OS, shell, etc). Always sent. */
  platformInfo: number;
  /** Adaptive prompt optimizer output. Always sent, never truncated. */
  promptOptimizer: number;
  /** @reserved Tool definitions — currently included in systemPrompt. */
  toolDefs: number;
  /** User's input message. */
  userInput: number;
  /** Task decomposition output (when active). */
  taskDecomposition: number;
  /** Active plan content (when present). */
  activePlan: number;
  /** @reserved Document workflow state — currently 0. */
  documentWorkflow: number;
}

/** Actual token sizes of each dynamic segment, as measured at runtime. */
export interface SegmentActualSizes {
  history: number;
  toolResults: number;
  techStack: number;
}

/** Dynamic segment budgets allocated from the remaining input budget. */
export interface SegmentBudgets {
  history: number;
  toolResults: number;
  techStack: number;
}

/** Full context budget breakdown. */
export interface ContextBudget {
  inputBudget: number;
  outputBudget: number;
  fixedTotal: number;
  remaining: number;
  segments: SegmentBudgets;
  overCapacity: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Parse a context window string like "128K", "1M", or plain number. */
export function parseContextWindow(input: string | number): number | null {
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? input : null;
  const s = String(input).trim().toUpperCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([KM])?$/);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n) || n <= 0) return null;
  const suffix = m[2];
  if (suffix === "K") return Math.round(n * 1024);
  if (suffix === "M") return Math.round(n * 1024 * 1024);
  return Math.round(n);
}

// ── Core ────────────────────────────────────────────────────────────────────

/**
 * Redistribute unused budget from segments that have actual sizes smaller than
 * their allocation to segments that need more space.
 *
 * Algorithm:
 * 1. For each segment with known actual size: cap at actual, compute surplus.
 * 2. Redistribute surplus to segments that are over-allocated (actual > allocated),
 *    proportionally to their deficit.
 *
 * Example (remaining=100, ratios 50/50):
 *   Initial: history=50, toolResults=50
 *   Actual:  history=10, toolResults=90
 *   Result:  history=10, toolResults=90 (40 surplus → toolResults)
 */
export function redistributeBudgets(
  segments: SegmentBudgets,
  actuals: Partial<SegmentActualSizes>,
): SegmentBudgets {
  const keys = ["history", "toolResults", "techStack"] as const;
  type SegKey = typeof keys[number];

  // Phase 1: cap segments at their actual size, track surplus
  let surplus = 0;
  const capped: Record<SegKey, number> = { ...segments };
  const deficits: { key: SegKey; deficit: number }[] = [];

  for (const key of keys) {
    const actual = actuals[key];
    if (actual !== undefined && actual < segments[key]) {
      // This segment uses less than allocated → surplus
      surplus += segments[key] - actual;
      capped[key] = actual;
    } else if (actual !== undefined && actual > segments[key]) {
      // This segment needs more than allocated → deficit
      deficits.push({ key, deficit: actual - segments[key] });
    }
    // If actual === allocated or actual is undefined, keep as-is
  }

  // Phase 2: redistribute surplus to deficit segments proportionally
  if (surplus > 0 && deficits.length > 0) {
    const totalDeficit = deficits.reduce((sum, d) => sum + d.deficit, 0);
    let distributed = 0;

    for (let i = 0; i < deficits.length; i++) {
      const d = deficits[i]!;
      if (i === deficits.length - 1) {
        // Last segment gets remainder to avoid rounding loss
        capped[d.key] += surplus - distributed;
      } else {
        const share = Math.floor(surplus * (d.deficit / totalDeficit));
        capped[d.key] += share;
        distributed += share;
      }
    }
  }

  return {
    history: capped.history,
    toolResults: capped.toolResults,
    techStack: capped.techStack,
  };
}

/** Compute a token-based context budget from config + runtime fixed segments. */
export function computeContextBudget(
  config: ContextConfig,
  fixed: FixedSegments,
  actualSizes?: Partial<SegmentActualSizes>,
): ContextBudget {
  const contextWindow = config.contextWindow;
  const inputBudget = Math.floor(contextWindow * (config.inputRatio / 100));
  const outputBudget = contextWindow - inputBudget;

  const fixedTotal =
    fixed.systemPrompt +
    fixed.platformInfo +
    fixed.promptOptimizer +
    fixed.toolDefs +
    fixed.userInput +
    fixed.taskDecomposition +
    fixed.activePlan +
    fixed.documentWorkflow;

  const remaining = Math.max(0, inputBudget - fixedTotal);
  const overCapacity = fixedTotal > inputBudget;

  const seg = config.segments;
  // Allocate remaining budget across dynamic segments proportionally.
  const segSum = Math.max(
    1e-9,
    seg.historyRatio + seg.toolResultRatio + seg.techStackRatio,
  );

  let segments: SegmentBudgets = {
    history: Math.floor(remaining * (seg.historyRatio / segSum)),
    toolResults: Math.floor(remaining * (seg.toolResultRatio / segSum)),
    techStack: Math.floor(remaining * (seg.techStackRatio / segSum)),
  };

  // Dynamic redistribution: if actual sizes are known, redistribute unused budget.
  if (actualSizes) {
    segments = redistributeBudgets(segments, actualSizes);
  }

  return { inputBudget, outputBudget, fixedTotal, remaining, segments, overCapacity };
}

// ── Legacy bridge ───────────────────────────────────────────────────────────

/**
 * @deprecated Bridge: derive old char-based budget shape from new config.
 * Callers should migrate to `computeContextBudget()` + `FixedSegments`.
 *
 * **Known semantic gap**: `historyRatio` maps to the legacy `plan` budget,
 * which in `context.ts` controls `truncatePlanForContext()` — i.e. the active
 * plan document, NOT the conversation history. Increasing `historyRatio` will
 * enlarge the plan truncation budget, which may not be the user's intent.
 * This bridge exists only to avoid changing 20+ `budgets.xxx` call-sites at once.
 * Remove once all callers migrate to `computeContextBudget()`.
 */
export function contextBudgets(workflow: SystemWorkflowConfig): {
  total: number;
  system: number;
  plan: number;
  files: number;
  map: number;
} {
  const ctx = workflow.context;
  const inputBudget = Math.floor(ctx.contextWindow * (ctx.inputRatio / 100));
  const outputBudget = ctx.contextWindow - inputBudget;
  const total = inputBudget + outputBudget;

  const seg = ctx.segments;
  const segSum = Math.max(1e-9, seg.historyRatio + seg.toolResultRatio + seg.techStackRatio);
  const filesPct = seg.toolResultRatio / segSum;
  const mapPct = 0;
  const systemPct = seg.techStackRatio / segSum;
  const planPct = seg.historyRatio / segSum;

  return {
    total,
    system: Math.floor(total * systemPct),
    plan: Math.floor(total * planPct),
    files: Math.floor(total * filesPct),
    map: Math.floor(total * mapPct),
  };
}

// ── Utility ─────────────────────────────────────────────────────────────────

export function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20))}\n…(截断)`;
}
