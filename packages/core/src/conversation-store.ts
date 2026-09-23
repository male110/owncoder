import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChatTurn } from "./harness/loop/types.ts";

export type ConversationTurnStatus = "running" | "completed" | "cancelled" | "failed";

export interface ConversationRecord {
  seq: number;
  turnId: string;
  type: "turn_begin" | "turn_event" | "turn_complete" | "turn_failed";
  roundSeq?: number;
  eventType?: string;
  payload?: unknown;
  at: string;
}

export interface ConversationTurn {
  turnId: string;
  turnSeq: number;
  status: ConversationTurnStatus;
  startedAt: string;
  completedAt?: string;
  user?: ChatTurn;
  /** 新增字段；旧会话没有对应事件时统一返回 null。 */
  taskDecomposition: unknown | null;
  /** 新增字段；旧会话没有对应事件时统一返回 null。 */
  report: unknown | null;
  events: Array<{ seq: number; roundSeq?: number; eventType?: string; payload?: unknown; at: string }>;
  final?: unknown;
}

export interface TurnPage {
  turns: ConversationTurn[];
  beforeSeq: number | null;
  hasMore: boolean;
}

const STORE_DIR = ".owncoder/sessions";
const connections = new Map<string, Database.Database>();
const locks = new Map<string, Promise<unknown>>();

/** Keep final_json bounded. Older builds stored the entire AgentLoopResult.history
 * (full-session transcript + tool payloads) and single turns grew past 300MB. */
const MAX_FINAL_JSON_CHARS = 1_500_000;
const MAX_ASSISTANT_CONTENT_CHARS = 200_000;
/** Durable event payloads must stay pageable. Like Cursor transcripts, we
 * persist tool call metadata but not tool result bodies; other string fields
 * stay bounded. */
const MAX_EVENT_PAYLOAD_CHARS = 250_000;
const MAX_TOOL_ARG_STRING_CHARS = 4_000;
const MAX_GENERIC_STRING_CHARS = 64_000;
const MAX_REASONING_CHARS = 16_000;

function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

function slimChatTurn(turn: unknown): ChatTurn | null {
  if (!turn || typeof turn !== "object") return null;
  const row = turn as Partial<ChatTurn> & { content?: unknown; role?: unknown };
  if (
    row.role !== "user" &&
    row.role !== "assistant" &&
    row.role !== "tool" &&
    row.role !== "system"
  ) {
    return null;
  }
  if (typeof row.content !== "string") return null;
  const slim: ChatTurn = {
    role: row.role,
    // Tool result bodies are not durable; keep only a marker row if needed.
    content: row.role === "tool" ? "" : truncateText(row.content, MAX_ASSISTANT_CONTENT_CHARS),
  };
  if (typeof row.id === "string") slim.id = row.id;
  if (typeof row.toolName === "string") slim.toolName = row.toolName;
  return slim;
}

/**
 * Persist only UI-relevant turn completion data.
 * Never store the full in-memory session history — events already capture the
 * tool timeline, and session JSON keeps the bounded runtime transcript.
 */
export function slimTurnFinal(result: unknown): unknown {
  if (result == null) return result;
  if (typeof result !== "object") return result;

  const row = result as Record<string, unknown>;
  if ("error" in row || "aborted" in row) {
    return {
      error: typeof row.error === "string" ? row.error : String(row.error ?? ""),
      aborted: row.aborted === true,
    };
  }

  if (row.role === "assistant" && typeof row.content === "string") {
    return slimChatTurn(row);
  }

  // AgentLoopResult used to persist the entire session `history` here and
  // ballooned past 300MB/turn. Keep only the final assistant text (+ tiny
  // metadata). Tool timelines already live in the events table.
  let assistantText =
    typeof row.assistantText === "string" ? row.assistantText : "";
  if (!assistantText && Array.isArray(row.history)) {
    for (let i = row.history.length - 1; i >= 0; i--) {
      const item = slimChatTurn(row.history[i]);
      if (item?.role === "assistant" && item.content.trim()) {
        assistantText = item.content;
        break;
      }
    }
  }

  const slim: Record<string, unknown> = {
    role: "assistant",
    content: truncateText(assistantText, MAX_ASSISTANT_CONTENT_CHARS),
  };
  if (row.lastPlanPath !== undefined) slim.lastPlanPath = row.lastPlanPath;
  if (row.documentWorkflow !== undefined) slim.documentWorkflow = row.documentWorkflow;
  if (row.presentChanges !== undefined) slim.presentChanges = row.presentChanges;
  if (row.taskRunState !== undefined) slim.taskRunState = row.taskRunState;
  if (row.successRejected !== undefined) slim.successRejected = row.successRejected;
  return slim;
}

