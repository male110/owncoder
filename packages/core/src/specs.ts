/**
 * Spec-Driven Development — requirements → design → tasks (Kiro 风格).
 *
 * Three-layer document chain under `.owncoder/specs/<feature>/`:
 *   - spec.md   — requirements document (WHAT to build: goals, scope, user
 *                 stories, numbered R1/R2 requirements, acceptance criteria,
 *                 constraints — no technical design content)
 *   - design.md — HOW to build (architecture, components, interfaces, data
 *                 models, flows, error handling, testing strategy, plus a
 *                 requirements traceability matrix covering every R number)
 *   - tasks.md  — execution checklist (Kiro-style checkbox tasks, each with
 *                 dependencies, files/modules, implementation requirements,
 *                 verification and requirement references; parsed by plans.ts,
 *                 executed by the existing plan executor after approval)
 *
 * Lifecycle: empty → spec( awaiting approval ) → design( awaiting approval )
 *            → tasks( awaiting approval ) → approved (executed via plans.ts).
 *
 * Each phase pauses for the user's approval before the next one starts. The
 * gate state lives in `<feature>/.state.json` next to the documents so it
 * survives restarts within its owning session; other sessions cannot adopt it.
 *
 * Content contracts are enforced by validateSpecContent / validateDesignContent /
 * validateTasksContent before anything is written to disk: a phase document
 * that misses coverage or smuggles in unapproved work is rejected with an
 * explicit error instead of being silently accepted.
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parseTasksFromMarkdown, readPlanFile, sessionArtifactDir, type TaskItem } from "./plans.ts";


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
  sessionId: string;
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

export function featureDirRel(feature: string, sessionId: string): string {
  return `${sessionArtifactDir("specs", sessionId)}/${slugify(feature)}`;
}

function featureDirAbs(workspaceRoot: string, feature: string, sessionId: string): string {
  return resolve(workspaceRoot, featureDirRel(feature, sessionId));
}

function assertFeatureName(feature: string): string {
  const slug = slugify(feature);
  if (!slug) throw new Error("invalid feature name");
  if (slug.startsWith(".")) throw new Error("invalid feature name");
  return slug;
}

/**
 * 把一个特性解析到磁盘上唯一的一个目录。
 *
 * 同一特性在不同阶段可能被写成不同的名字（"登录流程" 之后再给英文 slug
 * "login-flow"，或 "login-flow" 与 "loginflow"）。slugify 已经吃掉大部分
 * 差异，但只差分隔符的写法仍会各建一个目录——那正是同一项目出现两份 spec
 * 的来源。因此当已存在目录与请求名在去掉分隔符后一致时，复用已存在目录。
 */
async function resolveFeatureSlug(workspaceRoot: string, feature: string, sessionId: string): Promise<string> {
  const slug = assertFeatureName(feature);
  let entries;
  try {
    entries = await fs.readdir(resolve(workspaceRoot, sessionArtifactDir("specs", sessionId)), { withFileTypes: true });
  } catch {
    return slug;
  }
  const names = entries
    .filter((ent) => ent.isDirectory() && !ent.name.startsWith(".") && ent.name.replace(/-/g, "") === slug.replace(/-/g, ""))
    .map((ent) => ent.name);
  if (names.length === 0) return slug;
  const candidates = await Promise.all(names.map(async (name) => {
    let mtimeMs = 0;
    for (const file of ["spec.md", "design.md", "tasks.md", STATE_FILE]) {
      try {
        mtimeMs = Math.max(mtimeMs, (await fs.stat(join(resolve(workspaceRoot, sessionArtifactDir("specs", sessionId)), name, file))).mtimeMs);
      } catch {
        // Ignore missing legacy phase files.
      }
    }
    return { name, mtimeMs };
  }));
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))[0]!.name;

}

// ── Content contracts ──────────────────────────────────────
//
// Each phase document is validated BEFORE anything is written to disk. The
// contracts keep the three-layer chain honest: spec.md stays a pure
// requirements document, design.md traces every requirement, and tasks.md
// stays an executable Kiro-style checklist that covers the design.

/** Requirement id (R1, R2, …) referenced by design/tasks documents. */
const REQ_ID = /\bR(\d+)\b/g;

function extractReqIds(content: string): string[] {
  return [...content.matchAll(REQ_ID)].map((m) => `R${m[1]}`);
}

function uniqueSorted(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    else seen.add(id);
  }
  return [...dup];
}

