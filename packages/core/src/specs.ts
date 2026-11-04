/**
 * Spec-Driven Development — spec → design → tasks (Kiro 风格).
 *
 * Three-layer document chain under `.owncoder/specs/<feature>/`:
 *   - spec.md   — WHAT to build (EARS requirements, user stories, acceptance)
 *   - design.md — HOW to build (approach, data models, components, trade-offs)
 *   - tasks.md  — execution checklist (parsed by plans.ts, executed by the
 *                 existing plan executor after the user approves it)
 *
 * Lifecycle: empty → spec( awaiting approval ) → design( awaiting approval )
 *            → tasks( awaiting approval ) → approved (executed via plans.ts).
 *
 * Each phase pauses for the user's approval before the next one starts. The
 * gate state lives in `<feature>/.state.json` next to the documents so it
 * survives session restarts and is shared across sessions.
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parseTasksFromMarkdown, type TaskItem } from "./plans.ts";

const SPECS_DIR = ".owncoder/specs";
const STATE_FILE = ".state.json";

export type SpecPhase = "spec" | "design" | "tasks";

/** Gate state of the spec → design → tasks chain. */
export type SpecStage =
  | "awaiting_spec_approval"
  | "spec_approved"
  | "awaiting_design_approval"
  | "design_approved"
  | "awaiting_tasks_approval"
  | "approved";

export interface SpecWorkflowState {
  feature: string;
  stage: SpecStage;
  updatedAt: string;
}

export interface SpecFeature {
  name: string;
  title: string;
  phases: SpecPhase[];
  complete: boolean;
  mtimeMs: number;
  stage: SpecStage | null;
}

export interface SpecStatus {
  feature: string;
  hasSpec: boolean;
  hasDesign: boolean;
  hasTasks: boolean;
  tasks: TaskItem[];
  /** How far along the spec → design → tasks chain the documents go. */
  phase: "empty" | "spec" | "design" | "tasks" | "ready";
  /** Current approval gate, read from the feature's .state.json. */
  stage: SpecStage | null;
}

export function featureDirRel(feature: string): string {
  return `${SPECS_DIR}/${slugify(feature)}`;
}

function featureDirAbs(workspaceRoot: string, feature: string): string {
  return resolve(workspaceRoot, featureDirRel(feature));
}

function assertFeatureName(feature: string): string {
  const slug = slugify(feature);
  if (!slug) throw new Error("invalid feature name");
  if (slug.startsWith(".")) throw new Error("invalid feature name");
  return slug;
}

// ── Save / read each phase ─────────────────────────────────

export async function saveSpec(
  workspaceRoot: string,
  feature: string,
  content: string,
): Promise<string> {
  return savePhase(workspaceRoot, feature, "spec.md", content);
}

export async function saveDesign(
  workspaceRoot: string,
  feature: string,
  content: string,
): Promise<string> {
  return savePhase(workspaceRoot, feature, "design.md", content);
}

export async function saveTasks(
  workspaceRoot: string,
  feature: string,
  content: string,
): Promise<string> {
  return savePhase(workspaceRoot, feature, "tasks.md", content);
}

