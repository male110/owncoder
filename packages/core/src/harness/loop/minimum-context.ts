/**
 * Task-aware selection of the smallest useful initial context.
 *
 * This module intentionally has no filesystem, model, or tool dependencies.
 * It plans which already-collected context blocks should be materialized; it
 * never treats indexed excerpts as verified current source and never rewrites
 * an explicit tool request.
 */

import upath from "upath";

export type ContextSelectionMode = "off" | "observe" | "apply";
export type ContextIntent = "change" | "debug" | "inspect" | "plan" | "unknown";
export type ContextFreshness = "current" | "indexed" | "unknown";
export type ContextSource =
  | "memory"
  | "knowledge"
  | "short-term"
  | "mention"
  | "retrieval"
  | "plan"
  | "todo"
  | "workflow"
  | "repo-map"
  | "deps"
  | "tech-stack"
  | "project-size"
  | "rules";

export interface ContextTaskSignal {
  mode: string;
  intent: ContextIntent;
  query: string;
  explicitPaths: string[];
  activePaths: string[];
}

export interface ContextCandidate {
  id: string;
  source: ContextSource;
  content: string;
  estimatedTokens: number;
  provenance: string;
  path?: string;
  freshness?: ContextFreshness;
  /** Mandatory candidates survive budget pressure to preserve user intent and safety context. */
  mandatory?: boolean;
}

export interface MinimumContextConfig {
  mode: ContextSelectionMode;
  /** Applies to optional candidates only; mandatory candidates are never silently removed. */
  tokenBudget: number;
  /** Maximum selected candidates; mandatory candidates may exceed this cap. */
  maxCandidates: number;
  emitDecisionTrace: boolean;
}

export type ContextOmissionReason = "empty" | "budget" | "redundant" | "max-candidates";

export interface OmittedContextCandidate {
  id: string;
  source: ContextSource;
  reason: ContextOmissionReason;
}

export interface MinimumContextPlan {
  mode: ContextSelectionMode;
  tokenBudget: number;
  estimatedTokens: number;
  selected: ContextCandidate[];
  omitted: OmittedContextCandidate[];
  /** Indexed excerpts that can navigate an edit but cannot replace a fresh read. */
  requiresFreshRead: string[];
}

const DEFAULT_MAX_CANDIDATES = 24;
const MAX_CANDIDATES = 100;
const REDUNDANT_SIMILARITY = 0.88;

const SOURCE_VALUE: Record<ContextSource, number> = {
  memory: 54,
  knowledge: 50,
  "short-term": 48,
  mention: 120,
  retrieval: 66,
  plan: 118,
  todo: 112,
  workflow: 116,
  "repo-map": 72,
  deps: 28,
  "tech-stack": 35,
  "project-size": 38,
  rules: 60,
};

const CHANGE_QUERY = /\b(?:add|change|create|delete|fix|implement|modify|refactor|remove|rename|update|write)\b|实现|修改|修复|添加|删除|重构|更新|开发|编写|改造/i;
const DEBUG_QUERY = /\b(?:bug|crash|debug|error|exception|fail|failure|regression)\b|报错|错误|异常|失败|崩溃|调试/i;
const INSPECT_QUERY = /\b(?:analy[sz]e|explain|find|how|inspect|locate|search|what|where|why)\b|分析|是什么|为什么|怎么|查看|寻找|搜索|解释/i;
const DEPENDENCY_QUERY = /\b(?:dependency|dependencies|package|version)\b|依赖|包|版本/i;

/** Infer only a low-confidence routing hint. Explicit paths and active work remain stronger signals. */
export function inferTaskIntent(query: string, mode: string): ContextIntent {
  if (mode === "plan") return "plan";
  if (CHANGE_QUERY.test(query)) return "change";
  if (DEBUG_QUERY.test(query)) return "debug";
  if (INSPECT_QUERY.test(query)) return "inspect";
  return "unknown";
}

