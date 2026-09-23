import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentMode } from "@owncoder/shared";
import type { ChatTurn, DocumentWorkflowState } from "./harness/loop/types.ts";
import type { TerminalEntry } from "./harness/terminal.ts";
import { restoreTaskRunState } from "./task-run.ts";

const LEGACY_SESSION_FILE = ".owncoder/session.json";
const SESSIONS_DIR = ".owncoder/sessions";
/** Pre-rename sessions tree (owncode → owncoder). */
const LEGACY_SESSIONS_DIR = ".owncode/sessions";
const LEGACY_SINGLE_SESSION_FILE = ".owncode/session.json";
const INDEX_FILE = "index.json";
const MAX_TERMINAL = 80;

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  pinned?: boolean;
}

export interface PersistedSession {
  version: 1;
  id?: string;
  title?: string;
  updatedAt: string;
  createdAt?: string;
  mode: AgentMode;
  history: ChatTurn[];
  terminalLog: TerminalEntry[];
  lastPlanPath: string | null;
  todoAnchor: string | null;
  lastCheckpointId: string | null;
  /** Optional for backward compatibility with saved pre-document-workflow sessions. */
  documentWorkflow?: DocumentWorkflowState | null;
  /** Queued (sent while a turn was running) user messages, persisted so they survive restarts. */
  queuedMessages?: string[];
  /** 统一任务运行状态；旧会话可能缺失，读取时兼容。 */
  taskRunState?: import("./task-run.ts").TaskRunState | null;
}

interface SessionsIndex {
  version: 1;
  activeId: string | null;
  sessions: SessionMeta[];
}

export function sessionsDirAbs(workspaceRoot: string): string {
  return resolve(workspaceRoot, SESSIONS_DIR);
}

function indexPath(workspaceRoot: string): string {
  return join(sessionsDirAbs(workspaceRoot), INDEX_FILE);
}

function sessionFilePath(workspaceRoot: string, id: string): string {
  return join(sessionsDirAbs(workspaceRoot), `${id}.json`);
}

export function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function titleFromHistory(history: ChatTurn[], fallback = "新会话"): string {
  const user = history.find((h) => h.role === "user" && h.content.trim());
  if (!user) return fallback;
  const t = user.content.trim().replace(/\s+/g, " ");
  return t.length > 42 ? `${t.slice(0, 42)}…` : t;
}

function sortSessions(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((a, b) => {
    const ap = a.pinned ? 1 : 0;
    const bp = b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  });
}

async function readIndex(workspaceRoot: string): Promise<SessionsIndex> {
  try {
    const raw = await fs.readFile(indexPath(workspaceRoot), "utf8");
    const data = JSON.parse(raw) as SessionsIndex;
    if (data?.version !== 1 || !Array.isArray(data.sessions)) {
      return { version: 1, activeId: null, sessions: [] };
    }
    return data;
  } catch {
    return { version: 1, activeId: null, sessions: [] };
  }
}

async function writeIndex(workspaceRoot: string, index: SessionsIndex): Promise<void> {
  await fs.mkdir(sessionsDirAbs(workspaceRoot), { recursive: true });
  await fs.writeFile(indexPath(workspaceRoot), JSON.stringify(index, null, 2) + "\n", "utf8");
}

/**
 * If `.owncoder/sessions` is empty but `.owncode/sessions` still has data
 * (rename skipped because both dirs existed), copy the sessions tree forward.
 */
async function adoptLegacySessionsDir(workspaceRoot: string): Promise<boolean> {
  const currentDir = sessionsDirAbs(workspaceRoot);
  const legacyDir = resolve(workspaceRoot, LEGACY_SESSIONS_DIR);
  try {
    await fs.access(legacyDir);
  } catch {
    return false;
  }
  try {
    const existing = await fs.readdir(currentDir).catch(() => [] as string[]);
    if (existing.length > 0) return false;
  } catch {
    /* current missing — ok */
  }
  try {
    await fs.mkdir(resolve(workspaceRoot, ".owncoder"), { recursive: true });
    // Node 16+ fs.cp; fall back to rename when possible.
    const cp = (fs as unknown as { cp?: typeof fs.cp }).cp;
    if (typeof cp === "function") {
      await cp(legacyDir, currentDir, { recursive: true });
    } else {
      await fs.rename(legacyDir, currentDir);
    }
    console.info(`[session-store] adopted legacy sessions ${legacyDir} → ${currentDir}`);
    return true;
  } catch (err) {
    console.warn(`[session-store] adopt legacy sessions failed:`, err);
    return false;
  }
}

