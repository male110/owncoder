/**
 * React Loop Termination Logic
 * 
 * Design Philosophy:
 * - Trust the model's judgment by default (minimal nudging)
 * - Clear, explicit termination conditions (no hidden state)
 * - Early exit pattern (check termination first, execute last)
 * - Defense in depth (hard limits as safety nets)
 */

import type { ToolCall } from "@owncoder/llm";
import type { TaskItem } from "../../plans.js";
import { looksLikeContinuationIntent, looksLikeFinalReport } from "./continuation-intent.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LoopState {
  iteration: number;
  totalToolCalls: number;
  totalTokens: number;
  totalCost: number;
  
  // Tool execution tracking
  toolCallHistory: ToolCallRecord[];
  consecutiveTextOnlyTurns: number;
  
  // Task context (optional)
  currentTask?: TaskItem;
  
  // Model response
  lastFinishReason: string | null;
  lastContent: string;
  lastToolCalls: ToolCall[];
  
  // Output similarity tracking (for detecting repeated responses)
  previousContent: string;            // Content from previous iteration
  consecutiveSimilarOutputs: number;  // Count of similar consecutive outputs
  
  // 🔥 NEW: Exploration completion tracking
  explorationSkipCount: number;       // Count of exploration tools skipped
  lastIterationHadExplorationSkip: boolean; // Track if previous turn had skips
}

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  iteration: number;
}

