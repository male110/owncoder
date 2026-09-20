/**
 * Experience Harvest — trace → (symptom, rootCause, fix) → reusable knowledge
 *
 * Closes the loop that `observability.ts` opened: traces were produced but
 * discarded. This module extracts failure→fix episodes from a TraceReport,
 * persists them as markdown under `.owncoder/experiences/` so future sessions
 * can retrieve prior fixes by symptom.
 *
 * Two entry points:
 *   - `persistExperiences(root, report)` — automatic, after a loop run
 *   - `saveExperience` tool — manual, when the agent states an explicit lesson
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { TraceReport, TraceSpan } from "./observability.ts";
import type { IndexClient } from "@owncoder/index";

export interface ExperienceRecord {
  id: string;
  /** 症状：错误表现 */
  symptom: string;
  /** 根因：为什么会发生 */
  rootCause: string;
  /** 修复：做了什么来消除根因 */
  fix: string;
  /** 涉及文件 */
  files: string[];
  /** 标签：typecheck / test / lint / build / runtime / general */
  tags: string[];
  traceId: string;
  timestamp: number;
  /** 修复是否成功 */
  success: boolean;
}

const EXP_DIR = ".owncoder/experiences";
const FIX_TOOLS = new Set([
  "write_file",
  "apply_patch",
  "replace_in_file",
  "semantic_diff",
  "edit_file",
]);

// ── Extraction from TraceReport ────────────────────────────

/**
 * Extract failure→fix episodes from a trace. An episode is an error signal
 * followed (in span order) by a file-modifying tool call. Traces with no
 * errors yield no experiences (successful runs need no harvest).
 *
 * Exported (in addition to the `persistExperiences()` entry point below) so callers
 * can reuse this pure extraction logic without this module's `saveExperience()` disk
 * side effects.
 */
export function extractExperiences(report: TraceReport): ExperienceRecord[] {
  const exps: ExperienceRecord[] = [];
  const spans = report.spans;
  if (!spans.length) return exps;

  const errorSignals: Array<{ idx: number; message: string }> = [];
  for (const err of report.errors) {
    const idx = spans.findIndex((s) => s.id === err.span);
    errorSignals.push({ idx: idx >= 0 ? idx : 0, message: err.message });
  }
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].status === "error" && !errorSignals.some((e) => e.idx === i)) {
      const ev = spans[i].events.find((e) => e.name.includes("error"));
      const msg = (ev?.attributes?.message as string | undefined) ?? spans[i].name;
      errorSignals.push({ idx: i, message: msg });
    }
  }

  for (const sig of errorSignals) {
    let fixSpan: TraceSpan | undefined;
    for (let j = sig.idx + 1; j < spans.length; j++) {
      if (spans[j].kind === "tool_call" && FIX_TOOLS.has(spans[j].name)) {
        fixSpan = spans[j];
        break;
      }
    }
    if (!fixSpan) continue;

    exps.push({
      id: `exp_${Date.now().toString(36)}_${exps.length + 1}`,
      symptom: sig.message.slice(0, 500),
      rootCause: sig.message.slice(0, 500),
      fix: `${fixSpan.name}: ${summarizeFixArgs(fixSpan)}`,
      files: extractFiles(fixSpan),
      tags: inferTags(sig.message),
      traceId: report.traceId,
      timestamp: Date.now(),
      success: fixSpan.status === "ok",
    });
  }

  return exps;
}

function extractFiles(span: TraceSpan): string[] {
  const out: string[] = [];
  const a = span.attributes as Record<string, unknown>;
  for (const k of ["path", "file", "target", "filePath"]) {
    if (typeof a[k] === "string" && a[k]) out.push(a[k] as string);
  }
  return [...new Set(out)];
}

function inferTags(message: string): string[] {
  const t: string[] = [];
  const l = message.toLowerCase();
  if (l.includes("type") || l.includes("tsc") || l.includes("mypy")) t.push("typecheck");
  if (l.includes("test") || l.includes("assert")) t.push("test");
  if (l.includes("lint") || l.includes("eslint") || l.includes("ruff")) t.push("lint");
  if (l.includes("build") || l.includes("cargo") || l.includes("compile")) t.push("build");
  if (l.includes("runtime") || l.includes("exception") || l.includes("throw")) t.push("runtime");
  if (!t.length) t.push("general");
  return t;
}

function summarizeFixArgs(span: TraceSpan): string {
  const a = span.attributes as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ["path", "file", "command"]) {
    if (typeof a[k] === "string") parts.push(`${k}=${String(a[k]).slice(0, 120)}`);
  }
  return parts.join(", ") || "(no args)";
}

// ── Persistence ────────────────────────────────────────────

export async function saveExperience(
  workspaceRoot: string,
  exp: ExperienceRecord,
): Promise<string> {
  const dir = join(workspaceRoot, EXP_DIR);
  await fs.mkdir(dir, { recursive: true });
  const slug = slugify(exp.symptom).slice(0, 40) || "experience";
  const stamp = new Date(exp.timestamp).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rel = `${EXP_DIR}/${stamp}-${slug}.md`;
  await fs.writeFile(join(workspaceRoot, rel), renderExperienceMd(exp), "utf8");
  return rel.split(/[/\\]/).join("/");
}

function renderExperienceMd(exp: ExperienceRecord): string {
  return [
    `# Experience: ${exp.symptom.slice(0, 80)}`,
    "",
    `- **id**: ${exp.id}`,
    `- **trace**: ${exp.traceId}`,
    `- **timestamp**: ${new Date(exp.timestamp).toISOString()}`,
    `- **success**: ${exp.success}`,
    `- **tags**: ${exp.tags.join(", ")}`,
    `- **files**: ${exp.files.join(", ") || "(none)"}`,
    "",
    "## Symptom",
    exp.symptom,
    "",
    "## Root Cause",
    exp.rootCause,
    "",
    "## Fix",
    exp.fix,
    "",
  ].join("\n");
}


function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-|-$/g, "");
}

/**
 * Extract experiences from a trace, persist each to `.owncoder/experiences/`.
 * Best-effort: never throws.
 */
export async function persistExperiences(
  workspaceRoot: string,
  report: TraceReport,
  _index?: IndexClient,
): Promise<string[]> {
  const exps = extractExperiences(report);
  const saved: string[] = [];
  for (const exp of exps) {
    try {
      const rel = await saveExperience(workspaceRoot, exp);
      saved.push(rel);
    } catch {
      /* skip */
    }
  }
  return saved;
}