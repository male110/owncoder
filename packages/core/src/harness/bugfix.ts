/**
 * Proactive Bug-Fix Workflow — issue → reproduce → localize → (patch)
 *
 * Replaces blind retry with a structured chain (mirrors the CodeArts
 * bug-fix-agent: issue-analysis → reproduction → root-cause-localization).
 * The actual patch is still produced by the agent loop (apply_patch), but
 * this gives it a structured starting point instead of guessing.
 *
 *   parseIssue(description)            → IssueAnalysis
 *   reproduce(root, analysis)          → ReproductionResult   (uses verification.ts)
 *   localizeRootCause(analysis, repro) → RootCauseHypothesis[]
 *   bugfixWorkflow(root, description)  → BugfixPlan           (chains the above)
 */

import upath from "upath";
import { VerificationEngine, type VerificationResult } from "./verification.ts";

export interface IssueAnalysis {
  raw: string;
  /** 观察到的症状（错误信息/异常） */
  symptom: string;
  /** 预期行为 */
  expected: string;
  /** 复现步骤/命令 */
  reproductionSteps: string[];
  /** 提及的文件/路径 */
  mentionedFiles: string[];
  /** 错误类别 */
  category: "typecheck" | "runtime" | "test" | "lint" | "build" | "unknown";
  /** 关键词（供搜索） */
  keywords: string[];
}

export interface ReproductionResult {
  /** 是否成功复现了症状 */
  confirmed: boolean;
  verification: VerificationResult | null;
  /** 复现方法描述 */
  method: string;
}

export interface RootCauseHypothesis {
  file: string;
  /** 候选位置（行/symbol/空） */
  location: string;
  reason: string;
  confidence: number;
}

export interface BugfixPlan {
  analysis: IssueAnalysis;
  reproduction: ReproductionResult;
  hypotheses: RootCauseHypothesis[];
  /** 建议的修复策略 */
  strategy: string;
  /** 供 experience.ts 沉淀的提示 */
  experienceHint: { symptom: string; rootCause: string };
}

// ── parseIssue ─────────────────────────────────────────────

export function parseIssue(description: string): IssueAnalysis {
  const lines = description.split(/\r?\n/);
  const lower = description.toLowerCase();

  const symptom = lines
    .filter((l) => /\b(error|错误|失败|fail|exception|panic|crash|throw)\b/i.test(l))
    .map((l) => l.trim())
    .slice(0, 5)
    .join("\n");

  const expected = lines
    .filter((l) => /\b(expected|应该|预期|should|supposed|want)\b/i.test(l))
    .map((l) => l.trim())
    .slice(0, 3)
    .join("\n");

  const reproductionSteps = lines
    .filter(
      (l) =>
        /^\s*[$>]\s/.test(l) ||
        /^\s*(pnpm|npm|yarn|cargo|python|node|pytest|tsc)\b/.test(l.trim()) ||
        /\b(reproduce|复现|步骤|step|run)\b/i.test(l),
    )
    .map((l) => l.trim())
    .slice(0, 8);

  const mentionedFiles = extractPaths(description);

  const category: IssueAnalysis["category"] = inferCategory(lower);

  const keywords = extractKeywords(description);

  return {
    raw: description,
    symptom: symptom || description.slice(0, 300),
    expected,
    reproductionSteps,
    mentionedFiles,
    category,
    keywords,
  };
}

function inferCategory(lower: string): IssueAnalysis["category"] {
  if (/\b(type|tsc|mypy|annotation)\b/.test(lower)) return "typecheck";
  if (/\b(test|assert|pytest|jest|vitest)\b/.test(lower)) return "test";
  if (/\b(lint|eslint|ruff|clippy|style)\b/.test(lower)) return "lint";
  if (/\b(build|cargo|compile|webpack|vite)\b/.test(lower)) return "build";
  if (/\b(runtime|exception|throw|crash|panic|null|undefined)\b/.test(lower)) return "runtime";
  return "unknown";
}

function extractPaths(text: string): string[] {
  const found = new Set<string>();
  const re =
    /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|md|json|toml|yml|yaml|css|html|vue|svelte))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    found.add(upath.normalize(m[1]!));
    if (found.size >= 20) break;
  }
  return [...found];
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 20);
}

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "this", "that", "with",
]);

// ── reproduce ──────────────────────────────────────────────

