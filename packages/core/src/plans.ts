import { promises as fs } from "node:fs";
import upath from "upath";
import { isAbsolute, join, resolve } from "node:path";
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
  description: string;
  status: TaskStatus;
  acceptance?: string;
  dependsOn: string[];
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
  title?: string;
  tasks: TaskItem[];
  currentTaskId: string | null;
  /** 计划生命周期状态。缺省视为 "approved"（旧数据兼容）。 */
  status?: PlanStatus;
  /** 归属的会话 ID。用于多会话场景下的计划隔离。 */
  sessionId?: string | null;
}

const PLANS_DIR = ".owncoder/plans";
const ACTIVE_FILE = ".owncoder/plans/.active.json";
export const ACTIVE_DIR = ".owncoder/plans/.active";
/** Sidecar index mapping plan filename -> owning chat session id. */
const PLANS_INDEX_FILE = ".owncoder/plans/.index.json";
const SESSIONS_DIR = ".owncoder/sessions";
/** Matches the tool output emitted by save_plan ("Saved plan: .owncoder/plans/x.md"). */
const SAVED_PLAN_RE = /Saved plan: (\.owncoder\/plans\/[^\s`"')]+)/g;

interface PlansIndexFile {
  version: 1;
  /** plan filename -> owning chat session id (null = unknown/legacy). */
  entries: Record<string, string | null>;
}


export function plansDirAbs(workspaceRoot: string): string {
  return resolve(workspaceRoot, PLANS_DIR);
}

/** True if path is under `.owncoder/plans/` (not the index cache). */
export function isPlanPath(relPath: string): boolean {
  const norm = relPath.split(/[/\\]/).join("/").replace(/^\.\//, "");
  return (
    norm === PLANS_DIR ||
    norm.startsWith(`${PLANS_DIR}/`) ||
    norm.startsWith(".owncoder/plans/")
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
  await ensurePlansDir(workspaceRoot);
  let name = opts?.filename?.trim() || suggestPlanFilename(opts?.title);
  name = upath.basename(name);
  if (!name.endsWith(".md")) name += ".md";
  if (name.startsWith(".")) throw new Error("invalid plan filename");
  const rel = `${PLANS_DIR}/${name}`;
  const abs = resolve(workspaceRoot, rel);
  // safety: must stay in plans dir
  if (!isPlanPath(rel)) throw new Error("invalid plan path");
  const body = content.trim().startsWith("#")
    ? content
    : `# ${opts?.title ?? name.replace(/\.md$/, "")}\n\n${content}`;
  await fs.writeFile(abs, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  if (opts?.sessionId) {
    await setPlanOwner(workspaceRoot, name, opts.sessionId);
  }
  return rel.split(/[/\\]/).join("/");
}

async function readPlansIndex(workspaceRoot: string): Promise<PlansIndexFile> {
  try {
    const raw = await fs.readFile(resolve(workspaceRoot, PLANS_INDEX_FILE), "utf8");
    const data = JSON.parse(raw) as Partial<PlansIndexFile>;
    if (data?.version !== 1 || !data.entries || typeof data.entries !== "object") {
      return { version: 1, entries: {} };
    }
    const entries: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(data.entries)) {
      entries[key] = typeof value === "string" && value.trim() ? value : null;
    }
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

async function writePlansIndex(workspaceRoot: string, index: PlansIndexFile): Promise<void> {
  await ensurePlansDir(workspaceRoot);
  const target = resolve(workspaceRoot, PLANS_INDEX_FILE);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(index, null, 2) + "\n", "utf8");
    // Same-directory rename keeps readers on a complete state (see writeActiveMeta).
    await fs.rename(temp, target);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Record which chat session owns a plan file. */
async function setPlanOwner(
  workspaceRoot: string,
  filename: string,
  sessionId: string | null,
): Promise<void> {
  const index = await readPlansIndex(workspaceRoot);
  index.entries[filename] = sessionId;
  await writePlansIndex(workspaceRoot, index);
}

/**
 * Backfill ownership for plan files that predate the session-scoped index by
 * scanning persisted chat sessions: each session's `lastPlanPath` plus every
 * "Saved plan: <path>" tool output in its history identifies its plan files.
 * Sessions are visited newest-first so a plan saved by several sessions belongs
 * to the most recent one.
 */
async function inferPlanOwnersFromSessions(
  workspaceRoot: string,
  missing: string[],
): Promise<Record<string, string>> {
  if (missing.length === 0) return {};
  const wanted = new Set(missing);
  const owners: Record<string, string> = {};
  const dir = resolve(workspaceRoot, SESSIONS_DIR);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json") && f !== "index.json");
  } catch {
    return {};
  }
  const stamped: { file: string; updatedAt: string }[] = [];
  for (const file of files) {
    try {
      const st = await fs.stat(join(dir, file));
      stamped.push({ file, updatedAt: st.mtime.toISOString() });
    } catch {
      /* skip unreadable */
    }
  }
  stamped.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const { file } of stamped) {
    let data: {
      id?: string;
      lastPlanPath?: string | null;
      history?: Array<{ content?: unknown }>;
    };
    try {
      data = JSON.parse(await fs.readFile(join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;
    const sid = typeof data.id === "string" && data.id ? data.id : file.replace(/\.json$/, "");
    const paths = new Set<string>();
    if (typeof data.lastPlanPath === "string") paths.add(data.lastPlanPath);
    if (Array.isArray(data.history)) {
      for (const turn of data.history) {
        if (typeof turn?.content !== "string") continue;
        for (const match of turn.content.matchAll(SAVED_PLAN_RE)) {
          paths.add(match[1]!);
        }
      }
    }
    for (const p of paths) {
      const name = p.split("/").pop() ?? "";
      if (wanted.has(name) && !(name in owners)) owners[name] = sid;
    }
  }
  return owners;
}

export async function listPlans(workspaceRoot: string): Promise<PlanInfo[]> {
  const dir = plansDirAbs(workspaceRoot);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const mdFiles = entries.filter(
    (ent) => ent.isFile() && ent.name.endsWith(".md") && !ent.name.startsWith("."),
  );
  const index = await readPlansIndex(workspaceRoot);
  const missing = mdFiles.map((ent) => ent.name).filter((name) => !(name in index.entries));
  if (missing.length > 0) {
    const inferred = await inferPlanOwnersFromSessions(workspaceRoot, missing);
    for (const name of missing) {
      index.entries[name] = inferred[name] ?? null;
    }
    try {
      await writePlansIndex(workspaceRoot, index);
    } catch {
      /* index write failure must not break listing */
    }
  }
  const out: PlanInfo[] = [];
  for (const ent of mdFiles) {
    const abs = join(dir, ent.name);
    const st = await fs.stat(abs);
    const rel = `${PLANS_DIR}/${ent.name}`;
    const text = await fs.readFile(abs, "utf8").catch(() => "");
    const title = extractTitle(text, ent.name);
    out.push({
      path: rel,
      title,
      mtimeMs: st.mtimeMs,
      size: st.size,
      kind: classifyPlanKind(ent.name, title),
      sessionId: index.entries[ent.name] ?? null,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export async function readPlanFile(workspaceRoot: string, relPath: string): Promise<string> {
  assertPlanPath(relPath);
  // 如果是绝对路径，直接使用；相对路径基于工作区解析
  const abs = isAbsolute(relPath) ? relPath : resolve(workspaceRoot, relPath);
  return fs.readFile(abs, "utf8");
}

export /** Get the path for session-scoped active plan meta file. */
function activeMetaPath(workspaceRoot: string, sessionId?: string): string {
  if (!sessionId) {
    // 向后兼容：无 sessionId 时使用旧的全局文件
    return resolve(workspaceRoot, ACTIVE_FILE);
  }
  return resolve(workspaceRoot, ACTIVE_DIR, `${sessionId}.json`);
}

async function ensureActiveDir(workspaceRoot: string): Promise<void> {
  await fs.mkdir(resolve(workspaceRoot, ACTIVE_DIR), { recursive: true });
}

export async function readActiveMeta(workspaceRoot: string, sessionId?: string): Promise<ActivePlanMeta | null> {
  try {
    const path = activeMetaPath(workspaceRoot, sessionId);
    const raw = await fs.readFile(path, "utf8");
    const meta = JSON.parse(raw) as Partial<ActivePlanMeta>;
    if (!meta?.path || !isPlanPath(meta.path)) return null;
    return normalizeActiveMeta(meta);
  } catch {
    // 尝试读取旧的全局文件（向后兼容）
    if (sessionId) {
      try {
        const raw = await fs.readFile(resolve(workspaceRoot, ACTIVE_FILE), "utf8");
        const meta = JSON.parse(raw) as Partial<ActivePlanMeta>;
        if (!meta?.path || !isPlanPath(meta.path)) return null;
        const normalized = normalizeActiveMeta(meta);
        // 如果全局文件没有 sessionId，说明是旧版本，迁移到 session-scoped 文件
        if (!normalized.sessionId) {
          normalized.sessionId = sessionId;
          await writeActiveMeta(workspaceRoot, normalized, sessionId);
          // 不删除旧文件，以防其他 session 还在使用
        }
        // 如果 sessionId 匹配，返回
        if (normalized.sessionId === sessionId) {
          return normalized;
        }
      } catch {
        // 旧文件也不存在，返回 null
      }
    }
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
    approvedAt: meta.approvedAt ?? new Date().toISOString(),
    title: meta.title,
    tasks,
    currentTaskId,
    status: meta.status === "pending_approval" || meta.status === "approved" || meta.status === "executing" || meta.status === "completed"
      ? meta.status
      : "approved",
  };
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
    description: typeof t.description === "string" ? t.description : "",
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

export async function clearActiveMeta(workspaceRoot: string): Promise<void> {
  try {
    await fs.unlink(resolve(workspaceRoot, ACTIVE_FILE));
  } catch {
    /* ignore */
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
export function parseTasksFromMarkdown(content: string): TaskItem[] {
  const lines = content.split(/\r?\n/);
  const tasks: TaskItem[] = [];
  let idx = 0;
  const push = (
    description: string,
    acceptance?: string,
  ) => {
    const d = description.trim();
    if (!d) return;
    idx += 1;
    tasks.push({
      id: `task_${idx}`,
      description: d,
      status: "pending",
      acceptance: acceptance?.trim() || undefined,
      dependsOn: idx > 1 ? [`task_${idx - 1}`] : [],
      retryCount: 0,
      maxRetries: 2,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const box = line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/);
    if (box) {
      const desc = box[1]!.replace(/\s*[—–-]\s*$/, "");
      const acc = lines[i + 1]?.match(/^\s*[>/*]?\s*(?:验收|acceptance|验证)[:：]\s*(.+)$/i)?.[1];
      push(desc, acc);
      continue;
    }
    const ord = line.match(/^\s*(\d+)[.、)]\s+(.+)$/);
    if (ord) {
      const desc = ord[2]!;
      const acc = lines[i + 1]?.match(/^\s*[>/*]?\s*(?:验收|acceptance|验证)[:：]\s*(.+)$/i)?.[1];
      push(desc, acc);
      continue;
    }
  }

  if (tasks.length === 0) {
    const compact = content.trim().replace(/\n{2,}/g, "\n").slice(0, 400);
    if (compact) {
      tasks.push({
        id: "task_1",
        description: compact,
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