/** Parse the optional pipeline parameter without making old persisted workflows invalid. */
export function resolveMinimumContextConfig(
  raw: unknown,
  fallbackTokenBudget: number,
): MinimumContextConfig {
  const fallbackBudget = Math.max(0, Math.floor(fallbackTokenBudget));
  if (raw === false) {
    return {
      mode: "off",
      tokenBudget: fallbackBudget,
      maxCandidates: DEFAULT_MAX_CANDIDATES,
      emitDecisionTrace: false,
    };
  }

  const record = isRecord(raw) ? raw : {};
  const mode = isSelectionMode(record.mode) ? record.mode : "apply";
  return {
    mode,
    tokenBudget: boundedInteger(record.tokenBudget, fallbackBudget, 0, 200_000),
    maxCandidates: boundedInteger(record.maxCandidates, DEFAULT_MAX_CANDIDATES, 1, MAX_CANDIDATES),
    emitDecisionTrace: record.emitDecisionTrace === true,
  };
}

/**
 * Plan a deterministic, budget-bounded set of initial-context blocks.
 *
 * The planner does not mutate candidates or contents. In `observe` mode callers
 * can inspect the returned decision while materializing their previous context.
 */
export function planMinimumContext(input: {
  task: ContextTaskSignal;
  candidates: readonly ContextCandidate[];
  config: MinimumContextConfig;
}): MinimumContextPlan {
  const { task, candidates, config } = input;
  const usable: ContextCandidate[] = [];
  const omitted: OmittedContextCandidate[] = [];

  for (const candidate of candidates) {
    if (!candidate.content.trim()) {
      omitted.push({ id: candidate.id, source: candidate.source, reason: "empty" });
      continue;
    }
    usable.push(normalizeCandidate(candidate));
  }

  if (config.mode === "off") {
    return finalizePlan(config, task, usable, omitted);
  }

  const selected: ScoredCandidate[] = [];
  const mandatory = usable.filter((candidate) => candidate.mandatory);
  for (const candidate of mandatory) {
    selected.push({ candidate, utility: candidateUtility(candidate, task) });
  }

  let remainingTokens = Math.max(
    0,
    config.tokenBudget - selected.reduce((total, item) => total + item.candidate.estimatedTokens, 0),
  );
  let remainingSlots = Math.max(0, config.maxCandidates - mandatory.length);

  const optional = usable
    .filter((candidate) => !candidate.mandatory)
    .map((candidate) => ({ candidate, utility: candidateUtility(candidate, task) }))
    .sort((left, right) => {
      const efficiencyDelta = efficiency(right) - efficiency(left);
      if (efficiencyDelta !== 0) return efficiencyDelta;
      const utilityDelta = right.utility - left.utility;
      if (utilityDelta !== 0) return utilityDelta;
      return left.candidate.id.localeCompare(right.candidate.id);
    });

  for (const item of optional) {
    if (remainingSlots === 0) {
      omitted.push({ id: item.candidate.id, source: item.candidate.source, reason: "max-candidates" });
      continue;
    }
    if (item.candidate.estimatedTokens > remainingTokens) {
      omitted.push({ id: item.candidate.id, source: item.candidate.source, reason: "budget" });
      continue;
    }
    if (isRedundant(item, selected)) {
      omitted.push({ id: item.candidate.id, source: item.candidate.source, reason: "redundant" });
      continue;
    }

    selected.push(item);
    remainingTokens -= item.candidate.estimatedTokens;
    remainingSlots -= 1;
  }

  // Preserve the caller's presentation order. Ranking chooses candidates; it
  // must not reorder system-context semantics or hide low-level provenance.
  const selectedIds = new Set(selected.map((item) => item.candidate.id));
  const selectedInOrder = usable.filter((candidate) => selectedIds.has(candidate.id));
  return finalizePlan(config, task, selectedInOrder, omitted);
}

/** A content-free telemetry shape suitable for logs and future observability. */
export function summarizeMinimumContextPlan(plan: MinimumContextPlan): Record<string, unknown> {
  return {
    mode: plan.mode,
    tokenBudget: plan.tokenBudget,
    estimatedTokens: plan.estimatedTokens,
    selected: plan.selected.map((candidate) => ({
      id: candidate.id,
      source: candidate.source,
      path: candidate.path,
      tokens: candidate.estimatedTokens,
      freshness: candidate.freshness ?? "unknown",
      mandatory: candidate.mandatory === true,
    })),
    omitted: plan.omitted,
    requiresFreshRead: plan.requiresFreshRead,
  };
}