/** Migrate legacy single session.json into sessions/ if needed. */
export async function ensureSessionsMigrated(workspaceRoot: string): Promise<SessionsIndex> {
  await adoptLegacySessionsDir(workspaceRoot);
  let index = await readIndex(workspaceRoot);
  if (index.sessions.length > 0) return index;

  const candidates = [
    resolve(workspaceRoot, LEGACY_SESSION_FILE),
    resolve(workspaceRoot, LEGACY_SINGLE_SESSION_FILE),
  ];
  for (const legacyAbs of candidates) {
    try {
      const raw = await fs.readFile(legacyAbs, "utf8");
      const data = JSON.parse(raw) as PersistedSession;
      if (data?.version === 1 && Array.isArray(data.history)) {
        const id = newSessionId();
        const createdAt = data.updatedAt || new Date().toISOString();
        const title = titleFromHistory(data.history, "恢复的会话");
        const full: PersistedSession = {
          ...sanitizeSession(data),
          id,
          title,
          createdAt,
          updatedAt: createdAt,
        };
        await fs.mkdir(sessionsDirAbs(workspaceRoot), { recursive: true });
        await fs.writeFile(sessionFilePath(workspaceRoot, id), JSON.stringify(full, null, 2) + "\n", "utf8");
        index = {
          version: 1,
          activeId: id,
          sessions: [{ id, title, createdAt, updatedAt: createdAt }],
        };
        await writeIndex(workspaceRoot, index);
        return index;
      }
    } catch {
      /* try next candidate */
    }
  }
  return index;
}

export async function listSessionMetas(workspaceRoot: string): Promise<{
  activeId: string | null;
  sessions: SessionMeta[];
}> {
  const index = await ensureSessionsMigrated(workspaceRoot);
  return { activeId: index.activeId, sessions: sortSessions(index.sessions) };
}

export async function toggleSessionPin(workspaceRoot: string, id: string): Promise<SessionMeta[]> {
  const index = await readIndex(workspaceRoot);
  const session = index.sessions.find((s) => s.id === id);
  if (!session) throw new Error(`找不到会话：${id}`);
  session.pinned = !session.pinned;
  await writeIndex(workspaceRoot, index);
  return sortSessions(index.sessions);
}

export async function loadSessionById(
  workspaceRoot: string,
  id: string,
): Promise<PersistedSession | null> {
  try {
    const raw = await fs.readFile(sessionFilePath(workspaceRoot, id), "utf8");
    const data = JSON.parse(raw) as PersistedSession;
    if (data?.version !== 1 || !Array.isArray(data.history)) return null;
    return { ...sanitizeSession(data), id };
  } catch {
    return null;
  }
}

export async function createSessionFile(
  workspaceRoot: string,
  opts?: { title?: string; mode?: AgentMode },
): Promise<{ meta: SessionMeta; session: PersistedSession }> {
  await ensureSessionsMigrated(workspaceRoot);
  const id = newSessionId();
  const now = new Date().toISOString();
  const title = opts?.title?.trim() || "新会话";
  const session: PersistedSession = {
    version: 1,
    id,
    title,
    createdAt: now,
    updatedAt: now,
    mode: opts?.mode ?? "agent",
    history: [],
    terminalLog: [],
    lastPlanPath: null,
    todoAnchor: null,
    lastCheckpointId: null,
    documentWorkflow: null,
  };
  await fs.mkdir(sessionsDirAbs(workspaceRoot), { recursive: true });
  await fs.writeFile(sessionFilePath(workspaceRoot, id), JSON.stringify(session, null, 2) + "\n", "utf8");
  const index = await readIndex(workspaceRoot);
  const meta: SessionMeta = { id, title, createdAt: now, updatedAt: now };
  index.sessions.unshift(meta);
  index.activeId = id;
  await writeIndex(workspaceRoot, index);
  return { meta, session };
}