function finalJsonSelectExpr(): string {
  // Skip oversized legacy blobs so history pagination cannot OOM the main process.
  return `CASE WHEN final_json IS NOT NULL AND LENGTH(final_json) > ${MAX_FINAL_JSON_CHARS} THEN '{"omitted":true,"reason":"final_json_too_large"}' ELSE final_json END AS final_json`;
}

/** One-shot repair for databases written before final_json was bounded. */
export function sanitizeOversizedFinalJson(root: string, sessionId: string): number {
  const path = conversationStorePath(root, sessionId);
  const existing = connections.get(path);
  const db = existing ?? new Database(path);
  try {
    const stub = json({ omitted: true, reason: "final_json_too_large" });
    const result = db
      .prepare(
        `UPDATE turns SET final_json = ? WHERE final_json IS NOT NULL AND LENGTH(final_json) > ?`,
      )
      .run(stub, MAX_FINAL_JSON_CHARS);
    return Number(result.changes ?? 0);
  } finally {
    if (!existing) db.close();
  }
}

function slimToolArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[key] = truncateText(value, MAX_TOOL_ARG_STRING_CHARS);
    } else if (typeof value === "number" || typeof value === "boolean" || value == null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      // Keep short scalar arrays (line ranges, ids); drop nested blobs.
      out[key] = value.slice(0, 50).map((item) =>
        typeof item === "string" ? truncateText(item, MAX_TOOL_ARG_STRING_CHARS) : item,
      );
    } else {
      // Nested objects (rarely needed for history UI) stay as a tiny marker.
      out[key] = { omitted: true, reason: "nested_arg_omitted" };
    }
  }
  return out;
}