interface ScoredCandidate {
  candidate: ContextCandidate;
  utility: number;
}

function finalizePlan(
  config: MinimumContextConfig,
  _task: ContextTaskSignal,
  selected: ContextCandidate[],
  omitted: OmittedContextCandidate[],
): MinimumContextPlan {
  const requiresFreshRead = uniquePaths(
    selected
      .filter((candidate) => candidate.freshness === "indexed" && candidate.path)
      .map((candidate) => candidate.path!),
  );
  return {
    mode: config.mode,
    tokenBudget: config.tokenBudget,
    estimatedTokens: selected.reduce((total, candidate) => total + candidate.estimatedTokens, 0),
    selected,
    omitted,
    requiresFreshRead,
  };
}

function normalizeCandidate(candidate: ContextCandidate): ContextCandidate {
  return {
    ...candidate,
    estimatedTokens: Math.max(1, Math.floor(candidate.estimatedTokens)),
    freshness: candidate.freshness ?? "unknown",
  };
}

function candidateUtility(candidate: ContextCandidate, task: ContextTaskSignal): number {
  let utility = SOURCE_VALUE[candidate.source];
  const candidatePath = candidate.path;
  if (candidatePath && pathMatches(candidatePath, task.explicitPaths)) utility += 100;
  if (candidatePath && pathMatches(candidatePath, task.activePaths)) utility += 76;
  utility += queryOverlapScore(task.query, candidate);

  if (candidate.freshness === "current") utility += 6;
  if (candidate.freshness === "indexed" && task.intent === "change") utility -= 12;
  if (candidate.source === "deps" && DEPENDENCY_QUERY.test(task.query)) utility += 52;
  if (candidate.source === "repo-map" && (task.intent === "inspect" || task.intent === "plan")) utility += 16;
  if (candidate.source === "retrieval" && task.intent === "debug") utility += 12;

  return Math.max(1, utility);
}

function efficiency(item: ScoredCandidate): number {
  return item.utility / Math.max(1, item.candidate.estimatedTokens);
}

function isRedundant(candidate: ScoredCandidate, selected: readonly ScoredCandidate[]): boolean {
  const candidateSketch = contentSketch(candidate.candidate);
  if (!candidateSketch.size) return false;
  return selected.some((existing) =>
    existing.utility >= candidate.utility &&
    similarity(candidateSketch, contentSketch(existing.candidate)) >= REDUNDANT_SIMILARITY,
  );
}

function queryOverlapScore(query: string, candidate: ContextCandidate): number {
  const queryTerms = [...terms(query)].filter((term) => term.length >= 2).slice(0, 12);
  if (!queryTerms.length) return 0;
  const searchable = `${candidate.path ?? ""}\n${candidate.content.slice(0, 800)}`.toLocaleLowerCase();
  const matches = queryTerms.filter((term) => searchable.includes(term)).length;
  return Math.min(24, matches * 6);
}

function contentSketch(candidate: ContextCandidate): Set<string> {
  return new Set([...terms(candidate.content)].slice(0, 96));
}

function terms(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? []).filter(Boolean));
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const value of left) {
    if (right.has(value)) shared += 1;
  }
  return shared / (left.size + right.size - shared);
}

function pathMatches(path: string, targets: readonly string[]): boolean {
  const normalizedPath = normalizePath(path);
  return targets.some((target) => {
    const normalizedTarget = normalizePath(target);
    return Boolean(normalizedTarget) && (
      normalizedPath === normalizedTarget ||
      normalizedPath.endsWith(`/${normalizedTarget}`) ||
      normalizedTarget.endsWith(`/${normalizedPath}`)
    );
  });
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const normalized = normalizePath(path);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(path);
  }
  return unique;
}

function normalizePath(path: string): string {
  return upath.normalize(path).replace(/^\.\//, "").toLocaleLowerCase();
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSelectionMode(value: unknown): value is ContextSelectionMode {
  return value === "off" || value === "observe" || value === "apply";
}