/** Lines that look like technical design smuggled into a requirements doc. */
const TECH_CONTENT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // NOTE: no \b after the Chinese alternatives — \b is ASCII-word based and
  // never matches after a CJK char, so "## 架构" would slip through.
  { re: /^#{1,6}\s*(架构|architecture|技术设计|technical design)/i, label: "architecture section" },
  { re: /^#{1,6}\s*(接口|interface|api)/i, label: "interface/API section" },
  { re: /^#{1,6}\s*(数据模型|data model|schema)/i, label: "data model section" },
  { re: /^#{1,6}\s*(组件|component)s?/i, label: "components section" },
  { re: /^#{1,6}\s*(目录结构|文件结构|file layout|project structure)/i, label: "file layout section" },
  { re: /^#{1,6}\s*(实现方案|实现计划|implementation plan)/i, label: "implementation plan section" },
  { re: /^#{1,6}\s*(任务|tasks?)/i, label: "tasks section" },
  { re: /^#{1,6}\s*(测试策略|testing strategy)/i, label: "testing strategy section" },
  { re: /^#{1,6}\s*(追踪矩阵|traceability matrix)/i, label: "traceability matrix section" },
];

/** Interface signatures / file implementation lists inside a requirements doc. */
const TECH_SNIPPET_PATTERNS: RegExp[] = [
  /```[a-z]*\w*\s*\n[\s\S]*?\b(interface|type|class|function|export|import)\b[\s\S]*?```/i,
  /```[a-z]*\w*\s*\n[\s\S]*?\b(def|struct|enum|fn|package)\b[\s\S]*?```/i,
  /^\s*(export\s+)?(interface|type|class)\s+\w+\s*[<{]/m,
  /^\s*(export\s+)?(async\s+)?function\s+\w+\s*\(/m,
  /^\s*(export\s+)?const\s+\w+\s*[:=]\s*(\(|async|\w+\s*=>)/m,
  /^\s*(public|private|protected)\s+\w+\s+\w+\s*\(/m,
  /^\s*(?:[-*]\s+)?(src|lib|packages|apps|components|internal)\/[\w./-]+\.(ts|tsx|js|jsx|py|go|java|rs)\s*[:：]/m,
];

/**
 * Validate the phase-1 requirements document (spec.md).
 *
 * Must be a pure requirements doc: numbered R1/R2… requirements (unique),
 * goals/scope/user stories/acceptance criteria/constraints. Rejects empty
 * documents, missing or duplicated requirement ids, and technical design
 * content (architecture sections, interface signatures, file lists).
 */
export function validateSpecContent(content: string): void {
  const text = content.trim();
  if (!text) throw new Error("spec.md must not be empty");

  const ids = extractReqIds(text);
  if (ids.length === 0) {
    throw new Error(
      "spec.md must contain numbered requirements (R1, R2, …) — e.g. a line like \"R1: WHEN … THE SYSTEM SHALL …\"",
    );
  }
  const dup = duplicates(ids);
  if (dup.length > 0) {
    throw new Error(`spec.md has duplicated requirement ids: ${dup.join(", ")} — each R number must be unique`);
  }

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    for (const { re, label } of TECH_CONTENT_PATTERNS) {
      if (re.test(line)) {
        throw new Error(
          `spec.md must be a pure requirements document — found a "${label}" heading. ` +
            "Move architecture, interfaces, data models and file layouts to design.md (phase 2).",
        );
      }
    }
  }
  for (const re of TECH_SNIPPET_PATTERNS) {
    if (re.test(text)) {
      throw new Error(
        "spec.md must not contain technical design content (interface signatures, type/class/function definitions, or file implementation lists). " +
          "Keep spec.md to goals, scope, user stories, numbered requirements, acceptance criteria and constraints; put the technical design in design.md.",
      );
    }
  }
}

/**
 * Validate the phase-2 design document (design.md).
 *
 * Must reference real requirement ids (R1, R2, …) from the approved spec and
 * provide a traceability matrix covering every requirement. Called with the
 * approved spec content so unknown references and missing coverage are both
 * caught.
 */
export function validateDesignContent(content: string, specContent?: string): void {
  const text = content.trim();
  if (!text) throw new Error("design.md must not be empty");

  const ids = extractReqIds(text);
  if (ids.length === 0) {
    throw new Error(
      "design.md must reference the requirements it implements (R1, R2, …) — e.g. section titles or a traceability matrix row per requirement",
    );
  }
  const dup = duplicates(ids);
  if (dup.length > 0) {
    throw new Error(`design.md has duplicated requirement references: ${dup.join(", ")}`);
  }

  if (specContent !== undefined) {
    const specIds = uniqueSorted(extractReqIds(specContent));
    if (specIds.length > 0) {
      const designIds = new Set(ids);
      const unknown = uniqueSorted(ids).filter((id) => !specIds.includes(id));
      if (unknown.length > 0) {
        throw new Error(
          `design.md references unknown requirement ids: ${unknown.join(", ")} — only ids from the approved spec.md (${specIds.join(", ")}) are valid`,
        );
      }
      const missing = specIds.filter((id) => !designIds.has(id));
      if (missing.length > 0) {
        throw new Error(
          `design.md does not cover requirements: ${missing.join(", ")} — every requirement from the approved spec must be traced in the design (traceability matrix)`,
        );
      }
    }
  }
}

/** Checkbox task line: `- [ ] …` / `1. [ ] …` (Kiro-style). */
const TASK_LINE = /^\s*(?:[-*]|\d+[.、)])\s+\[[ xX]\]\s+(.+)$/;

/** Field labels a Kiro-style task must carry (依赖 / 文件 / 实现 / 验收 / 需求). */
const TASK_FIELD_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(依赖|depends? on|前置)\s*[:：]/i, label: "dependencies" },
  { re: /(文件|模块|files?|modules?)\s*[:：]/i, label: "files/modules" },
  { re: /(实现(要求)?|implementation)\s*[:：]/i, label: "implementation requirements" },
  { re: /(验收|验证|acceptance|verification)\s*[:：]/i, label: "verification" },
  { re: /(需求|requirement)\s*[:：]/i, label: "requirement references" },
];

/**
 * Validate the phase-3 task list (tasks.md).
 *
 * Kiro-style checkbox tasks; each task must carry dependencies, files/modules,
 * implementation requirements, verification and requirement references.
 * Called with the approved design content so unknown references and missing
 * coverage are caught. Rejects empty documents and lists without checkboxes.
 */
export function validateTasksContent(content: string, designContent?: string): void {
  const text = content.trim();
  if (!text) throw new Error("tasks.md must not be empty");

  const lines = text.split(/\r?\n/);
  const taskEntries = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => TASK_LINE.test(line));
  if (taskEntries.length === 0) {
    throw new Error(
      "tasks.md must contain checkbox tasks (\"- [ ] …\" or \"1. [ ] …\") — plain paragraphs or numbered lists without checkboxes are not executable",
    );
  }

  const ids = extractReqIds(text);
  const dup = duplicates(ids);
  if (dup.length > 0) {
    throw new Error(`tasks.md has duplicated requirement references: ${dup.join(", ")}`);
  }

  if (designContent !== undefined) {
    const designIds = uniqueSorted(extractReqIds(designContent));
    if (designIds.length > 0) {
      const taskIds = new Set(ids);
      const unknown = uniqueSorted(ids).filter((id) => !designIds.includes(id));
      if (unknown.length > 0) {
        throw new Error(
          `tasks.md references unknown requirement ids: ${unknown.join(", ")} — only ids traced in the approved design.md (${designIds.join(", ")}) are valid`,
        );
      }
      const missing = designIds.filter((id) => !taskIds.has(id));
      if (missing.length > 0) {
        throw new Error(
          `tasks.md does not cover requirements: ${missing.join(", ")} — every requirement traced in the approved design must be covered by at least one task`,
        );
      }
    }
  }

  taskEntries.forEach(({ line, index }, i) => {
    const body = line.match(TASK_LINE)![1]!;
    const block = [body, ...collectTaskBlock(lines, index)];
    const missing = TASK_FIELD_PATTERNS.filter(({ re }) => !block.some((l) => re.test(l))).map(({ label }) => label);
    if (missing.length > 0) {
      throw new Error(
        `tasks.md task #${i + 1} ("${body.slice(0, 60)}${body.length > 60 ? "…" : ""}") is missing required fields: ${missing.join(", ")}. ` +
          "Each Kiro-style task must state its dependencies (依赖:), files/modules (文件:), implementation requirements (实现:), verification (验收:) and requirement references (需求: R…).",
      );
    }
  });
}

/** Lines belonging to one checkbox task: following sub-lines until the next task/heading. */
function collectTaskBlock(lines: string[], taskLineIndex: number): string[] {
  const block: string[] = [];
  for (let i = taskLineIndex + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (TASK_LINE.test(l) || /^#{1,6}\s/.test(l)) break;
    block.push(l);
  }
  return block;
}

// ── Save / read each phase ─────────────────────────────────

export async function saveSpec(
  workspaceRoot: string,
  feature: string,
  content: string,
  sessionId: string,
): Promise<string> {
  validateSpecContent(content);
  return savePhase(workspaceRoot, feature, "spec.md", content, sessionId);
}

export async function saveDesign(
  workspaceRoot: string,
  feature: string,
  content: string,
  sessionId: string,
): Promise<string> {
  // Cross-check against the approved spec so unknown references and missing
  // coverage are rejected before design.md reaches disk.
  const specContent = await readSpecPhase(workspaceRoot, feature, "spec", sessionId).catch(() => undefined);
  validateDesignContent(content, specContent);
  return savePhase(workspaceRoot, feature, "design.md", content, sessionId);
}

export async function saveTasks(
  workspaceRoot: string,
  feature: string,
  content: string,
  sessionId: string,
): Promise<string> {
  // Cross-check against the approved design so tasks cover the confirmed design.
  const designContent = await readSpecPhase(workspaceRoot, feature, "design", sessionId).catch(() => undefined);
  validateTasksContent(content, designContent);
  return savePhase(workspaceRoot, feature, "tasks.md", content, sessionId);
}

async function savePhase(
  workspaceRoot: string,
  feature: string,
  file: string,
  content: string,
  sessionId: string,
): Promise<string> {
  const slug = await resolveFeatureSlug(workspaceRoot, feature, sessionId);
  const dir = featureDirAbs(workspaceRoot, slug, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const body = content.trim().startsWith("#")
    ? content
    : `# ${file.replace(".md", "")}: ${slug}\n\n${content}`;
  await fs.writeFile(join(dir, file), body.endsWith("\n") ? body : `${body}\n`, "utf8");
  await fs.writeFile(`${join(dir, file)}.owner.json`, JSON.stringify({ sessionId }), "utf8");
  return `${featureDirRel(slug, sessionId)}/${file}`;
}

export async function readSpecPhase(
  workspaceRoot: string,
  feature: string,
  phase: SpecPhase,
  sessionId: string,
): Promise<string> {
  const slug = await resolveFeatureSlug(workspaceRoot, feature, sessionId);
  try {
    return await readPlanFile(workspaceRoot, `${featureDirRel(slug, sessionId)}/${phase}.md`, sessionId);
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
  sessionId: string,
): Promise<SpecWorkflowState | null> {
  const slug = await resolveFeatureSlug(workspaceRoot, feature, sessionId);
  try {
    const raw = await fs.readFile(join(featureDirAbs(workspaceRoot, slug, sessionId), STATE_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<SpecWorkflowState>;
    if (!parsed || parsed.sessionId !== sessionId || parsed.feature !== slug || typeof parsed.stage !== "string") return null;
    return { sessionId, feature: slug, stage: parsed.stage as SpecStage, updatedAt: parsed.updatedAt ?? "" };
  } catch {
    return null;
  }
}

export async function writeFeatureState(
  workspaceRoot: string,
  feature: string,
  stage: SpecStage,
  sessionId: string,
): Promise<void> {
  const slug = await resolveFeatureSlug(workspaceRoot, feature, sessionId);
  const dir = featureDirAbs(workspaceRoot, slug, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const state: SpecWorkflowState = {
    sessionId,
    feature: slug,
    stage,
    updatedAt: new Date().toISOString(),
  };
  const tmp = join(dir, `${STATE_FILE}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, join(dir, STATE_FILE));
}

// ── List / status ──────────────────────────────────────────

export async function listSpecs(workspaceRoot: string, sessionId: string): Promise<SpecFeature[]> {
  const dir = resolve(workspaceRoot, sessionArtifactDir("specs", sessionId));
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SpecFeature[] = [];


  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    if (!await readFeatureState(workspaceRoot, ent.name, sessionId)) continue;
    const fdir = join(dir, ent.name);
    const phases: SpecPhase[] = [];
    let mtimeMs = 0;
    let title = ent.name;
    for (const p of ["spec", "design", "tasks"] as SpecPhase[]) {
      const pFile = join(fdir, `${p}.md`);
      if (await readPlanFile(workspaceRoot, `${featureDirRel(ent.name, sessionId)}/${p}.md`, sessionId).then(() => true, () => false)) {
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
    const state = await readFeatureState(workspaceRoot, ent.name, sessionId);
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
  sessionId: string,
): Promise<SpecStatus> {
  const slug = await resolveFeatureSlug(workspaceRoot, feature, sessionId);
  const dir = featureDirAbs(workspaceRoot, slug, sessionId);
  const exists = (phase: SpecPhase) => readSpecPhase(workspaceRoot, slug, phase, sessionId).then(() => true, () => false);
  const hasSpec = await exists("spec");
  const hasDesign = await exists("design");
  const hasTasks = await exists("tasks");
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
  const state = await readFeatureState(workspaceRoot, slug, sessionId);
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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
