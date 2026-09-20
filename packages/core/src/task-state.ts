import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { restoreTaskRunState } from "./task-run.ts";
import type { Checkpoint, FileEvidence, Finding, TaskRelation, TaskState } from "./turn-rounds.ts";

const TASK_STATES_DIR = ".owncoder/task-states";
const SHARED_EVIDENCE_FILE = "shared-evidence.json";
const VERSION = 1 as const;

export interface PersistedTaskState extends TaskState {
  version: typeof VERSION;
  updatedAt: string;
  /** 仅引用共享证据；任务目标和步骤永远不在这里继承。 */
  sharedEvidenceRefs: string[];
}

function safeId(id: string): boolean {
  return Boolean(id && id.length < 128 && !/[\\/]/.test(id) && !id.includes(".."));
}

function statePath(root: string, taskId: string): string {
  return join(resolve(root, TASK_STATES_DIR), `${taskId}.json`);
}

function sharedPath(root: string): string {
  return join(resolve(root, TASK_STATES_DIR), SHARED_EVIDENCE_FILE);
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sanitizeState(value: unknown): PersistedTaskState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== VERSION || typeof raw.taskId !== "string" || typeof raw.goal !== "string") return null;
  const runState = restoreTaskRunState(raw.runState, raw.taskId) ?? undefined;
  return {
    version: VERSION,
    taskId: raw.taskId,
    relation: raw.relation === "continue" ? "continue" : "new",
    goal: raw.goal,
    scope: Array.isArray(raw.scope) ? raw.scope.filter((x): x is string => typeof x === "string") : [],
    completedSteps: Array.isArray(raw.completedSteps) ? raw.completedSteps.filter((x): x is string => typeof x === "string") : [],
    pendingSteps: Array.isArray(raw.pendingSteps) ? raw.pendingSteps.filter((x): x is string => typeof x === "string") : [],
    fileEvidence: Array.isArray(raw.fileEvidence) ? raw.fileEvidence.filter(isFileEvidence) : [],
    findings: Array.isArray(raw.findings) ? raw.findings.filter(isFinding) : [],
    checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints.filter(isCheckpoint) : [],
    sharedEvidenceRefs: Array.isArray(raw.sharedEvidenceRefs) ? raw.sharedEvidenceRefs.filter((x): x is string => typeof x === "string") : [],
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    ...(runState ? { runState } : {}),
  };
}

function isFileEvidence(value: unknown): value is FileEvidence {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return typeof e.path === "string" && typeof e.content === "string" && typeof e.contentHash === "string" && typeof e.version === "string";
}
function isFinding(value: unknown): value is Finding {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  return typeof f.id === "string" && typeof f.summary === "string" && Array.isArray(f.evidenceIds);
}
function isCheckpoint(value: unknown): value is Checkpoint {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return typeof c.id === "string" && typeof c.createdAt === "string" && ["started", "completed", "interrupted"].includes(String(c.status));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(temporary, path);
}

export async function loadTaskState(workspaceRoot: string, taskId: string): Promise<PersistedTaskState | null> {
  if (!safeId(taskId)) return null;
  try { return sanitizeState(JSON.parse(await fs.readFile(statePath(workspaceRoot, taskId), "utf8"))); } catch { return null; }
}

export async function persistTaskState(workspaceRoot: string, state: TaskState): Promise<PersistedTaskState> {
  if (!safeId(state.taskId)) throw new Error(`非法任务 ID: ${state.taskId}`);
  const persisted: PersistedTaskState = { ...copy(state), version: VERSION, updatedAt: new Date().toISOString(), sharedEvidenceRefs: state.fileEvidence.map((e) => `${e.path}:${e.contentHash}`) };
  await writeJson(statePath(workspaceRoot, state.taskId), persisted);
  return persisted;
}

export async function loadSharedEvidence(workspaceRoot: string): Promise<FileEvidence[]> {
  try {
    const raw = JSON.parse(await fs.readFile(sharedPath(workspaceRoot), "utf8"));
    return Array.isArray(raw) ? raw.filter(isFileEvidence) : [];
  } catch { return []; }
}

export async function persistSharedEvidence(workspaceRoot: string, evidence: FileEvidence[]): Promise<void> {
  const existing = await loadSharedEvidence(workspaceRoot);
  const merged = new Map(existing.map((item) => [`${item.path}:${item.contentHash}`, item]));
  for (const item of evidence) merged.set(`${item.path}:${item.contentHash}`, copy(item));
  await writeJson(sharedPath(workspaceRoot), [...merged.values()]);
}

/** 继续任务恢复完整状态；新任务只共享仍完整的证据，不继承任何执行状态。 */
export async function prepareTaskState(
  workspaceRoot: string,
  taskId: string,
  relation: TaskRelation,
  goal: string,
  scope: string[],
  pendingSteps: string[],
  evidence: FileEvidence[] = [],
): Promise<TaskState> {
  const previous = relation === "continue" ? await loadTaskState(workspaceRoot, taskId) : null;
  const shared = await loadSharedEvidence(workspaceRoot);
  if (previous && relation === "continue") return copy(previous);
  const currentByPath = new Map(evidence.map((item) => [item.path, item]));
  const reusableShared = shared.filter((item) => {
    const current = currentByPath.get(item.path);
    return isReusableEvidence(item, current?.version ?? item.version, current?.contentHash);
  });
  const reusable = evidence.filter((item) => isReusableEvidence(item, item.version));
  const mergedEvidence = [...reusableShared, ...reusable];
  const uniqueEvidence = [...new Map(mergedEvidence.map((item) => [`${item.path}:${item.contentHash}`, item])).values()];
  await persistSharedEvidence(workspaceRoot, uniqueEvidence);
  return { taskId, relation, goal, scope: [...scope], completedSteps: [], pendingSteps: [...pendingSteps], fileEvidence: uniqueEvidence, findings: [], checkpoints: [], runState: undefined };
}

export async function persistTaskCheckpoint(
  workspaceRoot: string,
  state: TaskState,
  checkpoint: Checkpoint,
): Promise<PersistedTaskState> {
  const next: TaskState = { ...copy(state), checkpoints: [...state.checkpoints, checkpoint] };
  return persistTaskState(workspaceRoot, next);
}

export function fileEvidenceHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function isReusableEvidence(evidence: FileEvidence, currentVersion: string, currentContentHash?: string): boolean {
  return evidence.complete && evidence.version === currentVersion && (!currentContentHash || evidence.contentHash === currentContentHash) && evidence.contentHash === fileEvidenceHash(evidence.content);
}
