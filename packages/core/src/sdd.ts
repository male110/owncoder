/**
 * Spec-Driven Development (SDD) — spec → design → tasks
 *
 * Three-layer document chain under `.owncoder/sdd/<feature>/`:
 *   - spec.md   — WHAT to build (problem, requirements, acceptance)
 *   - design.md — HOW to build (approach, components, trade-offs)
 *   - tasks.md  — execution checklist (parsed by plans.ts)
 *
 * Lifecycle: empty → spec → design → tasks → ready (→ executed via plans.ts).
 * Tasks reuse `parseTasksFromMarkdown` so the existing plan executor drives SDD.
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parseTasksFromMarkdown, type TaskItem } from "./plans.ts";

const SDD_DIR = ".owncoder/sdd";

export type SddPhase = "spec" | "design" | "tasks";

export interface SddFeature {
  name: string;
  title: string;
  phases: SddPhase[];
  complete: boolean;
  mtimeMs: number;
}

export interface SddStatus {
  feature: string;
  hasSpec: boolean;
  hasDesign: boolean;
  hasTasks: boolean;
  tasks: TaskItem[];
  /** how far along the spec→design→tasks chain */
  phase: "empty" | "spec" | "design" | "tasks" | "ready";
}


export function featureDirRel(feature: string): string {
  return `${SDD_DIR}/${slugify(feature)}`;
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



// ── List / status ──────────────────────────────────────────

export async function listFeatures(workspaceRoot: string): Promise<SddFeature[]> {
  const dir = resolve(workspaceRoot, SDD_DIR);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SddFeature[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const fdir = join(dir, ent.name);
    const phases: SddPhase[] = [];
    let mtimeMs = 0;
    let title = ent.name;
    for (const p of ["spec", "design", "tasks"] as SddPhase[]) {
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
            if (m) heading = m[1];
          }
          if (heading) title = heading.replace(/^Spec:\s*/i, "").trim();
        }
      }
    }
    out.push({ name: ent.name, title, phases, complete: phases.length === 3, mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function getFeatureStatus(
  workspaceRoot: string,
  feature: string,
): Promise<SddStatus> {
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
  const phase: SddStatus["phase"] = !hasSpec
    ? "empty"
    : !hasDesign
      ? "spec"
      : !hasTasks
        ? "design"
        : "ready";
  return { feature: slug, hasSpec, hasDesign, hasTasks, tasks, phase };
}

/** Compact status summary for tool output. */
export function formatFeatureStatus(status: SddStatus): string {
  const parts: string[] = [
    `## SDD: ${status.feature}`,
    `phase: ${status.phase}`,
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