export interface TerminationResult {
  shouldTerminate: true;
  reason: string;
  lastAssistant: string;
  aborted: boolean;
  /** True when termination is caused by a hard limit (iteration/tool/token/cost cap), not natural completion. */
  limitReached?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ContinueResult {
  shouldTerminate: false;
}

export type TerminationCheck = TerminationResult | ContinueResult;

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface TerminationConfig {
  // Hard limits (safety nets)
  maxIterations: number;              // Default: 30 (vs LangChain 15, your old 200)
  maxTotalToolCalls: number;          // Default: 100
  /** Kept for API compat; token budget check is disabled (cost is the sole spend guard). */
  maxTokensPerTurn: number;           // Default: Number.MAX_SAFE_INTEGER (effectively unlimited)
  maxCostPerTurn: number;             // Default: 15.0 USD
  
  // Loop detection
  maxSameToolRepeat: number;          // Default: 2 (same tool + args)
  maxConsecutiveTextOnly: number;     // Default: 2 (model keeps talking without tools)
  
  // 🚀 ADAPTIVE: Dynamic exploration termination (inspired by OpenAI Agents + Anthropic Computer Use)
  explorationTermination: {
    // Base threshold (low-complexity tasks)
    baseSkipThreshold: number;        // Default: 2
    // Task complexity multipliers (auto-detected)
    complexityMultipliers: {
      medium: number;                 // Default: 1.5
      high: number;                   // Default: 2.0
    };
    // Enable semantic similarity check (not just counter)
    enableSemanticCheck: boolean;     // Default: true
    // Similarity threshold for "truly stuck" detection
    semanticSimilarityThreshold: number; // Default: 0.85
    // Enable active reflection prompt
    enableReflectionPrompt: boolean;  // Default: true
    // Progress indicators required before termination
    requireProgressEvidence: boolean; // Default: true
  };
  
  enableOutputSimilarityCheck: boolean; // Default: true (detect repeated outputs)
  
  // Enabled checks
  enableStuckDetection: boolean;      // Default: true
  enableBudgetLimits: boolean;        // Default: true
  enableTaskValidation: boolean;      // Default: true
}

export const DEFAULT_TERMINATION_CONFIG: TerminationConfig = {
  maxIterations: 30,
  maxTotalToolCalls: 100,
  maxTokensPerTurn: Number.MAX_SAFE_INTEGER,
  maxCostPerTurn: 15.0,
  maxSameToolRepeat: 2,                    // Changed: 3 → 2 (detect loops earlier)
  maxConsecutiveTextOnly: 2,
  
  // 🚀 Adaptive exploration termination (world-class defaults)
  explorationTermination: {
    baseSkipThreshold: 2,
    complexityMultipliers: {
      medium: 1.5,
      high: 2.0,
    },
    enableSemanticCheck: true,
    semanticSimilarityThreshold: 0.85,
    enableReflectionPrompt: true,
    requireProgressEvidence: true,
  },
  
  enableStuckDetection: true,
  enableBudgetLimits: true,
  enableTaskValidation: true,
  enableOutputSimilarityCheck: true,       // New: detect repeated model outputs
};

/**
 * Create termination config with defaults
 */
export type TerminationConfigOverrides =
  Partial<Omit<TerminationConfig, "explorationTermination">> & {
    explorationTermination?: Partial<TerminationConfig["explorationTermination"]>;
  };

export function createTerminationConfig(
  overrides: TerminationConfigOverrides = {}
): TerminationConfig {
  const { explorationTermination, ...rest } = overrides;
  return {
    ...DEFAULT_TERMINATION_CONFIG,
    ...rest,
    explorationTermination: {
      ...DEFAULT_TERMINATION_CONFIG.explorationTermination,
      ...explorationTermination,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Termination Logic (Single Entry Point)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if the loop should terminate.
 * 
 * Order matters:
 * 1. Hard limits (safety nets) - always check first
 * 2. Natural completion (model says "done") - trust the model
 * 3. Stuck detection (loop patterns) - intervention only when necessary
 * 
 * Philosophy: Exit early and explicitly. Every return path is a documented decision.
 */
export function checkTermination(
  state: LoopState,
  config: TerminationConfig = DEFAULT_TERMINATION_CONFIG,
): TerminationCheck {
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Layer 1: Hard Limits (Safety Nets)
  // ═══════════════════════════════════════════════════════════════════════════
  
  // 1.1 Iteration hard cap
  if (state.iteration >= config.maxIterations) {
    return {
      shouldTerminate: true,
      reason: `Reached maximum iterations (${config.maxIterations})`,
      lastAssistant: state.lastContent || synthesizeFallbackResponse(state),
      aborted: false,
      limitReached: true,
      metadata: { iterations: state.iteration },
    };
  }
  
  // 1.2 Tool call hard cap
  if (state.totalToolCalls >= config.maxTotalToolCalls) {
    return {
      shouldTerminate: true,
      reason: `Reached maximum tool calls (${config.maxTotalToolCalls})`,
      lastAssistant: state.lastContent || synthesizeFallbackResponse(state),
      aborted: false,
      limitReached: true,
      metadata: { totalToolCalls: state.totalToolCalls },
    };
  }
  
  // 1.3 Cost budget limit (token budget intentionally omitted — cost is the sole spend guard)
  if (config.enableBudgetLimits && state.totalCost >= config.maxCostPerTurn) {
    return {
      shouldTerminate: true,
      reason: `Cost budget exceeded ($${state.totalCost.toFixed(2)}/$${config.maxCostPerTurn.toFixed(2)})`,
      lastAssistant: state.lastContent || synthesizeFallbackResponse(state),
      aborted: false,
      limitReached: true,
      metadata: { totalCost: state.totalCost },
    };
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Layer 2: Loop Detection (Prevent Infinite Loops)
  // ═══════════════════════════════════════════════════════════════════════════
  
  const unmetNeeds = hasUnmetInformationNeeds(state.currentTask);
  // 报告式收尾优先于“信息需求未满足”否决：否则模型已经写出最终报告时，
  // 相似输出 / 自然完成 / 连续纯文本收敛层全部被关掉，只能空转到硬上限
  // （与 react.ts 的 unmetNeedsContinue 预算及 looksLikeFinalReport 出口对齐）。
  const finalReport = looksLikeFinalReport(state.lastContent);

  // 2.1 Tool loop detection (same tool + args repeated)
  //     → Catches stuck patterns like: read → read → read
  if (config.enableStuckDetection) {
    const loopDetection = detectToolLoop(state.toolCallHistory, config.maxSameToolRepeat);
    if (loopDetection.isLoop) {
      return {
        shouldTerminate: true,
        reason: `Tool loop detected without progress: ${loopDetection.toolName} called ${loopDetection.count} times with the same result`,
        lastAssistant: state.lastContent || synthesizeFallbackResponse(state),
        aborted: true,
        metadata: { loopDetection, noProgress: true },
      };
    }
  }
  
  // 2.2 Output similarity detection (model keeps saying the same thing)
  //     → Catches stuck patterns like: "I need X" → "I need X" → "I need X"
  //     → consecutiveSimilarOutputs >= 1 means 2 similar outputs detected
  //     → Treat as normal completion: the model has converged on a final answer,
  //       so do NOT surface "Task may be incomplete" / error events.
  if (config.enableOutputSimilarityCheck && (!unmetNeeds || finalReport) && state.consecutiveSimilarOutputs >= 1) {
    return {
      shouldTerminate: true,
      reason: `Detected ${state.consecutiveSimilarOutputs + 1} consecutive similar outputs (threshold: 80%)`,
      lastAssistant: state.lastContent || synthesizeFallbackResponse(state),
      aborted: false,
      metadata: {
        consecutiveSimilarOutputs: state.consecutiveSimilarOutputs + 1,
        threshold: OUTPUT_SIMILARITY_THRESHOLD,
        normalCompletion: true,
      },
    };
  }
  
  // 2.3 Adaptive exploration-skip convergence (OpenAI Agents / Anthropic Computer Use)
  //     Counter is the primary signal; complexity scales the threshold.
  //     Semantic similarity and unmet evidence are guards against premature stop.
  const skipThreshold = resolveExplorationSkipThreshold(state, config);
  if (skipThreshold > 0 && state.explorationSkipCount >= skipThreshold) {
    const explorationCfg = config.explorationTermination;
    const complexity = state.currentTask?.estimatedComplexity ?? "low";

    if (!(explorationCfg.requireProgressEvidence && hasUnmetInformationNeeds(state.currentTask))) {
      const previous = state.previousContent.trim();
      const current = state.lastContent.trim();
      const similarity = previous && current
        ? calculateSimilarity(state.previousContent, state.lastContent)
        : 1;
      const semanticallyStuck =
        !explorationCfg.enableSemanticCheck ||
        previous.length === 0 ||
        similarity >= explorationCfg.semanticSimilarityThreshold ||
        state.consecutiveSimilarOutputs >= 1;

      if (semanticallyStuck) {
        return {
          shouldTerminate: true,
          reason: `Exploration complete after ${state.explorationSkipCount} skipped exploration calls (threshold: ${skipThreshold})`,
          lastAssistant: state.lastContent || synthesizeFallbackResponse(state),
          // Normal convergence, not an aborted/incomplete task: skipped calls are
          // redundant after exploration is complete and must not surface as errors.
          aborted: false,
          metadata: {
            explorationSkipCount: state.explorationSkipCount,
            threshold: skipThreshold,
            complexity,
            similarity,
            normalCompletion: true,
          },
        };
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Layer 3: Natural Completion (Trust the Model)
  // ═══════════════════════════════════════════════════════════════════════════
  
  // 3.1 Model returned text + no tool calls + finish_reason=stop
  //     → NORMAL exit, except when listed information needs are still unmet.
  if (
    state.lastFinishReason === "stop" &&
    state.lastToolCalls.length === 0 &&
    state.lastContent.trim()
  ) {
    // 3.1a 行动宣言不是最终报告（“现在跑测试……”）→ 继续循环。
    // 否则 react.ts 注入的纯文本 nudge 会在下一次迭代开头被这里提前截杀，
    // 模型永远看不到 nudge，任务停在“宣布了下一步”而不是“做完了”。
    if (isActionAnnouncement(state.lastContent)) {
      return { shouldTerminate: false };
    }
    // 簿记上的 unmet needs 不能否决已经写好的最终报告（证据被编辑失效、
    // outline/web 证据无法 verified 时尤为常见）。
    if (unmetNeeds && !finalReport) {
      return { shouldTerminate: false };
    }
    // 最终报告同样跳过 task validation：它与 unmetNeeds 检查同一套 evidence 簿记，
    // 否则报告出口会被 validation 再次否决，循环依旧停不下来。
    if (config.enableTaskValidation && state.currentTask && !finalReport) {
      const validation = validateTaskCompletion(state.currentTask, state.lastContent);
      if (!validation.isComplete) {
        return { shouldTerminate: false };
      }
    }
    return {
      shouldTerminate: true,
      reason: "Natural completion (model returned final response)",
      lastAssistant: state.lastContent,
      aborted: false,
    };
  }
  
  // 3.2 Model returned text without tools for N consecutive turns
  //     → After 2 consecutive text-only turns, treat as complete — unless
  //     information needs are still unmet (keep exploring until a hard limit).
  if (
    state.lastToolCalls.length === 0 &&
    state.lastContent.trim() &&
    state.consecutiveTextOnlyTurns >= config.maxConsecutiveTextOnly
  ) {
    // 行动宣言不算“只说不做”的结束意图：继续给模型执行机会，
    // 由 react.ts 的 nudge 预算（maxPostToolTextNudges）与 Layer 1/2 硬上限兜底。
    if (isActionAnnouncement(state.lastContent)) {
      return { shouldTerminate: false };
    }
    if (unmetNeeds && !finalReport) {
      return { shouldTerminate: false };
    }
    return {
      shouldTerminate: true,
      reason: `Model produced ${state.consecutiveTextOnlyTurns} consecutive text-only responses`,
      lastAssistant: state.lastContent,
      aborted: false,
      metadata: { consecutiveTextOnlyTurns: state.consecutiveTextOnlyTurns },
    };
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Default: Continue
  // ═══════════════════════════════════════════════════════════════════════════
  
  return { shouldTerminate: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_LOOP_WINDOW_SIZE = 6;               // Tool call history window for loop detection
const OUTPUT_SIMILARITY_THRESHOLD = 0.8;       // 80% word overlap = similar
const OUTPUT_SIMILARITY_RESET_THRESHOLD = 0.5; // 50% word overlap = reset counter
const HASH_SHIFT_BITS = 5;                     // String hash shift amount

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect if the agent is stuck in a tool call loop.
 * 
 * Pattern: same tool + same arguments called repeatedly within a short window.
 * 
 * @param history - Tool call history
 * @param maxRepeat - Maximum allowed repetitions (e.g., 2 means "first call + 2 repeats = 3 total calls")
 * @returns Detection result with loop status, tool name, and call count
 */
function resolveExplorationSkipThreshold(
  state: LoopState,
  config: TerminationConfig,
): number {
  const { baseSkipThreshold, complexityMultipliers } = config.explorationTermination;
  if (baseSkipThreshold <= 0) return 0;

  const complexity = state.currentTask?.estimatedComplexity ?? "low";
  const factor =
    complexity === "high"
      ? complexityMultipliers.high
      : complexity === "medium"
        ? complexityMultipliers.medium
        : 1;

  return Math.max(1, Math.round(baseSkipThreshold * factor));
}

/**
 * 行动宣言（“现在跑测试……”/“Let me verify…”）：表达了继续行动的意图且不是
 * 报告式收尾。这种文本被当成最终报告落库就是“循环提前终止”bug。
 */
function isActionAnnouncement(text: string): boolean {
  return looksLikeContinuationIntent(text) && !looksLikeFinalReport(text);
}

function hasUnmetInformationNeeds(task: LoopState["currentTask"]): boolean {
  if (!task?.informationNeeds?.length) return false;
  const satisfied = new Set(
    (task.evidence ?? []).map((item) => item.needId).filter((id): id is string => Boolean(id)),
  );
  if (task.informationNeeds.some((need) => !satisfied.has(need.id))) return true;
  return (task.stopReadingWhen ?? []).some(
    (criterion) =>
      criterion.requiredEvidenceIds.length > 0 &&
      !criterion.requiredEvidenceIds.every((needId) => satisfied.has(needId)),
  );
}

function detectToolLoop(
  history: ToolCallRecord[],
  maxRepeat: number,
): { isLoop: boolean; toolName?: string; count?: number } {
  // Need at least maxRepeat + 1 calls to detect a loop
  // E.g., maxRepeat=2 requires 3 calls (first + 2 repeats)
  const minCallsForDetection = maxRepeat + 1;
  
  if (history.length < minCallsForDetection) {
    return { isLoop: false };
  }
  
  // Build fingerprint: tool:args
  const recentCalls = history.slice(-TOOL_LOOP_WINDOW_SIZE);
  const fingerprints = new Map<string, number>();
  
  for (const call of recentCalls) {
    const fp = toolCallFingerprint(call.name, call.arguments, call.result);
    fingerprints.set(fp, (fingerprints.get(fp) ?? 0) + 1);
  }
  
  // Check if any fingerprint meets the threshold
  // count >= maxRepeat + 1 means: first call + maxRepeat repetitions
  for (const [fp, count] of fingerprints.entries()) {
    if (count >= minCallsForDetection) {
      const [toolName] = fp.split("::");
      return { isLoop: true, toolName, count };
    }
  }
  
  return { isLoop: false };
}

/** CJK Unified Ideographs — used to detect runs that whitespace tokenization cannot split. */
const HAS_CJK = /[\u3400-\u9fff]/;
const CJK_ONLY = /^[\u3400-\u9fff]+$/;

/**
 * Tokenize for Jaccard similarity.
 *
 * Latin text keeps the historical whitespace split so English 0.8 / 0.5
 * thresholds stay unchanged. CJK runs have no spaces, so they are expanded
 * into overlapping character bigrams (unigram if a run is a single ideograph).
 */
function tokenizeForSimilarity(text: string): Set<string> {
  const tokens = new Set<string>();
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 0);

  for (const word of words) {
    if (!HAS_CJK.test(word)) {
      tokens.add(word);
      continue;
    }

    const pieces = word.split(/([\u3400-\u9fff]+)/);
    for (const piece of pieces) {
      if (!piece) continue;
      if (CJK_ONLY.test(piece)) {
        if (piece.length === 1) {
          tokens.add(piece);
        } else {
          for (let i = 0; i < piece.length - 1; i++) {
            tokens.add(piece.slice(i, i + 2));
          }
        }
      } else {
        tokens.add(piece);
      }
    }
  }

  return tokens;
}

/**
 * Calculate semantic similarity between two strings.
 * 
 * Uses Jaccard similarity on token sets:
 * - Similarity = |A ∩ B| / |A ∪ B|
 * - Returns 0.0-1.0 (higher = more similar)
 * 
 * Optimizations:
 * - Fast path for empty or very different length texts
 * - Direct set operations without intermediate arrays
 * - Single-pass normalization
 */
function calculateSimilarity(text1: string, text2: string): number {
  // Fast path: both empty → 100% similar
  if (text1.length === 0 && text2.length === 0) {
    return 1.0;
  }
  
  // Fast path: one empty → 0% similar
  if (text1.length === 0 || text2.length === 0) {
    return 0;
  }
  
  // Fast path: length differs by > 50% → likely very different
  const maxLen = Math.max(text1.length, text2.length);
  const minLen = Math.min(text1.length, text2.length);
  if ((maxLen - minLen) / maxLen > 0.5) {
    return 0;
  }
  
  const words1 = tokenizeForSimilarity(text1);
  const words2 = tokenizeForSimilarity(text2);
  
  // Both normalized to empty → 100% similar
  if (words1.size === 0 && words2.size === 0) {
    return 1.0;
  }
  
  // One normalized to empty → 0% similar
  if (words1.size === 0 || words2.size === 0) {
    return 0;
  }
  
  // Calculate intersection size without creating intermediate array
  let intersectionSize = 0;
  for (const word of words1) {
    if (words2.has(word)) {
      intersectionSize++;
    }
  }
  
  // Union size = |A| + |B| - |A ∩ B|
  const unionSize = words1.size + words2.size - intersectionSize;
  
  return intersectionSize / unionSize;
}

/**
 * Generate a fingerprint for a tool call: tool_name::args_hash
 */
function toolCallFingerprint(name: string, args: Record<string, unknown>, result?: string): string {
  // Include the observed result so repeated identical requests that produce new
  // content (for example pagination or a changed file version) are progress.
  const normalized = normalizeArgs(args);
  const argsJson = JSON.stringify(normalized, Object.keys(normalized).sort());
  return `${name}::${simpleHash(argsJson)}::${simpleHash(result ?? "")}`;
}

/**
 * Normalize tool arguments to avoid false loop detection.
 * 
 * Normalization rules:
 * - path: lowercase + remove trailing slashes
 * - query/pattern: lowercase + trim (case-insensitive search)
 * - numbers: preserve integers, round floats to 3 decimals
 * - other: keep as-is
 * 
 * Examples:
 * - { path: "src/foo.ts", offset: 0 } → { path: "src/foo.ts", offset: 0 }
 * - { path: "src/foo.ts", offset: 1 } → different (legitimate pagination)
 * - { query: "Auth" } vs { query: "auth" } → same (case-insensitive)
 */
function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue;
    
    // Normalize paths (case-insensitive, remove trailing slashes)
    if (key === "path" && typeof value === "string") {
      normalized[key] = value.toLowerCase().replace(/[\/\\]+$/, "");
      continue;
    }
    
    // Normalize query strings (case-insensitive search)
    if ((key === "query" || key === "pattern") && typeof value === "string") {
      normalized[key] = value.toLowerCase().trim();
      continue;
    }
    
    // Normalize numbers (remove floating point noise)
    if (typeof value === "number") {
      normalized[key] = Number.isInteger(value) 
        ? value 
        : Math.round(value * 1000) / 1000;
      continue;
    }
    
    // Keep other values as-is
    normalized[key] = value;
  }
  
  return normalized;
}

/**
 * Simple string hash for fingerprinting (non-cryptographic).
 * Uses djb2 algorithm variant.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << HASH_SHIFT_BITS) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

/**
 * Validate if a task is complete based on its requirements.
 * 
 * Returns { isComplete: true } if:
 * - All information needs are satisfied (evidence collected)
 * - All stop-reading criteria are met
 * - Acceptance criteria are fulfilled (if defined)
 */
function validateTaskCompletion(
  task: TaskItem,
  _modelResponse: string,
): { isComplete: boolean; missingNeeds?: string[]; reason?: string } {
  // If task has no explicit requirements, trust the model
  if (!task.informationNeeds || task.informationNeeds.length === 0) {
    return { isComplete: true };
  }
  
  // Check information needs
  const satisfiedNeeds = new Set(
    task.evidence.map(e => e.needId)
  );
  
  const missingNeeds = task.informationNeeds
    .filter(need => !satisfiedNeeds.has(need.id))
    .map(need => need.id);
  
  if (missingNeeds.length > 0) {
    return {
      isComplete: false,
      missingNeeds,
      reason: `Unmet information needs: ${missingNeeds.join(", ")}`
    };
  }
  
  // Check stop-reading criteria
  if (task.stopReadingWhen && task.stopReadingWhen.length > 0) {
    for (const criterion of task.stopReadingWhen) {
      // Skip criteria without evidence requirements
      if (!criterion.requiredEvidenceIds || criterion.requiredEvidenceIds.length === 0) {
        continue;
      }
      
      const allEvidenceMet = criterion.requiredEvidenceIds.every(
        needId => satisfiedNeeds.has(needId)
      );
      if (!allEvidenceMet) {
        return {
          isComplete: false,
          reason: `Stop-reading criterion not met: ${criterion.condition}`
        };
      }
    }
  }
  
  return { isComplete: true };
}

/**
 * Synthesize a fallback response when the model didn't produce text.
 * 
 * Use this as a last resort when terminating without model output.
 */
function synthesizeFallbackResponse(state: LoopState): string {
  if (state.toolCallHistory.length === 0) {
    return "Task started but no actions were taken.";
  }
  
  const lastTool = state.toolCallHistory[state.toolCallHistory.length - 1];
  if (!lastTool) {
    return "Task completed.";
  }
  
  // Summarize based on last tool call
  if (lastTool.name === "report_blocker") {
    return lastTool.result.slice(0, 500);
  }
  
  if (["write_file", "apply_patch", "save_plan"].includes(lastTool.name)) {
    return `Completed file operations. Last action: ${lastTool.name}.`;
  }
  
  return `Task reached iteration limit after ${state.iteration} steps. Last tool: ${lastTool.name}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// State Tracking Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create initial loop state.
 */
export function createLoopState(currentTask?: TaskItem): LoopState {
  return {
    iteration: 0,
    totalToolCalls: 0,
    totalTokens: 0,
    totalCost: 0,
    toolCallHistory: [],
    consecutiveTextOnlyTurns: 0,
    currentTask,
    lastFinishReason: null,
    lastContent: "",
    lastToolCalls: [],
    previousContent: "",
    consecutiveSimilarOutputs: 0,
    explorationSkipCount: 0,           // 🔥 NEW
    lastIterationHadExplorationSkip: false, // 🔥 NEW
  };
}

/**
 * Clear per-task convergence signals when advancing to the next task.
 * Similarity / text-only / natural-stop / exploration-skip state must not
 * carry across tasks, or the next task would be treated as already finished.
 */
export function resetOutputTrackingForNewTask(state: LoopState): void {
  state.consecutiveSimilarOutputs = 0;
  state.consecutiveTextOnlyTurns = 0;
  state.previousContent = "";
  state.lastContent = "";
  state.lastFinishReason = null;
  state.lastToolCalls = [];
  state.explorationSkipCount = 0;
  state.lastIterationHadExplorationSkip = false;
}

/**
 * Update state after a model response.
 */
export function updateStateAfterResponse(
  state: LoopState,
  response: {
    content: string;
    toolCalls: ToolCall[];
    finishReason: string | null;
    tokens: number;
    cost: number;
  }
): void {
  state.iteration += 1;
  
  // Track output similarity before updating content
  const hasCurrentContent = response.content.trim().length > 0;
  // lastContent is the immediately preceding response. previousContent is
  // retained for history/debugging and is one additional turn behind.
  const hasPreviousContent = state.lastContent.trim().length > 0;
  
  if (hasCurrentContent && hasPreviousContent) {
    const similarity = calculateSimilarity(state.lastContent, response.content);
    
    if (similarity >= OUTPUT_SIMILARITY_THRESHOLD) {
      // High similarity (>= 80%) → increment counter
      state.consecutiveSimilarOutputs += 1;
    } else if (similarity < OUTPUT_SIMILARITY_RESET_THRESHOLD) {
      // Low similarity (< 50%) → reset counter
      state.consecutiveSimilarOutputs = 0;
    }
    // else: Medium similarity (50-80%) → keep counter unchanged (transition content)
  } else if (hasCurrentContent || hasPreviousContent) {
    // One side empty, other non-empty → reset
    state.consecutiveSimilarOutputs = 0;
  }
  // else: both empty → keep counter unchanged (consecutive empty responses)
  
  // Move current content to previous before updating
  state.previousContent = state.lastContent;
  
  state.lastFinishReason = response.finishReason;
  state.lastContent = response.content;
  state.lastToolCalls = response.toolCalls;
  state.totalTokens += response.tokens;
  state.totalCost += response.cost;
  
  // Track consecutive text-only turns
  if (response.toolCalls.length === 0 && response.content.trim()) {
    state.consecutiveTextOnlyTurns += 1;
  } else {
    state.consecutiveTextOnlyTurns = 0;
  }
}

/**
 * Update state after tool execution.
 */
export function updateStateAfterTools(
  state: LoopState,
  results: Array<{ name: string; arguments: Record<string, unknown>; result: string }>
): void {
  state.totalToolCalls += results.length;
  
  for (const { name, arguments: args, result } of results) {
    state.toolCallHistory.push({
      name,
      arguments: args,
      result,
      iteration: state.iteration,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export {
  type TaskItem,
  type TaskEvidence,
} from "../../plans.js";
