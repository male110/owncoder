import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { checkboxFromTaskStatus, parseTasksFromMarkdown, readActiveMeta, readPlanFile, sessionArtifactDir, taskDocumentDigest, type ActivePlanMeta, type TaskItem } from "./plans.ts";
import { featureDirRel, readFeatureState } from "./specs.ts";

export interface SpecTaskPlanRef {
  path: string;
  version: string;
  approvedAt: string;
}

export interface SpecTaskRef extends SpecTaskPlanRef {
  taskId: string;
}

export interface SpecTaskDocument {
  path: string;
  /** Batch fingerprint (progress-independent). Stable across its own progress writes. */
  version: string;
  /** Raw sha256 of the document body, for "editor matches disk" checks. */
  sourceDigest: string;
  approvedAt: string | null;
  tasks: TaskItem[];
  currentTaskId: string | null;
}

export function isSpecTaskPath(path: string): boolean {
  return /^\.owncoder\/specs\/sessions\/[^/]+\/[^/]+\/tasks\.md$/.test(path);
}

export function specTaskFeature(path: string, sessionId: string): string | null {
  if (!isSpecTaskPath(path) || !path.startsWith(`${sessionArtifactDir("specs", sessionId)}/`)) return null;
  const feature = path.split("/").at(-2)!;
  return path === `${featureDirRel(feature, sessionId)}/tasks.md` ? feature : null;
}

/**
 * Batch fingerprint of a task document. Checkbox markers are normalized away,
 * so writing execution progress into the document never invalidates the batch
 * that produced it, while edits to task text or order still do.
 */
export function specTaskVersion(body: string): string {
  return taskDocumentDigest(body);
}

/** Raw content hash, used to tell whether the editor matches the file on disk. */
export function specTaskSourceDigest(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Checkbox task line: `- [ ] …` / `1. [x] …`; group 1 keeps the bullet prefix. */
const TASK_LINE_REWRITE = /^(\s*(?:[-*]|\d+[.、)])\s+)\[([ xX\-\/])\](\s.*)?$/;

/**
 * Write task progress back into the task document itself so the source view and
 * `list_specs` progress reflect reality (`- [x]` done, `- [-]` failed) instead of
 * always showing unchecked tasks. Only checkbox markers change, so line numbers
 * (and therefore `sourceLine` mappings) stay valid.
 *
 * Returns the digest of the rewritten document; callers must store it in the
 * active metadata, otherwise disk and metadata disagree and the batch approval
 * is dropped.
 */
export async function writeSpecTaskProgress(root: string, sid: string, meta: ActivePlanMeta): Promise<string> {
  if (!specTaskFeature(meta.path, sid)) throw new Error("任务清单不属于当前会话");
  const body = await readPlanFile(root, meta.path, sid);
  const byLine = new Map(meta.tasks.flatMap((task) => task.sourceLine === undefined ? [] : [[task.sourceLine, task] as const]));
  const lines = body.split(/\r?\n/);
  let changed = false;
  lines.forEach((line, index) => {
    const task = byLine.get(index + 1);
    if (!task) return;
    const rewritten = line.replace(TASK_LINE_REWRITE, (_all, head: string, _marker: string, tail = "") =>
      `${head}[${checkboxFromTaskStatus(task.status)}]${tail}`);
    if (rewritten !== line) { lines[index] = rewritten; changed = true; }
  });
  if (!changed) return specTaskVersion(body);
  const updated = lines.join("\n");
  await fs.writeFile(resolve(root, meta.path), updated, "utf8");
  return specTaskVersion(updated);
}

export async function readSpecTaskDocument(root: string, path: string, sid: string, activePath: string | null): Promise<SpecTaskDocument | null> {
  const feature = specTaskFeature(path, sid);
  if (!feature) return null;
  const state = await readFeatureState(root, feature, sid);
  if (state?.stage !== "awaiting_tasks_approval" && state?.stage !== "approved") return null;
  const body = await readPlanFile(root, path, sid);
  const version = specTaskVersion(body);
  const meta = state.stage === "approved" && activePath === path ? await readActiveMeta(root, sid) : null;
  const approved = meta?.path === path && meta.documentDigest === version ? meta : null;
  return {
    path,
    version,
    sourceDigest: specTaskSourceDigest(body),
    approvedAt: approved?.approvedAt ?? null,
    tasks: approved?.tasks ?? parseTasksFromMarkdown(body, true),
    currentTaskId: approved?.currentTaskId ?? null,
  };
}

export async function readApprovedSpecTask(root: string, sid: string, activePath: string | null, ref: SpecTaskRef): Promise<{ meta: ActivePlanMeta; task: TaskItem; body: string }> {
  if (!ref || typeof ref.path !== "string" || !specTaskFeature(ref.path, sid) || activePath !== ref.path) {
    throw new Error("任务清单不属于当前会话或已切换");
  }
  const feature = specTaskFeature(ref.path, sid)!;
  const state = await readFeatureState(root, feature, sid);
  const meta = await readActiveMeta(root, sid);
  if (state?.stage !== "approved" || !meta || meta.path !== ref.path || meta.approvedAt !== ref.approvedAt || !meta.documentDigest || meta.documentDigest !== ref.version) {
    throw new Error("任务清单或执行批次已更改，请重新加载后执行");
  }
  const body = await readPlanFile(root, ref.path, sid);
  if (specTaskVersion(body) !== ref.version) {
    throw new Error("任务清单已修改，请重新加载后执行");
  }
  const task = meta.tasks.find((item) => item.id === ref.taskId);
  if (!task) throw new Error("任务已不存在");
  return { meta, task, body };
}

export function assertSpecTaskReady(meta: ActivePlanMeta, task: TaskItem): void {
  if (task.status !== "pending" && task.status !== "failed" && task.status !== "partial") throw new Error("该任务当前不可执行");
  if (meta.tasks.some((item) => item.status === "in_progress")) throw new Error("任务正在执行");
  if (!task.dependsOn.every((id) => meta.tasks.some((item) => item.id === id && (item.status === "completed" || item.status === "skipped")))) {
    throw new Error("请先完成前置任务");
  }
}