export async function reproduce(
  workspaceRoot: string,
  analysis: IssueAnalysis,
  opts?: { timeout?: number },
): Promise<ReproductionResult> {
  const timeout = opts?.timeout ?? 60_000;
  try {
    const engine = new VerificationEngine(workspaceRoot, { timeout });
    const result = await engine.verify(analysis.mentionedFiles);
    const confirmed = !result.passed;
    const method = analysis.mentionedFiles.length
      ? `verification on ${analysis.mentionedFiles.join(", ")}`
      : "full typecheck";
    return { confirmed, verification: result, method };
  } catch (e) {
    return {
      confirmed: false,
      verification: null,
      method: `verification failed to run: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── localizeRootCause ──────────────────────────────────────

export interface LocalizeOpts {
  /** Optional searcher to find candidate files by symptom keywords */
  search?: (query: string, topK: number) => Promise<Array<{ path: string; score: number }>>;
}

export async function localizeRootCause(
  analysis: IssueAnalysis,
  repro: ReproductionResult,
  opts?: LocalizeOpts,
): Promise<RootCauseHypothesis[]> {
  const hypotheses: RootCauseHypothesis[] = [];

  // 1. Files mentioned in the issue — highest confidence
  for (const f of analysis.mentionedFiles.slice(0, 5)) {
    hypotheses.push({
      file: f,
      location: "",
      reason: "explicitly mentioned in the issue",
      confidence: 0.9,
    });
  }

  // 2. Files from verification errors
  if (repro.verification) {
    for (const check of repro.verification.checks) {
      if (check.passed) continue;
      for (const err of check.errors.slice(0, 5)) {
        if (err.file && !hypotheses.some((h) => h.file === err.file)) {
          hypotheses.push({
            file: err.file,
            location: err.line ? `:${err.line}` : "",
            reason: `${check.type} error: ${err.message.slice(0, 120)}`,
            confidence: 0.8,
          });
        }
      }
    }
  }

  // 3. Search by symptom keywords (if searcher provided)
  if (opts?.search && analysis.keywords.length > 0) {
    try {
      const query = analysis.keywords.slice(0, 6).join(" ");
      const hits = await opts.search(query, 5);
      for (const hit of hits) {
        if (hypotheses.some((h) => h.file === hit.path)) continue;
        hypotheses.push({
          file: hit.path,
          location: "",
          reason: `search hit (score ${hit.score.toFixed(2)})`,
          confidence: Math.min(0.6, hit.score / 2),
        });
      }
    } catch {
      /* search is best-effort */
    }
  }

  return hypotheses.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

// ── bugfixWorkflow ─────────────────────────────────────────

export async function bugfixWorkflow(
  workspaceRoot: string,
  issueDescription: string,
  opts?: LocalizeOpts & { timeout?: number },
): Promise<BugfixPlan> {
  const analysis = parseIssue(issueDescription);
  const reproduction = await reproduce(workspaceRoot, analysis, opts);
  const hypotheses = await localizeRootCause(analysis, reproduction, opts);

  const strategy = buildStrategy(analysis, reproduction, hypotheses);
  const experienceHint = {
    symptom: analysis.symptom.slice(0, 300),
    rootCause: hypotheses[0]
      ? `${hypotheses[0].file}${hypotheses[0].location} — ${hypotheses[0].reason}`
      : "unlocalized",
  };

  return { analysis, reproduction, hypotheses, strategy, experienceHint };
}

function buildStrategy(
  analysis: IssueAnalysis,
  repro: ReproductionResult,
  hypotheses: RootCauseHypothesis[],
): string {
  const parts: string[] = [];
  parts.push(`Category: ${analysis.category}`);
  parts.push(`Reproduced: ${repro.confirmed ? "yes" : "no"} (${repro.method})`);
  if (hypotheses.length > 0) {
    parts.push(
      `Likely root-cause locations:`,
      ...hypotheses
        .slice(0, 4)
        .map((h) => `  - ${h.file}${h.location} (conf ${h.confidence.toFixed(2)}): ${h.reason}`),
    );
    parts.push(`Suggested steps:`);
    parts.push(`1. read_file the top hypothesis to confirm the root cause`);
    parts.push(`2. apply_patch the minimal fix addressing the root cause (not the symptom)`);
    parts.push(`3. re-run verification to confirm the fix`);
  } else {
    parts.push(`No candidate locations found — investigate the symptom directly.`);
  }
  if (analysis.mentionedFiles.length > 0) {
    parts.push(`Files mentioned: ${analysis.mentionedFiles.join(", ")}`);
  }
  return parts.join("\n");
}

/** Format a BugfixPlan for tool output. */
export function formatBugfixPlan(plan: BugfixPlan): string {
  const parts: string[] = [];
  parts.push("## Bug-Fix Analysis");
  parts.push(`**Symptom**: ${plan.analysis.symptom.slice(0, 200)}`);
  if (plan.analysis.expected) parts.push(`**Expected**: ${plan.analysis.expected.slice(0, 200)}`);
  parts.push(`**Category**: ${plan.analysis.category}`);
  parts.push(`**Reproduced**: ${plan.reproduction.confirmed ? "✅ yes" : "❌ no"} (${plan.reproduction.method})`);
  if (plan.reproduction.verification && !plan.reproduction.verification.passed) {
    const failed = plan.reproduction.verification.checks.filter((c) => !c.passed);
    parts.push(`**Failing checks**: ${failed.map((c) => c.name).join(", ")}`);
  }
  if (plan.hypotheses.length > 0) {
    parts.push("", "**Root-cause hypotheses**:");
    for (const h of plan.hypotheses.slice(0, 5)) {
      parts.push(`- \`${h.file}${h.location}\` (conf ${h.confidence.toFixed(2)}) — ${h.reason}`);
    }
  }
  parts.push("", "**Strategy**:", plan.strategy);
  return parts.join("\n");
}