function slimStringFields(value: unknown, max: number, depth = 0): unknown {
  if (typeof value === "string") return truncateText(value, max);
  if (!value || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => slimStringFields(item, max, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = slimStringFields(child, max, depth + 1);
  }
  return out;
}

/**
 * Bound a single durable turn-event payload before it hits SQLite.
 * Peer pattern (Cursor transcripts): persist tool call metadata, not tool
 * result bodies. Keeps ids/names/ok for UI reconstruction; drops outputs /
 * terminal streams that can balloon the conversation DB.
 */
export function slimDurableEvent(event: unknown): unknown {
  if (event == null || typeof event !== "object") return event;
  const row = event as Record<string, unknown>;
  const type = typeof row.type === "string" ? row.type : undefined;
  const slim: Record<string, unknown> = { ...row };

  if (type === "tool_end") {
    // Do not persist tool result bodies — only status + identity.
    delete slim.output;
    slim.outputOmitted = true;
    if (slim.metadata != null) {
      slim.metadata = slimStringFields(slim.metadata, MAX_TOOL_ARG_STRING_CHARS);
    }
  } else if (type === "tool_start") {
    if (slim.args != null) slim.args = slimToolArgs(slim.args);
  } else if (type === "terminal" && slim.entry && typeof slim.entry === "object") {
    const entry = { ...(slim.entry as Record<string, unknown>) };
    // Terminal streams are tool results for bash-like tools; drop on disk.
    delete entry.stdout;
    delete entry.stderr;
    if (typeof entry.command === "string") entry.command = truncateText(entry.command, MAX_TOOL_ARG_STRING_CHARS);
    slim.entry = entry;
  } else if (type === "reasoning_step" || type === "trace_report" || type === "verification_result") {
    if (typeof slim.content === "string") slim.content = truncateText(slim.content, MAX_REASONING_CHARS);
    if (typeof slim.summary === "string") slim.summary = truncateText(slim.summary, MAX_REASONING_CHARS);
  } else if (type === "error" || type === "warning" || type === "context_warning") {
    if (typeof slim.message === "string") slim.message = truncateText(slim.message, MAX_REASONING_CHARS);
  } else if (type === "task_decomposition") {
    slim.intent =
      typeof slim.intent === "string"
        ? truncateText(slim.intent, MAX_GENERIC_STRING_CHARS)
        : slim.intent;
    slim.tasks = slimStringFields(slim.tasks, MAX_TOOL_ARG_STRING_CHARS);
    slim.userConstraints = slimStringFields(slim.userConstraints, MAX_TOOL_ARG_STRING_CHARS);
  } else if (typeof slim.content === "string") {
    // Legacy `{ role, content }` rows: drop tool bodies, bound assistant text.
    if (slim.role === "tool") {
      slim.content = "";
      slim.outputOmitted = true;
    } else {
      slim.content = truncateText(slim.content, MAX_ASSISTANT_CONTENT_CHARS);
    }
  } else {
    // Catch-all for report / recovery / decision payloads with long strings.
    return slimStringFields(slim, MAX_GENERIC_STRING_CHARS);
  }

  const encoded = json(slim);
  if (encoded.length <= MAX_EVENT_PAYLOAD_CHARS) return slim;
  return {
    type: type ?? "unknown",
    omitted: true,
    reason: "event_payload_too_large",
    id: typeof slim.id === "string" ? slim.id : undefined,
    name: typeof slim.name === "string" ? slim.name : undefined,
    ok: typeof slim.ok === "boolean" ? slim.ok : undefined,
    originalChars: encoded.length,
  };
}

function eventPayloadSelectExpr(): string {
  return `CASE WHEN payload_json IS NOT NULL AND LENGTH(payload_json) > ${MAX_EVENT_PAYLOAD_CHARS} THEN '{"omitted":true,"reason":"event_payload_too_large"}' ELSE payload_json END AS payload_json`;
}

/** One-shot repair for oversized event rows written before durable slimming. */
export function sanitizeOversizedEventPayloads(root: string, sessionId: string): number {
  const path = conversationStorePath(root, sessionId);
  const existing = connections.get(path);
  const db = existing ?? new Database(path);
  try {
    const stub = json({ omitted: true, reason: "event_payload_too_large" });
    const result = db
      .prepare(
        `UPDATE events SET payload_json = ? WHERE payload_json IS NOT NULL AND LENGTH(payload_json) > ?`,
      )
      .run(stub, MAX_EVENT_PAYLOAD_CHARS);
    return Number(result.changes ?? 0);
  } finally {
    if (!existing) db.close();
  }
}

export function conversationStorePath(workspaceRoot: string, sessionId: string): string {
  if (!sessionId || /[\\/]/.test(sessionId) || sessionId.includes("..")) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  return join(resolve(workspaceRoot, STORE_DIR), `${sessionId}.conversation.sqlite`);
}

function lockKey(root: string, sid: string): string {
  return conversationStorePath(root, sid);
}

function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

async function dbFor(root: string, sid: string): Promise<Database.Database> {
  const path = conversationStorePath(root, sid);
  const existing = connections.get(path);
  if (existing) return existing;
  await mkdir(resolve(root, STORE_DIR), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      turn_id TEXT PRIMARY KEY,
      turn_seq INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      user_json TEXT,
      final_json TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
      round_seq INTEGER,
      event_type TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turns_seq ON turns(turn_seq DESC);
    CREATE INDEX IF NOT EXISTS idx_events_turn ON events(turn_id, event_seq);
  `);
  connections.set(path, db);
  return db;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}
function parse(value: string | null | undefined): unknown {
  if (value == null) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}
function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadTurns(db: Database.Database, rows: Array<{ turn_id: string; turn_seq: number; status: ConversationTurnStatus; started_at: string; completed_at: string | null; user_json: string | null; final_json: string | null }>): ConversationTurn[] {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.turn_id);
  const placeholders = ids.map(() => "?").join(",");
  const eventRows = db.prepare(
    `SELECT event_seq, turn_id, round_seq, event_type, ${eventPayloadSelectExpr()}, created_at FROM events WHERE turn_id IN (${placeholders}) ORDER BY event_seq`,
  ).all(...ids) as Array<{ event_seq: number; turn_id: string; round_seq: number | null; event_type: string | null; payload_json: string | null; created_at: string }>;
  const events = new Map<string, ConversationTurn["events"]>();
  for (const row of eventRows) {
    const list = events.get(row.turn_id) ?? [];
    list.push({ seq: row.event_seq, roundSeq: row.round_seq ?? undefined, eventType: row.event_type ?? undefined, payload: parse(row.payload_json), at: row.created_at });
    events.set(row.turn_id, list);
  }
  return rows.map((row) => {
    const turnEvents = events.get(row.turn_id) ?? [];
    const taskDecomposition = turnEvents.find((event) =>
      event.eventType === "task_decomposition" || event.eventType === "taskDecomposition",
    )?.payload ?? null;
    const report = turnEvents.find((event) =>
      event.eventType === "report" || event.eventType === "task_report" || event.eventType === "final_result",
    )?.payload ?? null;
    return {
      turnId: row.turn_id,
      turnSeq: row.turn_seq,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      user: parse(row.user_json) as ChatTurn | undefined,
      taskDecomposition,
      report,
      events: turnEvents,
      final: parse(row.final_json),
    };
  });
}

export async function beginTurn(root: string, sessionId: string, user: ChatTurn | string, turnId?: string): Promise<{ turnId: string; turnSeq: number }> {
  return serial(lockKey(root, sessionId), async () => {
    const db = await dbFor(root, sessionId);
    const id = turnId ?? makeId();
    const now = new Date().toISOString();
    const turnSeq = (db.prepare("SELECT COALESCE(MAX(turn_seq), 0) + 1 AS next FROM turns").get() as { next: number }).next;
    const userPayload =
      typeof user === "string"
        ? { role: "user" as const, content: truncateText(user, MAX_ASSISTANT_CONTENT_CHARS) }
        : slimChatTurn(user) ?? { role: "user" as const, content: truncateText(String((user as { content?: unknown }).content ?? ""), MAX_ASSISTANT_CONTENT_CHARS) };
    db.prepare("INSERT INTO turns(turn_id, turn_seq, status, started_at, user_json) VALUES (?, ?, 'running', ?, ?)").run(id, turnSeq, now, json(userPayload));
    return { turnId: id, turnSeq };
  });
}

export async function appendTurnEvent(root: string, sessionId: string, turnId: string, event: unknown, options?: { eventType?: string; roundSeq?: number }): Promise<number> {
  return serial(lockKey(root, sessionId), async () => {
    const db = await dbFor(root, sessionId);
    const result = db.prepare("INSERT INTO events(turn_id, round_seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
      turnId,
      options?.roundSeq ?? null,
      options?.eventType ?? null,
      json(slimDurableEvent(event)),
      new Date().toISOString(),
    );
    return Number(result.lastInsertRowid);
  });
}

export async function completeTurn(root: string, sessionId: string, turnId: string, result?: unknown, status: ConversationTurnStatus = "completed"): Promise<void> {
  return serial(lockKey(root, sessionId), async () => {
    const db = await dbFor(root, sessionId);
    const now = new Date().toISOString();
    db.prepare("UPDATE turns SET status = ?, completed_at = ?, final_json = ? WHERE turn_id = ?").run(
      status,
      now,
      json(slimTurnFinal(result)),
      turnId,
    );
  });
}

export async function loadRecentTurns(root: string, sessionId: string, limit = 10): Promise<TurnPage> {
  return serial(lockKey(root, sessionId), async () => {
    const db = await dbFor(root, sessionId);
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const rows = db.prepare(
      `SELECT turn_id, turn_seq, status, started_at, completed_at, user_json, ${finalJsonSelectExpr()} FROM turns WHERE status <> 'running' ORDER BY turn_seq DESC LIMIT ?`,
    ).all(safeLimit) as Array<{ turn_id: string; turn_seq: number; status: ConversationTurnStatus; started_at: string; completed_at: string | null; user_json: string | null; final_json: string | null }>;
    rows.reverse();
    const turns = loadTurns(db, rows);
    const beforeSeq = turns[0]?.turnSeq ?? null;
    const hasMore = beforeSeq != null && Boolean(db.prepare("SELECT 1 FROM turns WHERE status <> 'running' AND turn_seq < ? LIMIT 1").get(beforeSeq));
    return { turns, beforeSeq, hasMore };
  });
}

export async function loadOlderTurns(root: string, sessionId: string, beforeSeq: number, limit = 10): Promise<TurnPage> {
  return serial(lockKey(root, sessionId), async () => {
    const db = await dbFor(root, sessionId);
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const rows = db.prepare(
      `SELECT turn_id, turn_seq, status, started_at, completed_at, user_json, ${finalJsonSelectExpr()} FROM turns WHERE status <> 'running' AND turn_seq < ? ORDER BY turn_seq DESC LIMIT ?`,
    ).all(beforeSeq, safeLimit) as Array<{ turn_id: string; turn_seq: number; status: ConversationTurnStatus; started_at: string; completed_at: string | null; user_json: string | null; final_json: string | null }>;
    rows.reverse();
    const turns = loadTurns(db, rows);
    const nextBeforeSeq = turns[0]?.turnSeq ?? null;
    const hasMore = nextBeforeSeq != null && Boolean(db.prepare("SELECT 1 FROM turns WHERE status <> 'running' AND turn_seq < ? LIMIT 1").get(nextBeforeSeq));
    return { turns, beforeSeq: nextBeforeSeq, hasMore };
  });
}

export async function loadTurn(root: string, sessionId: string, turnId: string): Promise<ConversationTurn | null> {
  return serial(lockKey(root, sessionId), async () => {
    const db = await dbFor(root, sessionId);
    const row = db.prepare(
      `SELECT turn_id, turn_seq, status, started_at, completed_at, user_json, ${finalJsonSelectExpr()} FROM turns WHERE turn_id = ?`,
    ).get(turnId) as { turn_id: string; turn_seq: number; status: ConversationTurnStatus; started_at: string; completed_at: string | null; user_json: string | null; final_json: string | null } | undefined;
    return row ? loadTurns(db, [row])[0] ?? null : null;
  });
}

/**
 * Flatten durable conversation turns into UI ChatTurn rows.
 * Dedupes user/assistant copies *within one turn* that can appear both as
 * turn.user and as legacy_message / final.history payloads. Does not collapse
 * identical messages across different turns (user may send "hello" twice).
 *
 * Live tool calls are persisted as TurnEvent payloads (`tool_start` /
 * `tool_end`), not as `{ role: "tool" }` rows. Reconstruct those into ChatTurn
 * tool rows so session switch / history-page restore still shows the full
 * execution process (not only the final assistant text).
 */
export function projectConversationTurns(turns: ConversationTurn[]): ChatTurn[] {
  const projected: ChatTurn[] = [];
  for (const turn of turns) {
    const local: ChatTurn[] = [];
    const pushUnique = (item: ChatTurn) => {
      if (item.role === "user" || item.role === "assistant") {
        const dup = local.some(
          (h) =>
            h.role === item.role &&
            h.content === item.content &&
            (h.id && item.id ? h.id === item.id : true),
        );
        if (dup) return;
      }
      if (item.role === "tool" && item.id) {
        const dup = local.some((h) => h.role === "tool" && h.id === item.id);
        if (dup) return;
      }
      local.push(item);
    };
    if (
      turn.user &&
      typeof turn.user.content === "string" &&
      (turn.user.role === "user" ||
        turn.user.role === "assistant" ||
        turn.user.role === "tool" ||
        turn.user.role === "system")
    ) {
      pushUnique({ ...turn.user });
    }

    const pendingTools = new Map<string, { name: string }>();
    for (const event of turn.events) {
      const payload = event.payload as
        | (Partial<ChatTurn> & {
            type?: string;
            id?: string;
            name?: string;
            output?: string;
            ok?: boolean;
          })
        | undefined;
      if (!payload || typeof payload !== "object") continue;

      if (payload.type === "tool_start" && typeof payload.id === "string") {
        pendingTools.set(payload.id, {
          name: typeof payload.name === "string" ? payload.name : "unknown",
        });
        continue;
      }
      if (payload.type === "tool_end" && typeof payload.id === "string") {
        const start = pendingTools.get(payload.id);
        const toolName =
          (typeof payload.name === "string" && payload.name) ||
          start?.name ||
          "unknown";
        // New writes omit tool bodies (`outputOmitted`). Legacy rows may still
        // carry `output`; keep that for older sessions.
        const omitted = (payload as { outputOmitted?: unknown }).outputOmitted === true;
        const output = omitted
          ? ""
          : typeof payload.output === "string"
            ? payload.output
            : payload.ok === false
              ? "Error: tool failed"
              : "";
        pushUnique({
          role: "tool",
          id: payload.id,
          toolName,
          content: output,
        });
        pendingTools.delete(payload.id);
        continue;
      }

      if (
        (payload.role === "user" ||
          payload.role === "assistant" ||
          payload.role === "tool" ||
          payload.role === "system") &&
        typeof payload.content === "string"
      ) {
        pushUnique({ ...payload } as ChatTurn);
      }
    }

    const final = turn.final as
      | (Partial<ChatTurn> & {
          history?: ChatTurn[];
          lastAssistant?: string;
          assistantText?: string;
          omitted?: boolean;
        })
      | undefined;
    // New writes store a slim assistant ChatTurn (or a tiny metadata stub).
    // Older builds stored AgentLoopResult.history; keep that fallback for
    // already-sanitized-but-still-small legacy rows. Tool timelines primarily
    // come from events.
    if (final && typeof final === "object" && "history" in final && Array.isArray(final.history)) {
      for (const row of final.history) {
        if (!row || typeof row !== "object" || typeof row.content !== "string") continue;
        if (row.role === "tool" || row.role === "assistant" || row.role === "system") {
          pushUnique({ ...row });
        }
      }
    } else if (
      final &&
      typeof final === "object" &&
      typeof final.assistantText === "string" &&
      final.assistantText.trim()
    ) {
      pushUnique({ role: "assistant", content: final.assistantText });
    } else {
      const candidate =
        final && typeof final === "object" && "role" in final
          ? (final as ChatTurn)
          : undefined;
      if (candidate?.role === "assistant" && typeof candidate.content === "string") {
        // Only project ChatTurn fields — slimTurnFinal may attach metadata
        // (taskRunState / successRejected) on the same object.
        pushUnique({
          role: "assistant",
          content: candidate.content,
          ...(typeof candidate.id === "string" ? { id: candidate.id } : {}),
        });
      }
    }
    projected.push(...local);
  }
  return projected;
}

export async function migrateLegacyHistory(root: string, sessionId: string, history: ChatTurn[]): Promise<void> {
  if (history.length === 0) return;
  return serial(lockKey(root, sessionId), async () => {
    const db = await dbFor(root, sessionId);
    const existing = db.prepare("SELECT 1 FROM turns LIMIT 1").get();
    if (existing) return;
    const groups: ChatTurn[][] = [];
    let current: ChatTurn[] = [];
    for (const message of history) {
      if (message.role === "user" && current.length > 0) { groups.push(current); current = []; }
      current.push(message);
    }
    if (current.length > 0) groups.push(current);
    const insertTurn = db.prepare("INSERT INTO turns(turn_id, turn_seq, status, started_at, completed_at, user_json, final_json) VALUES (?, ?, 'completed', ?, ?, ?, ?)");
    const insertEvent = db.prepare("INSERT INTO events(turn_id, event_type, payload_json, created_at) VALUES (?, 'legacy_message', ?, ?)");
    const tx = db.transaction(() => {
      let seq = 0;
      for (const group of groups) {
        const turnId = `legacy-${++seq}-${makeId()}`;
        const now = new Date().toISOString();
        const assistant = [...group].reverse().find((m: ChatTurn) => m.role === "assistant") ?? null;
        insertTurn.run(
          turnId,
          seq,
          now,
          now,
          json(slimChatTurn(group.find((m) => m.role === "user") ?? group[0]) ?? group[0]),
          json(slimTurnFinal(assistant)),
        );
        for (const message of group.slice(1)) insertEvent.run(turnId, json(slimDurableEvent(message)), now);
      }
    });
    tx();
  });
}

export function closeConversationStore(root: string, sessionId: string): void {
  const path = conversationStorePath(root, sessionId);
  connections.get(path)?.close();
  connections.delete(path);
}