async function savePhase(
  workspaceRoot: string,
  feature: string,
  file: string,
  content: string,
): Promise<string> {
  const slug = assertFeatureName(feature);
  const dir = featureDirAbs(workspaceRoot, slug);
  await fs.mkdir(dir, { recursive: true });
  const body = content.trim().startsWith("#")
    ? content
    : `# ${file.replace(".md", "")}: ${slug}\n\n${content}`;
  await fs.writeFile(join(dir, file), body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return `${featureDirRel(slug)}/${file}`;
}

export async function readSpecPhase(
  workspaceRoot: string,
  feature: string,
  phase: SpecPhase,
): Promise<string> {
  const slug = assertFeatureName(feature);
  try {
    return await fs.readFile(join(featureDirAbs(workspaceRoot, slug), `${phase}.md`), "utf8");
  } catch {
    throw new Error(`${phase}.md not found for feature ${slug}`);
  }
}

// ── Approval gate state ────────────────────────────────────

export function stageForPhase(phase: SpecPhase): SpecStage {
  switch (phase) {
    case "spec": return "awaiting_spec_approval";
    case "design": return "awaiting_design_approval";
    case "tasks": return "awaiting_tasks_approval";
  }
}

/** The phase this stage is waiting on (null when between phases or approved). */
export function phaseUnderReview(stage: SpecStage | null): SpecPhase | null {
  switch (stage) {
    case "awaiting_spec_approval": return "spec";
    case "awaiting_design_approval": return "design";
    case "awaiting_tasks_approval": return "tasks";
    default: return null;
  }
}

export async function readFeatureState(
  workspaceRoot: string,
  feature: string,
): Promise<SpecWorkflowState | null> {
  const slug = assertFeatureName(feature);
  try {
    const raw = await fs.readFile(join(featureDirAbs(workspaceRoot, slug), STATE_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<SpecWorkflowState>;
    if (!parsed || typeof parsed.stage !== "string") return null;
    return { feature: slug, stage: parsed.stage as SpecStage, updatedAt: parsed.updatedAt ?? "" };
  } catch {
    return null;
  }
}

export async function writeFeatureState(
  workspaceRoot: string,
  feature: string,
  stage: SpecStage,
): Promise<void> {
  const slug = assertFeatureName(feature);
  const dir = featureDirAbs(workspaceRoot, slug);
  await fs.mkdir(dir, { recursive: true });
  const state: SpecWorkflowState = {
    feature: slug,
    stage,
    updatedAt: new Date().toISOString(),
  };
  const tmp = join(dir, `${STATE_FILE}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, join(dir, STATE_FILE));
}

// ── List / status ──────────────────────────────────────────

export async function listSpecs(workspaceRoot: string): Promise<SpecFeature[]> {
  const dir = resolve(workspaceRoot, SPECS_DIR);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SpecFeature[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const fdir = join(dir, ent.name);
    const phases: SpecPhase[] = [];
    let mtimeMs = 0;
    let title = ent.name;
    for (const p of ["spec", "design", "tasks"] as SpecPhase[]) {
      const pFile = join(fdir, `${p}.md`);
      if (await fileExists(pFile)) {
        phases.push(p);
        const st = await fs.stat(pFile);
        if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
        if (p === "spec") {
          const text = await fs.readFile(pFile, "utf8").catch(() => "");
          let heading = "";
          try {
            const tree = fromMarkdown(text);
            for (const node of tree.children) {
              if (node.type === "heading" && node.depth === 1 && "children" in node && node.children?.length) {
                for (const child of node.children) {
                  if ("value" in child && typeof child.value === "string") heading += child.value;
                }
                break;
              }
            }
          } catch {
            // fallback to regex if AST parsing fails
            const m = text.match(/^#\s+(.+)$/m);
            if (m) heading = m[1]!;
          }
          if (heading) title = heading.replace(/^Spec:\s*/i, "").trim();
        }
      }
    }
    const state = await readFeatureState(workspaceRoot, ent.name);
    out.push({
      name: ent.name,
      title,
      phases,
      complete: phases.length === 3,
      mtimeMs,
      stage: state?.stage ?? null,
    });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function getSpecStatus(
  workspaceRoot: string,
  feature: string,
): Promise<SpecStatus> {
  const slug = assertFeatureName(feature);
  const dir = featureDirAbs(workspaceRoot, slug);
  const hasSpec = await fileExists(join(dir, "spec.md"));
  const hasDesign = await fileExists(join(dir, "design.md"));
  const hasTasks = await fileExists(join(dir, "tasks.md"));
  let tasks: TaskItem[] = [];
  if (hasTasks) {
    try {
      tasks = parseTasksFromMarkdown(await fs.readFile(join(dir, "tasks.md"), "utf8"));
    } catch {
      /* */
    }
  }
  const phase: SpecStatus["phase"] = !hasSpec
    ? "empty"
    : !hasDesign
      ? "spec"
      : !hasTasks
        ? "design"
        : "ready";
  const state = await readFeatureState(workspaceRoot, slug);
  return {
    feature: slug,
    hasSpec,
    hasDesign,
    hasTasks,
    tasks,
    phase,
    stage: state?.stage ?? null,
  };
}

/** Compact status summary for tool output. */
export function formatSpecStatus(status: SpecStatus): string {
  const parts: string[] = [
    `## Spec: ${status.feature}`,
    `stage: ${status.stage ?? "unknown"}`,
    `- spec: ${status.hasSpec ? "✅" : "⬜"}`,
    `- design: ${status.hasDesign ? "✅" : "⬜"}`,
    `- tasks: ${status.hasTasks ? "✅" : "⬜"}`,
  ];
  if (status.tasks.length > 0) {
    const done = status.tasks.filter((t) => t.status === "completed").length;
    parts.push(`- task progress: ${done}/${status.tasks.length}`);
  }
  return parts.join("\n");
}

// ── helpers ────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