export async function saveSessionById(
  workspaceRoot: string,
  id: string,
  snap: Omit<PersistedSession, "version" | "updatedAt" | "id"> & {
    title?: string;
    createdAt?: string;
  },
): Promise<SessionMeta> {
  const prev = await loadSessionById(workspaceRoot, id);
  const now = new Date().toISOString();
  const title =
    snap.title?.trim() || titleFromHistory(snap.history, prev?.title || "新会话");
  const full: PersistedSession = {
    version: 1,
    id,
    title,
    createdAt: snap.createdAt || prev?.createdAt || now,
    updatedAt: now,
    mode: snap.mode,
    history: sanitizeHistory(snap.history),
    terminalLog: (snap.terminalLog ?? []).slice(-MAX_TERMINAL),
    lastPlanPath: snap.lastPlanPath,
    todoAnchor: snap.todoAnchor,
    lastCheckpointId: snap.lastCheckpointId,
    documentWorkflow: snap.documentWorkflow ?? null,
    queuedMessages: sanitizeQueuedMessages(snap.queuedMessages),
    taskRunState: snap.taskRunState === undefined
      ? (prev?.taskRunState ?? null)
      : (restoreTaskRunState(snap.taskRunState, id) ?? null),
  };
  await fs.mkdir(sessionsDirAbs(workspaceRoot), { recursive: true });
  // Stringify once and write session + legacy in parallel. Pretty-printing the
  // full history twice was the main cost of the turn-end persist (report already
  // on screen, UI still waiting for「已完成」).
  const encoded = JSON.stringify(full, null, 2) + "\n";
  const writeSession = fs.writeFile(sessionFilePath(workspaceRoot, id), encoded, "utf8");
  const writeLegacy = fs.writeFile(resolve(workspaceRoot, LEGACY_SESSION_FILE), encoded, "utf8").catch(() => undefined);

  const index = await readIndex(workspaceRoot);
  const meta: SessionMeta = {
    id,
    title,
    createdAt: full.createdAt!,
    updatedAt: now,
  };
  const i = index.sessions.findIndex((s) => s.id === id);
  if (i >= 0) index.sessions[i] = meta;
  else index.sessions.unshift(meta);
  index.activeId = id;
  index.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  index.sessions = sortSessions(index.sessions);
  await Promise.all([writeSession, writeLegacy, writeIndex(workspaceRoot, index)]);
  return meta;
}

export async function setActiveSessionId(workspaceRoot: string, id: string): Promise<void> {
  const index = await readIndex(workspaceRoot);
  if (!index.sessions.some((s) => s.id === id)) return;
  index.activeId = id;
  await writeIndex(workspaceRoot, index);
}

export async function deleteSessionFile(workspaceRoot: string, id: string): Promise<string | null> {
  const index = await readIndex(workspaceRoot);
  index.sessions = index.sessions.filter((s) => s.id !== id);
  try {
    await fs.unlink(sessionFilePath(workspaceRoot, id));
  } catch {
    /* ignore */
  }
  if (index.activeId === id) {
    index.activeId = index.sessions[0]?.id ?? null;
  }
  await writeIndex(workspaceRoot, index);
  return index.activeId;
}


export async function savePersistedSession(
  workspaceRoot: string,
  snap: Omit<PersistedSession, "version" | "updatedAt">,
): Promise<void> {
  const { activeId, sessions } = await listSessionMetas(workspaceRoot);
  let id = activeId ?? sessions[0]?.id;
  if (!id) {
    const created = await createSessionFile(workspaceRoot, { mode: snap.mode });
    id = created.meta.id;
  }
  await saveSessionById(workspaceRoot, id, snap);
}

export async function clearPersistedSession(workspaceRoot: string): Promise<void> {
  const { activeId } = await listSessionMetas(workspaceRoot);
  if (activeId) {
    await saveSessionById(workspaceRoot, activeId, {
      mode: "plan",
      history: [],
      terminalLog: [],
      lastPlanPath: null,
      todoAnchor: null,
      lastCheckpointId: null,
      documentWorkflow: null,
      queuedMessages: [],
      title: "新会话",
    });
  }
  try {
    await fs.unlink(resolve(workspaceRoot, LEGACY_SESSION_FILE));
  } catch {
    /* ignore */
  }
}

