import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import upath from "upath";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";

export interface PlanInfo {
  /** Workspace-relative path using forward slashes */
  path: string;
  title: string;
  mtimeMs: number;
  size: number;
  /** 文件种类：执行计划可批准；文档交付物（PRD/TDD 等）仅查看。 */
  kind: PlanKind;
  /** 归属的聊天会话 ID；null 表示无法归属（手放文件或会话记录已丢失）。 */
  sessionId: string | null;
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

/** 计划生命周期状态。旧 .active.json 无此字段时按 "approved" 处理（向后兼容）。 */
export type PlanStatus = "pending_approval" | "approved" | "executing" | "completed";

/** 计划文件种类：可批准的执行计划 vs 仅查看的文档交付物（PRD/TDD 等）。 */
export type PlanKind = "plan" | "document";

export interface TaskEvidence {
  needId: string;
  summary: string;
  /** Evidence kind: source proves content; navigation only identifies a location. */
  kind?: "source" | "navigation";
  /** Exact, redacted source lines reconstructed from the verified evidence range. */
  excerpt?: string;
  /** Canonical workspace-relative path returned by a successful read_file call. */
  path?: string;
  symbol?: string;
  /** Exact returned read range that grounds this evidence. */
  startLine?: number;
  endLine?: number;
  /** SHA-256 of the full source text returned by read_file. */
  sourceHash?: string;
}

/**
 * 当前子任务可直接复用的相关历史（自由文本）。
 * 可承载已读文件摘录、先前结论、约束、对话事实等，不限于 files 对象。
 */
export type TaskRelevantHistory = string;

function formatRelevantFileBlock(file: {
  path: string;
  content: string;
  startLine?: number;
  endLine?: number;
  note?: string;
}): string {
  const range = file.startLine && file.endLine
    ? ` L${file.startLine}-${file.endLine}`
    : file.startLine
      ? ` L${file.startLine}`
      : "";
  const lines = [`### ${file.path}${range}`];
  if (file.note) lines.push(`note: ${file.note}`);
  lines.push("```", file.content, "```");
  return lines.join("\n");
}

/**
 * 解析 relevantHistory：新格式为字符串；旧 `{ files: [...] }` 对象会转成同等文本，便于兼容已落盘计划。
 */
export function normalizeRelevantHistory(value: unknown): TaskRelevantHistory | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { files?: unknown };
  if (!Array.isArray(raw.files)) return undefined;
  const blocks: string[] = [];
  for (const item of raw.files) {
    if (!item || typeof item !== "object") continue;
    const file = item as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path.trim() : "";
    const content = typeof file.content === "string" ? file.content : "";
    if (!path || !content) continue;
    blocks.push(formatRelevantFileBlock({
      path,
      content,
      startLine: typeof file.startLine === "number" ? file.startLine : undefined,
      endLine: typeof file.endLine === "number" ? file.endLine : undefined,
      note: typeof file.note === "string" ? file.note.trim() || undefined : undefined,
    }));
  }
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

export interface TaskItem {
  id: string;
  /** 1-based line in the approved Spec task document. */
  sourceLine?: number;
  /** 执行指引：指导下属如何完成该任务（关键入口、注意点、建议验证方式）。 */
  executionGuidance: string;
  /** @deprecated 旧字段，读时折叠进 executionGuidance；写入只写 executionGuidance。 */
  description?: string;
  /** @deprecated 旧字段，读时折叠进 executionGuidance；写入只写 executionGuidance。 */
  prompt?: string;
  /** @deprecated 旧字段，读时折叠进 executionGuidance；写入只写 executionGuidance。 */
  guidance?: string;
  status: TaskStatus;
  acceptance?: string;
  dependsOn: string[];
  /** 任务类型：implementation 产出变更，verification 验证正确性（由任务分解写入）。 */
  kind?: "implementation" | "verification";
  result?: string;
  retryCount: number;
  maxRetries: number;
  /** Verification criteria for this task (optional). */
  verificationCriteria?: {
    command: string;
    expectedOutput: string;
    exitCode?: number;
  };
  /** Rollback strategy if this task fails (optional). */
  rollbackStrategy?: string;
  /** Estimated complexity level (optional). */
  estimatedComplexity?: "low" | "medium" | "high";
  /** 当前子任务明确适用的用户约束（由任务分解写入）。 */
  userConstraints?: string[];
  /** 当前子任务在任务分解时的进度状态。 */
  progressStatus?: string;
  /**
   * 当前子任务可复用的全部相关历史（由任务分解写入的自由文本）。
   * React 循环应直接使用，避免对同一内容重复探索。
   */
  relevantHistory?: TaskRelevantHistory;
}

export interface ActivePlanMeta {
  path: string;
  approvedAt: string;
  documentDigest?: string;
  title?: string;
  tasks: TaskItem[];
  currentTaskId: string | null;
  /** 计划生命周期状态。缺省视为 "approved"（旧数据兼容）。 */
  status?: PlanStatus;
  /** 归属的会话 ID。用于多会话场景下的计划隔离。 */
  sessionId?: string | null;
}

export interface PlannerPlanRef {
  sessionId: string;
  planId: string;
  version: number;
  digest: string;
  path: string;
}

export interface PlannerPlan extends PlannerPlanRef {
  sessionId: string;
  mode: "agent" | "spec";
  createdAt: string;
  status: "pending_approval" | "approved" | "revising";
  originalRequest?: string;
  approval?: PlannerPlanRef;
}

function plannerMetaPath(workspaceRoot: string, sessionId: string): string {
  if (!sessionId) throw new Error("计划缺少会话标识");
  return resolve(workspaceRoot, ACTIVE_DIR, `planner-${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

function plannerDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function samePlannerPlan(a: PlannerPlanRef, b: PlannerPlanRef): boolean {
  return !!a.sessionId && a.sessionId === b.sessionId && a.planId === b.planId && a.version === b.version && a.digest === b.digest && a.path === b.path;
}

async function withPlannerLock<T>(workspaceRoot: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
  const target = plannerMetaPath(workspaceRoot, sessionId);
  await fs.mkdir(resolve(workspaceRoot, ACTIVE_DIR), { recursive: true });
  const lock = `${target}.lock`;
  try {
    await fs.mkdir(lock);
  } catch {
    throw new Error("计划状态正在更新，请稍后重试；未授权执行");
  }
  try {
    return await operation();
  } finally {
    await fs.rmdir(lock);
  }
}

async function writePlannerMeta(workspaceRoot: string, plan: PlannerPlan): Promise<void> {
  const target = plannerMetaPath(workspaceRoot, plan.sessionId);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    await fs.rename(temp, target);
    const saved = await readPlannerPlan(workspaceRoot, plan.sessionId);
    if (!saved || JSON.stringify(saved) !== JSON.stringify(plan)) throw new Error("计划状态回读失败");
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

export async function readPlannerPlan(workspaceRoot: string, sessionId: string): Promise<PlannerPlan | null> {
  let raw: string;
  try {
    raw = await fs.readFile(plannerMetaPath(workspaceRoot, sessionId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const plan = JSON.parse(raw) as PlannerPlan;
  if (!plan || !/^[a-f0-9-]{36}$/.test(plan.planId) || !Number.isSafeInteger(plan.version) || plan.version < 1
    || !/^[a-f0-9]{64}$/.test(plan.digest) || plan.sessionId !== sessionId
    || (plan.mode !== "agent" && plan.mode !== "spec") || !plan.createdAt
    || !["pending_approval", "approved", "revising"].includes(plan.status)
    || plan.path !== `${sessionArtifactDir("plans", sessionId)}/${plan.planId}-v${plan.version}.md`
    || (plan.originalRequest !== undefined && typeof plan.originalRequest !== "string")
    || (plan.status === "approved" && !plan.approval)
    || (plan.approval && !samePlannerPlan(plan, plan.approval))) {
    throw new Error("计划版本元数据无效，禁止执行");
  }
  return plan;
}

export async function validatePlannerPlan(workspaceRoot: string, sessionId: string, expected: PlannerPlanRef, approved = false, allowRevising = false): Promise<string> {
  const current = await readPlannerPlan(workspaceRoot, sessionId);
  if (!current || !samePlannerPlan(current, expected) || (current.status === "revising" && !allowRevising)
    || (approved && (current.status !== "approved" || !current.approval || !samePlannerPlan(current, current.approval)))) {
    throw new Error("计划版本或批准已失效，请查看并批准当前版本");
  }
  const content = await readPlanFile(workspaceRoot, current.path, sessionId);
  if (plannerDigest(content) !== current.digest) throw new Error("计划文件内容与摘要不一致，禁止执行");
  const latest = await readPlannerPlan(workspaceRoot, sessionId);
  if (!latest || !samePlannerPlan(latest, current) || latest.status !== current.status
    || (approved && (!latest.approval || !samePlannerPlan(latest, latest.approval)))) {
    throw new Error("校验期间计划发生变化，禁止执行");
  }
  return content;
}

export async function revisePlannerPlan(workspaceRoot: string, sessionId: string, expected: PlannerPlanRef): Promise<void> {
  await withPlannerLock(workspaceRoot, sessionId, async () => {
    const current = await readPlannerPlan(workspaceRoot, sessionId);
    if (!current || !samePlannerPlan(current, expected)) throw new Error("修改请求引用了旧版计划");
    await writePlannerMeta(workspaceRoot, { ...current, status: "revising", approval: undefined });
  });
}

export async function savePlannerPlan(workspaceRoot: string, sessionId: string, mode: "agent" | "spec", content: string, expected?: PlannerPlanRef, originalRequest?: string): Promise<PlannerPlan> {
  return withPlannerLock(workspaceRoot, sessionId, async () => {
    const current = await readPlannerPlan(workspaceRoot, sessionId);
    if ((current && (!expected || !samePlannerPlan(current, expected))) || (!current && expected)) throw new Error("保存时计划版本已变化");
    if (!content.trim()) throw new Error("不能保存空计划");
    const planId = current?.planId ?? randomUUID();
    const version = (current?.version ?? 0) + 1;
    const body = `${content.trim()}\n`;
    const path = await writePlanFile(workspaceRoot, body, { filename: `${planId}-v${version}.md`, sessionId });
    const request = current?.originalRequest ?? originalRequest;
    const plan: PlannerPlan = {
      planId, version, path, sessionId, mode, digest: plannerDigest(body), createdAt: new Date().toISOString(), status: "pending_approval",
      ...(request !== undefined ? { originalRequest: request } : {}),
    };
    if (await readPlanFile(workspaceRoot, path, sessionId) !== body) throw new Error("计划文件回读失败");
    await writePlannerMeta(workspaceRoot, plan);
    await validatePlannerPlan(workspaceRoot, sessionId, plan);
    return plan;
  });
}

export async function approvePlannerPlan(workspaceRoot: string, sessionId: string, expected: PlannerPlanRef): Promise<string> {
  return withPlannerLock(workspaceRoot, sessionId, async () => {
    const content = await validatePlannerPlan(workspaceRoot, sessionId, expected);
    const current = (await readPlannerPlan(workspaceRoot, sessionId))!;
    await writePlannerMeta(workspaceRoot, { ...current, status: "approved", approval: { sessionId, planId: current.planId, version: current.version, path: current.path, digest: current.digest } });
    await validatePlannerPlan(workspaceRoot, sessionId, expected, true);
    return content;
  });
}

const PLANS_DIR = ".owncoder/plans";
/** 会话标识摘要作为稳定目录名，避免路径穿越和命名歧义。 */
export function sessionArtifactDir(kind: "plans" | "specs", sessionId: string): string {
  if (!sessionId?.trim()) throw new Error("文档缺少会话标识");
  return `.owncoder/${kind}/sessions/${createHash("sha256").update(sessionId).digest("hex")}`;
}

export function assertSessionArtifactPath(relPath: string, sessionId: string): void {
  if (!(["plans", "specs"] as const).some((kind) => relPath.startsWith(`${sessionArtifactDir(kind, sessionId)}/`))
    || relPath.includes("\\") || !relPath.endsWith(".md")
    || relPath.slice(".owncoder/".length).split("/").some((part) => !part || part.startsWith("."))) {
    throw new Error("文档不属于当前会话或路径无效");
  }
}

export const ACTIVE_DIR = ".owncoder/plans/.active";

export function plansDirAbs(workspaceRoot: string): string {
  return resolve(workspaceRoot, PLANS_DIR);
}

/** 按路径前缀识别 `.owncoder/plans/` 与 `.owncoder/specs/` 下的路径。
 * 此处不区分文档种类或元数据文件；写入限制由调用方另行校验。 */
export function isPlanPath(relPath: string): boolean {
  const norm = relPath.split(/[/\\]/).join("/").replace(/^\.\//, "");
  return (
    norm === PLANS_DIR ||
    norm.startsWith(`${PLANS_DIR}/`) ||
    norm.startsWith(".owncoder/plans/") ||
    norm.startsWith(".owncoder/specs/")
  );
}

export function assertPlanPath(relPath: string): void {
  if (!isPlanPath(relPath)) {
    throw new Error(`Plan writes only allowed under ${PLANS_DIR}/ (got ${relPath})`);
  }
  const base = relPath.split(/[/\\]/).pop() ?? "";
  if (base === ".active.json" || base === ".index.json") {
    throw new Error("Cannot overwrite plan metadata files via tools");
  }
}

export async function ensurePlansDir(workspaceRoot: string): Promise<string> {
  const dir = plansDirAbs(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function suggestPlanFilename(title?: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = (title ?? "plan")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${stamp}-${slug || "plan"}.md`;
}

export async function writePlanFile(
  workspaceRoot: string,
  content: string,
  opts?: { filename?: string; title?: string; sessionId?: string | null },
): Promise<string> {
  const sessionId = opts?.sessionId;
  if (!sessionId) throw new Error("计划缺少会话标识");
  const dir = sessionArtifactDir("plans", sessionId);
  await fs.mkdir(resolve(workspaceRoot, dir), { recursive: true });
  let name = opts?.filename?.trim() || suggestPlanFilename(opts?.title);
  name = upath.basename(name);
  if (!name.endsWith(".md")) name += ".md";
  if (name.startsWith(".")) throw new Error("invalid plan filename");
  const rel = `${dir}/${name}`;
  const abs = resolve(workspaceRoot, rel);
  // safety: must stay in plans dir
  if (!isPlanPath(rel)) throw new Error("invalid plan path");
  const body = content.trim().startsWith("#")
    ? content
    : `# ${opts?.title ?? name.replace(/\.md$/, "")}\n\n${content}`;
  await fs.writeFile(abs, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  await fs.writeFile(`${abs}.owner.json`, JSON.stringify({ sessionId }), "utf8");
  return rel.split(/[/\\]/).join("/");
}

export async function listPlans(workspaceRoot: string, sessionId?: string): Promise<PlanInfo[]> {
  if (!sessionId) return [];
  const dir = resolve(workspaceRoot, sessionArtifactDir("plans", sessionId));
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const mdFiles = entries.filter(
    (ent) => ent.isFile() && ent.name.endsWith(".md") && !ent.name.startsWith("."),
  );

  const out: PlanInfo[] = [];
  for (const ent of mdFiles) {
    const abs = join(dir, ent.name);
    const st = await fs.stat(abs);
    const rel = `${sessionArtifactDir("plans", sessionId)}/${ent.name}`;
    const text = await readPlanFile(workspaceRoot, rel, sessionId).catch(() => null);
    if (text === null) continue;
    const title = extractTitle(text, ent.name);
    out.push({
      path: rel,
      title,
      mtimeMs: st.mtimeMs,
      size: st.size,
      kind: classifyPlanKind(ent.name, title),
      sessionId,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export async function readPlanFile(workspaceRoot: string, relPath: string, sessionId?: string): Promise<string> {
  if (!sessionId) throw new Error("读取文档缺少会话标识");
  assertSessionArtifactPath(relPath, sessionId);
  const abs = resolve(workspaceRoot, relPath);
  const real = await fs.realpath(abs);
  const sessionRoot = resolve(workspaceRoot, relPath.split("/").slice(0, 4).join("/"));
  if (await fs.realpath(sessionRoot) !== sessionRoot) throw new Error("会话目录不能是链接");
  const relativePath = relative(sessionRoot, real);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("文档链接越过会话目录");
  const owner = JSON.parse(await fs.readFile(`${abs}.owner.json`, "utf8"));
  if (owner.sessionId !== sessionId) throw new Error("文档所属会话不匹配");
  return fs.readFile(abs, "utf8");
}

export /** Get the path for session-scoped active plan meta file. */
function activeMetaPath(workspaceRoot: string, sessionId?: string): string {
  if (!sessionId) {
    throw new Error("活动计划缺少会话标识");
  }
  return resolve(workspaceRoot, ACTIVE_DIR, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

async function ensureActiveDir(workspaceRoot: string): Promise<void> {
  await fs.mkdir(resolve(workspaceRoot, ACTIVE_DIR), { recursive: true });
}

export async function readActiveMeta(workspaceRoot: string, sessionId?: string): Promise<ActivePlanMeta | null> {
  try {
    const path = activeMetaPath(workspaceRoot, sessionId);
    const raw = await fs.readFile(path, "utf8");
    const meta = JSON.parse(raw) as Partial<ActivePlanMeta>;
    if (!sessionId || meta.sessionId !== sessionId || !meta?.path) return null;
    await readPlanFile(workspaceRoot, meta.path, sessionId);
    return normalizeActiveMeta(meta);
  } catch {
    // 无归属的旧全局数据安全失败，不自动认领。
    return null;
  }
}

/** Backfill tasks/currentTaskId for older `.active.json` files. */
export function normalizeActiveMeta(meta: Partial<ActivePlanMeta>): ActivePlanMeta {
  const tasks = normalizeTasks(meta.tasks);
  const currentTaskId = typeof meta.currentTaskId === "string" && tasks.some((task) => task.id === meta.currentTaskId)
    ? meta.currentTaskId
    : null;
  return {
    path: meta.path ?? "",
    sessionId: meta.sessionId,
    approvedAt: meta.approvedAt ?? new Date().toISOString(),
    ...(typeof meta.documentDigest === "string" ? { documentDigest: meta.documentDigest } : {}),
    title: meta.title,
    tasks,
    currentTaskId,
    status: meta.status === "pending_approval" || meta.status === "approved" || meta.status === "executing" || meta.status === "completed"
      ? meta.status
      : "approved",
  };
}


/**
 * 把任务上的执行指引归一化为单一字符串。
 *
 * 读取时以 `executionGuidance` 为首选；缺失的旧字段按
 * description → prompt → guidance 顺序折叠追加（与首选去重），
 * 避免旧轮次里的「怎么做」在升级后丢失。
 */
function foldExecutionGuidance(t: {
  executionGuidance?: unknown;
  description?: unknown;
  prompt?: unknown;
  guidance?: unknown;
}): string {
  const pick = (value: unknown): string =>
    typeof value === "string" ? value.trim() : "";
  const primary = pick(t.executionGuidance);
  const parts = [primary];
  for (const legacy of [pick(t.description), pick(t.prompt), pick(t.guidance)]) {
    if (!legacy) continue;
    if (parts.some((part) => part.includes(legacy))) continue;
    parts.push(legacy);
  }
  return parts.filter(Boolean).join("\n");
}

function normalizeTask(t: Partial<TaskItem>): TaskItem {
  // Parse verification criteria
  let verificationCriteria: TaskItem["verificationCriteria"] = undefined;
  if (t.verificationCriteria && typeof t.verificationCriteria === "object") {
    const vc = t.verificationCriteria as Record<string, unknown>;
    if (typeof vc.command === "string" && typeof vc.expectedOutput === "string") {
      verificationCriteria = {
        command: vc.command,
        expectedOutput: vc.expectedOutput,
        exitCode: typeof vc.exitCode === "number" ? vc.exitCode : 0,
      };
    }
  }
  
  // Parse rollback strategy
  const rollbackStrategy = typeof t.rollbackStrategy === "string" 
    ? t.rollbackStrategy.trim() || undefined 
    : undefined;
  
  // Parse estimated complexity
  const estimatedComplexity = t.estimatedComplexity === "low" || 
    t.estimatedComplexity === "medium" || 
    t.estimatedComplexity === "high"
    ? t.estimatedComplexity
    : undefined;

  const userConstraints = Array.isArray(t.userConstraints)
    ? t.userConstraints.filter((value): value is string => typeof value === "string")
      .map((value) => value.trim()).filter(Boolean)
    : [];
  const progressStatus = typeof t.progressStatus === "string" && t.progressStatus.trim()
    ? t.progressStatus.trim()
    : undefined;
  // 保留子任务可复用的相关历史（字符串；兼容旧 files 对象）
  const relevantHistory = normalizeRelevantHistory(t.relevantHistory);

  return {
    id: typeof t.id === "string" ? t.id : `task_${Math.random().toString(36).slice(2, 8)}`,
    ...(typeof t.sourceLine === "number" && Number.isSafeInteger(t.sourceLine) && t.sourceLine > 0 ? { sourceLine: t.sourceLine } : {}),
    executionGuidance: foldExecutionGuidance(t),
    status: t.status === "in_progress" || t.status === "completed" || t.status === "failed" || t.status === "skipped"
      ? t.status
      : "pending",
    acceptance: typeof t.acceptance === "string" ? t.acceptance : undefined,
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d) => typeof d === "string") : [],
    result: typeof t.result === "string" ? t.result : undefined,
    retryCount: typeof t.retryCount === "number" ? t.retryCount : 0,
    maxRetries: typeof t.maxRetries === "number" ? t.maxRetries : 2,
    verificationCriteria,
    rollbackStrategy,
    estimatedComplexity,
    userConstraints,
    progressStatus,
    relevantHistory,
  };
}

/** Normalize untrusted plan/IPC task arrays into a plan-local unique-ID namespace. */
export function normalizeTasks(value: unknown): TaskItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const task = normalizeTask((raw ?? {}) as Partial<TaskItem>);
    const base = task.id.trim() || `task_${index + 1}`;
    let id = base;
    let suffix = 2;
    while (seen.has(id)) id = `${base}_${suffix++}`;
    seen.add(id);
    return { ...task, id };
  });
}

export async function writeActiveMeta(
  workspaceRoot: string,
  meta: ActivePlanMeta,
  sessionId?: string,
): Promise<void> {
  if (!sessionId || meta.sessionId !== sessionId) throw new Error("活动计划所属会话不匹配");
  await readPlanFile(workspaceRoot, meta.path, sessionId);
  await ensurePlansDir(workspaceRoot);
  if (sessionId) {
    await ensureActiveDir(workspaceRoot);
  }
  const target = activeMetaPath(workspaceRoot, sessionId);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(meta, null, 2) + "\n", "utf8");
    // Same-directory rename gives readers either the previous complete state or
    // the complete new state, never a partially written active task graph.
    await fs.rename(temp, target);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}
export function extractTitle(content: string, fallback: string): string {
  try {
    const tree = fromMarkdown(content);
    for (const node of tree.children) {
      if (node.type === "heading" && node.depth === 1 && "children" in node && node.children?.length) {
        let text = "";
        for (const child of node.children) {
          if ("value" in child && typeof child.value === "string") {
            text += child.value;
          }
        }
        text = text.trim();
        if (text) return text.slice(0, 80);
      }
    }
  } catch {
    // fallback to regex if AST parsing fails
    const m = content.match(/^#\s+(.+)$/m);
    if (m) return m[1]!.trim().slice(0, 80);
  }
  return fallback.replace(/\.md$/, "").trim().slice(0, 80);
}

const DOC_FILE_PREFIX_RE =
  /^(PRD|TDD|BRD|HLD|LLD|SRS|PRODUCT_DOC|TECH_DOC|DESIGN_DOC|SPEC_DOC|PRODUCT-DOC|TECH-DOC)([._\-]|$)/i;
const DOC_TITLE_KEYWORD_RE =
  /(需求文档|产品文档|技术文档|设计文档|方案文档|产品需求文档|技术设计文档)/i;
const DOC_TITLE_PREFIX_RE = /^(PRD|TDD|BRD|HLD|LLD|SRS)\b/i;

/**
 * 启发式判断 `.owncoder/plans/` 下一个 .md 是"执行计划"还是"文档交付物"。
 * 保守策略：仅当文件名/标题明确匹配文档模式才判 document，其余默认 plan（可批准），
 * 避免把执行计划误判为文档导致用户无法批准。
 */
export function classifyPlanKind(filename: string, title: string): PlanKind {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  if (DOC_FILE_PREFIX_RE.test(base)) return "document";
  const t = title.trim();
  if (DOC_TITLE_KEYWORD_RE.test(t)) return "document";
  if (DOC_TITLE_PREFIX_RE.test(t)) return "document";
  return "plan";
}

/** Heuristic file paths mentioned in a plan (for writable-set hint). */
export function extractPathsFromPlan(content: string): string[] {
  const found = new Set<string>();
  const re =
    /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|md|json|toml|yml|yaml|css|html|vue|svelte))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const p = upath.normalize(m[1]!);
    if (!p.startsWith(".owncoder/index")) found.add(p);
    if (found.size >= 40) break;
  }
  return [...found];
}

/** Truncate plan text for context bucket (~4% of a soft window). */
export function truncatePlanForContext(content: string, maxChars = 2500): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n…[plan truncated for context]`;
}

/**
 * Heuristically extract structured tasks from a plan markdown body.
 * Recognises `- [ ]` / `- [x]` checkboxes and ordered list items `1. `.
 * Falls back to a single task wrapping the whole body when nothing matches.
 */
export function parseTasksFromMarkdown(content: string, specDocument = false): TaskItem[] {
  const lines = content.split(/\r?\n/);
  const tasks: TaskItem[] = [];
  const taskEntries: Array<{ index: number; title: string; checked: boolean }> = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (specDocument) {
      const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker && marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = undefined;
        continue;
      }
      if (marker) { fence = marker[1]; continue; }
    }
    const checkbox = line.match(/^\s*(?:[-*]|\d+[.、)])\s+\[([ xX])\]\s+(.+)$/);
    if (checkbox) {
      taskEntries.push({ index: i, title: checkbox[2]!.trim(), checked: checkbox[1]!.toLowerCase() === "x" });
      continue;
    }
    // Compatibility with older plan files; newly saved Spec files still require checkboxes.
    const ordered = specDocument ? null : line.match(/^\s*\d+[.、)]\s+(.+)$/);
    if (ordered) taskEntries.push({ index: i, title: ordered[1]!.trim(), checked: false });
  }

  const fieldPattern = /^\s*(?:[-*+]\s+|>\s*)?(依赖|depends?\s*on|前置|文件|模块|files?|modules?|实现(?:要求)?|implementation|验收|验证|acceptance|verification|需求|requirement)\s*[:：]\s*(.*)$/i;
  const cleanContinuation = (line: string): string => line.replace(/^\s*(?:[-*+]\s+|>\s*)/, "").trim();
  const fieldValue = (fields: Map<string, string[]>, names: string[]): string => {
    for (const name of names) {
      const value = fields.get(name)?.join(" ").trim();
      if (value) return value;
    }
    return "";
  };
  const normalizeDependency = (value: string, position: number): string[] => {
    if (!value || /^(?:无|none|nil|n\/a|-)$/.test(value.trim().toLowerCase())) return [];
    return [...value.matchAll(/(?:task[_ -]?)?(\d+)/gi)]
      .map((match) => `task_${match[1]}`)
      .filter((id, index, all) => all.indexOf(id) === index)
      .filter((id) => specDocument || Number(id.slice(5)) <= position);
  };

  for (let entryIndex = 0; entryIndex < taskEntries.length; entryIndex++) {
    const entry = taskEntries[entryIndex]!;
    const end = taskEntries[entryIndex + 1]?.index ?? lines.length;
    const fields = new Map<string, string[]>();
    const extraLines: string[] = [];
    let currentField = "";
    for (const line of lines.slice(entry.index + 1, end)) {
      if (/^\s*#{1,6}\s/.test(line)) break;
      const match = line.match(fieldPattern);
      if (match) {
        const label = match[1]!.toLowerCase().replace(/\s+/g, " ");
        currentField = label;
        const values = fields.get(label) ?? [];
        if (match[2]!.trim()) values.push(match[2]!.trim());
        fields.set(label, values);
      } else if (currentField && line.trim()) {
        fields.get(currentField)?.push(cleanContinuation(line));
      } else if (line.trim()) {
        extraLines.push(cleanContinuation(line));
      }
    }

    const files = fieldValue(fields, ["文件", "模块", "file", "files", "module", "modules"]);
    const implementation = fieldValue(fields, ["实现", "实现要求", "implementation"]);
    const requirements = fieldValue(fields, ["需求", "requirement"]);
    const acceptance = fieldValue(fields, ["验收", "验证", "acceptance", "verification"]);
    const dependencies = fieldValue(fields, ["依赖", "depends on", "前置"]);
    const guidance = [
      entry.title.replace(/\s*[—–-]\s*$/, ""),
      ...extraLines,
      files ? `文件/模块: ${files}` : "",
      implementation ? `实现: ${implementation}` : "",
      requirements ? `需求: ${requirements}` : "",
    ].filter(Boolean).join("\n").trim();
    if (!guidance) continue;
    const id = `task_${tasks.length + 1}`;
    const hasDependencyField = ["依赖", "depends on", "前置"].some((name) => fields.has(name));
    const explicitDeps = normalizeDependency(dependencies, tasks.length);
    tasks.push({
      id,
      ...(specDocument ? { sourceLine: entry.index + 1 } : {}),
      executionGuidance: guidance,
      status: entry.checked ? "completed" : "pending",
      acceptance: acceptance || undefined,
      dependsOn: hasDependencyField ? explicitDeps : tasks.length > 0 ? [`task_${tasks.length}`] : [],
      retryCount: 0,
      maxRetries: 2,
    });
  }

  if (!specDocument && tasks.length === 0) {
    const compact = content.trim().replace(/\n{2,}/g, "\n").slice(0, 400);
    if (compact) {
      tasks.push({
        id: "task_1",
        executionGuidance: compact,
        status: "pending",
        dependsOn: [],
        retryCount: 0,
        maxRetries: 2,
      });
    }
  }
  return tasks;
}

/** Pick the next task whose dependencies are all done/skipped. */
export function selectNextPendingTask(tasks: TaskItem[]): TaskItem | null {
  for (const t of tasks) {
    if (t.status !== "pending") continue;
    const ready = t.dependsOn.every((dep) => {
      const d = tasks.find((x) => x.id === dep);
      return d && (d.status === "completed" || d.status === "skipped");
    });
    if (ready) return t;
  }
  return null;
}


/** Completed vs total counts for progress UI. */
export function taskProgress(tasks: TaskItem[]): { done: number; total: number } {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "completed" || t.status === "skipped").length;
  return { done, total };
}

// ── 动态任务清单（add_tasks 工具的纯函数核心） ─────────────────────────────
// 任务分解产出的是初始清单；执行中模型可以增删改，把它当作"活清单"：
// 探索发现分解有误或遗漏时，模型直接改清单而不是重新分解一整轮。
// 两处消费方共享本函数：顺序 ReAct 路径（react.ts 闭包改
// ctx.tasks）与任务图路径（调度器闭包改共享数组，新任务经 readyTasks 自然
// 进入派发）。原地修改 + 浅拷贝草稿：任何校验失败整体不应用（原子性），
// 成功时保持数组引用不变（react-text-branch / 调度器持有同一份引用）。

export interface TaskListAddOp {
  /** 显式 id 可选；省略时自动分配 t{n}（不与现有 id 冲突）。 */
  id?: string;
  title?: string;
  /** 执行指引：指导下属如何完成该任务。 */
  executionGuidance?: string;
  /** @deprecated 旧字段，读时折叠进 executionGuidance。 */
  description?: string;
  /** @deprecated 旧字段，读时折叠进 executionGuidance。 */
  prompt?: string;
  /** @deprecated 旧字段，读时折叠进 executionGuidance。 */
  guidance?: string;
  kind?: "implementation" | "verification";
  dependsOn?: string[];
}

export interface TaskListOps {
  add?: TaskListAddOp[];
}

export type TaskListApplyOutcome =
  | { ok: true; summary: string }
  | { ok: false; error: string };

/** 依赖成环检测（含自环）：DFS 三色标记，返回环路径（首尾重复）或 null。 */
function findDependencyCycle(tasks: TaskItem[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visited.has(id)) return null;
    if (visiting.has(id)) return stack.slice(stack.indexOf(id)).concat(id);
    const task = byId.get(id);
    if (!task) return null;
    visiting.add(id);
    stack.push(id);
    for (const dep of task.dependsOn) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const task of tasks) {
    const found = visit(task.id);
    if (found) return found;
  }
  return null;
}

/** 自动 id：取 t{n} 中 n 的最大值 +1；byId 随同批 add 实时增长，连续分配不冲突。 */
function nextAutoTaskId(byId: Map<string, TaskItem>): string {
  let max = 0;
  for (const id of byId.keys()) {
    const m = /^t(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (byId.has(`t${n}`)) n++;
  return `t${n}`;
}

/** 渲染当前清单（add_tasks 的工具结果带这份，让模型看到变更生效）。 */
export function formatTaskList(tasks: TaskItem[]): string {
  const shown = tasks.slice(0, 40);
  const lines = shown.map((t) =>
    `- [${t.status}] ${t.id}: ${t.executionGuidance}${t.dependsOn.length ? ` (dependsOn: ${t.dependsOn.join(", ")})` : ""}`,
  );
  if (tasks.length > shown.length) lines.push(`… 共 ${tasks.length} 个任务，仅显示前 ${shown.length} 个`);
  return lines.join("\n");
}

function addTaskListItems(
  draft: TaskItem[],
  byId: Map<string, TaskItem>,
  adds: TaskListAddOp[],
  depCheckList: Array<{ owner: string; dependsOn: string[] }>,
  addedIds: string[],
): TaskListApplyOutcome | null {
  for (const op of adds) {
    // 归一化入口：新旧字段在这里折叠成 executionGuidance，下游只见新字段。
    const executionGuidance = foldExecutionGuidance(op);
    if (!executionGuidance) {
      return { ok: false, error: `add 任务失败：executionGuidance 必填（${op.id ? `id ${op.id}` : "无 id"}）。` };
    }
    const id = op.id?.trim() || nextAutoTaskId(byId);
    if (byId.has(id)) {
      return { ok: false, error: `add 任务失败：id "${id}" 已存在，换一个 id 或省略 id 自动分配。` };
    }
    const task: TaskItem = {
      id,
      executionGuidance,
      status: "pending",
      dependsOn: op.dependsOn ? [...op.dependsOn] : [],
      retryCount: 0,
      maxRetries: 2,
      ...(op.title?.trim() ? { progressStatus: op.title.trim() } : {}),
      ...(op.kind ? { kind: op.kind } : {}),
    };
    draft.push(task);
    byId.set(id, task);
    addedIds.push(id);
    if (op.dependsOn?.length) depCheckList.push({ owner: id, dependsOn: op.dependsOn });
  }
  return null;
}

/**
 * 把一批新增应用到任务清单（原地，append-only）。
 *
 * 校验（任一失败整体不应用）：
 * - add：id 不得与现有或同批新增冲突；executionGuidance 必填
 * - dependsOn：必须指向最终 id 集合（现有 + 同批新增），禁止自环
 * - 最终依赖图禁止成环
 *
 * 执行期计划只能追加新任务（对应 Codex 的 followup_task），不允许修改
 * 或删除既有任务——既有任务的终态由顺序任务驱动器判定。
 */
export function applyTaskListOps(tasks: TaskItem[], ops: TaskListOps): TaskListApplyOutcome {
  const adds = ops.add ?? [];
  if (adds.length === 0) {
    return { ok: false, error: "add_tasks 参数错误：add 必须提供非空数组。" };
  }

  // 草稿：浅拷贝，原子提交前不触碰真实数组。
  const draft: TaskItem[] = tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn] }));
  const byId = new Map(draft.map((t) => [t.id, t]));

  // 依赖校验清单（add 与 update 的 dependsOn 统一在全部落地后校验——
  // 这样 add 的依赖可以引用同批后出现的 add id）。
  const depCheckList: Array<{ owner: string; dependsOn: string[] }> = [];
  const addedIds: string[] = [];

  // 新增与更新分别执行，新增先落地以允许同批任务互相依赖。
  const addOutcome = addTaskListItems(draft, byId, adds, depCheckList, addedIds);
  if (addOutcome) return addOutcome;

  // ── 3. 依赖校验（统一在 add/update 落地后：同批 id 可见，禁止自环与悬空） ──
  for (const { owner, dependsOn } of depCheckList) {
    for (const dep of dependsOn) {
      if (dep === owner) {
        return { ok: false, error: `依赖校验失败：任务 "${owner}" 的 dependsOn 包含自身。` };
      }
      if (!byId.has(dep)) {
        return { ok: false, error: `依赖校验失败：任务 "${owner}" 的 dependsOn 引用了不存在的 id "${dep}"（可以是本批 add 的 id）。` };
      }
    }
  }

  // ── 4. 成环校验（作用于最终图） ──
  const cycle = findDependencyCycle(draft);
  if (cycle) {
    return { ok: false, error: `依赖成环，拒绝应用：${cycle.join(" → ")}。` };
  }

  // ── 5. 原子提交：保持原数组引用（调用方持有同一份引用） ──
  tasks.length = 0;
  tasks.push(...draft);

  return {
    ok: true,
    summary: `added ${addedIds.join(", ")}.\nCurrent task list:\n${formatTaskList(draft)}`,
  };
}
