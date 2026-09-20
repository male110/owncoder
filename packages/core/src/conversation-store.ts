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
  const eventRows = db.prepare(`SELECT event_seq, turn_id, round_seq, event_type, payload_json, created_at FROM events WHERE turn_id IN (${placeholders}) ORDER BY event_seq`).all(...ids) as Array<{ event_seq: number; turn_id: string; round_seq: number | null; event_type: string | null; payload_json: string | null; created_at: string }>;
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
    db.prepare("INSERT INTO turns(turn_id, turn_seq, status, started_at, user_json) VALUES (?, ?, 'running', ?, ?)").run(id, turnSeq, now, json(typeof user === "string" ? { role: "user", content: user } : user));
    return { turnId: id, turnSeq };
  });
}

export async function appendTurnEvent(root: string, sessionId: string, turnId: string, event: unknown, options?: { eventType?: string; roundSeq?: number }): Promise<number> {
  return serial(lockKey(root, sessionId), async () => {
    const db = await dbFor(root, sessionId);
    const result = db.prepare("INSERT INTO events(turn_id, round_seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(turnId, options?.roundSeq ?? null, options?.eventType ?? null, json(event), new Date().toISOString());
    return Number(result.lastInsertRowid);
  });
}

export async function completeTurn(root: string, sessionId: string, turnId: string, result?: unknown, status: ConversationTurnStatus = "completed"): Promise<void> {
  return serial(lockKey(root, sessionId), async () => {
    const db = await dbFor(root, sessionId);
    const now = new Date().toISOString();
    db.prepare("UPDATE turns SET status = ?, completed_at = ?, final_json = ? WHERE turn_id = ?").run(status, now, json(result), turnId);
  });
}

export async function loadRecentTurns(root: string, sessionId: string, limit = 10): Promise<TurnPage> {
  return serial(lockKey(root, sessionId), async () => {
    const db = await dbFor(root, sessionId);
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const rows = db.prepare("SELECT turn_id, turn_seq, status, started_at, completed_at, user_json, final_json FROM turns WHERE status <> 'running' ORDER BY turn_seq DESC LIMIT ?").all(safeLimit) as Array<{ turn_id: string; turn_seq: number; status: ConversationTurnStatus; started_at: string; completed_at: string | null; user_json: string | null; final_json: string | null }>;
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
    const rows = db.prepare("SELECT turn_id, turn_seq, status, started_at, completed_at, user_json, final_json FROM turns WHERE status <> 'running' AND turn_seq < ? ORDER BY turn_seq DESC LIMIT ?").all(beforeSeq, safeLimit) as Array<{ turn_id: string; turn_seq: number; status: ConversationTurnStatus; started_at: string; completed_at: string | null; user_json: string | null; final_json: string | null }>;
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
    const row = db.prepare("SELECT turn_id, turn_seq, status, started_at, completed_at, user_json, final_json FROM turns WHERE turn_id = ?").get(turnId) as { turn_id: string; turn_seq: number; status: ConversationTurnStatus; started_at: string; completed_at: string | null; user_json: string | null; final_json: string | null } | undefined;
    return row ? loadTurns(db, [row])[0] ?? null : null;
  });
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
        insertTurn.run(turnId, seq, now, now, json(group.find((m) => m.role === "user") ?? group[0]), json(assistant));
        for (const message of group.slice(1)) insertEvent.run(turnId, json(message), now);
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