function sanitizeSession(data: PersistedSession): PersistedSession {
  const taskId = typeof data.id === "string" ? data.id : undefined;
  return {
    version: 1,
    id: data.id,
    title: data.title,
    updatedAt: data.updatedAt ?? new Date().toISOString(),
    createdAt: data.createdAt,
    mode: data.mode === "agent" ? "agent" : "plan",
    history: sanitizeHistory(data.history),
    terminalLog: Array.isArray(data.terminalLog) ? data.terminalLog.slice(-MAX_TERMINAL) : [],
    lastPlanPath: data.lastPlanPath ?? null,
    todoAnchor: data.todoAnchor ?? null,
    lastCheckpointId: data.lastCheckpointId ?? null,
    documentWorkflow: sanitizeDocumentWorkflow(data.documentWorkflow),
    queuedMessages: sanitizeQueuedMessages(data.queuedMessages),
    taskRunState: restoreTaskRunState(data.taskRunState, taskId) ?? null,
  };
}

function sanitizeQueuedMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((m): m is string => typeof m === "string" && m.length > 0);
}

function sanitizeDocumentWorkflow(value: unknown): DocumentWorkflowState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<DocumentWorkflowState>;
  if (
    (state.stage !== "awaiting_prd_confirmation" && state.stage !== "awaiting_tdd_confirmation") ||
    typeof state.documentPath !== "string" ||
    !state.documentPath.trim() ||
    typeof state.updatedAt !== "string"
  ) {
    return null;
  }
  // 兼容旧数据：allDocuments 可选
  const allDocuments = Array.isArray(state.allDocuments)
    ? state.allDocuments.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : undefined;
  
  // 解析新的 documents 元数据
  let documents: import("./harness/loop/types.ts").DocumentMetadata[] | undefined;
  if (Array.isArray(state.documents)) {
    documents = state.documents
      .map((d): import("./harness/loop/types.ts").DocumentMetadata | null => {
        if (!d || typeof d !== "object") return null;
        const doc = d as any;
        const path = typeof doc.path === "string" ? doc.path : "";
        if (!path.trim()) return null;
        
        return {
          type: (doc.type === "prd" || doc.type === "tdd" || doc.type === "design" || doc.type === "architecture" || doc.type === "other"
            ? doc.type
            : "other") as import("./harness/loop/types.ts").DocumentType,
          path,
          createdAt: typeof doc.createdAt === "string" ? doc.createdAt : new Date().toISOString(),
          status: (doc.status === "pending_approval" || doc.status === "approved" || doc.status === "modified"
            ? doc.status
            : "pending_approval") as import("./harness/loop/types.ts").DocumentStatus,
          basedOn: Array.isArray(doc.basedOn) 
            ? doc.basedOn.filter((p: unknown): p is string => typeof p === "string")
            : undefined,
        };
      })
      .filter((d): d is import("./harness/loop/types.ts").DocumentMetadata => d !== null);
  }
  
  return {
    stage: state.stage,
    documentPath: state.documentPath,
    updatedAt: state.updatedAt,
    allDocuments,
    documents,
  };
}

function sanitizeHistory(history: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const h of history) {
    if (!h || typeof h.content !== "string") continue;
    if (h.role !== "user" && h.role !== "assistant" && h.role !== "tool" && h.role !== "system") {
      continue;
    }
    // 去重守卫：连续两条完全相同的 user 消息只保留一条，兜底上游双重写入。
    if (
      h.role === "user" &&
      out.length > 0 &&
      out[out.length - 1]!.role === "user" &&
      out[out.length - 1]!.content === h.content
    ) {
      continue;
    }
    // Match conversation-store durable policy / Cursor transcripts: keep tool
    // call identity for timeline reconstruction, but never persist tool bodies
    // into session.json (they are the main source of multi-100MB sessions).
    const row: ChatTurn = {
      role: h.role,
      content: h.role === "tool" ? "" : h.content,
    };
    if (typeof h.id === "string" && h.id) row.id = h.id;
    if (typeof h.toolName === "string") row.toolName = h.toolName;
    out.push(row);
  }
  return out;
}
