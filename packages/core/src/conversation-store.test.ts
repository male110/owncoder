import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTurnEvent,
  beginTurn,
  closeConversationStore,
  completeTurn,
  conversationStorePath,
  loadOlderTurns,
  loadRecentTurns,
  loadTurn,
  migrateLegacyHistory,
  projectConversationTurns,
} from "./conversation-store.ts";

const roots: string[] = [];
async function root() {
  const r = await mkdtemp(join(tmpdir(), "conversation-store-"));
  roots.push(r);
  return r;
}
afterEach(async () => {
  for (const r of roots.splice(0)) {
    closeConversationStore(r, "s");
    closeConversationStore(r, "a");
    closeConversationStore(r, "b");
    closeConversationStore(r, "legacy");
    await rm(r, { recursive: true, force: true });
  }
});

const user = (content: string) => ({ role: "user" as const, content });
const assistant = (content: string) => ({ role: "assistant" as const, content });

describe("conversation store", () => {
  it("stores multiple rounds under one turn and aggregates them", async () => {
    const r = await root();
    const a = await beginTurn(r, "s", user("one"));
    await appendTurnEvent(r, "s", a.turnId, assistant("answer one"), { eventType: "assistant", roundSeq: 1 });
    await appendTurnEvent(r, "s", a.turnId, { role: "tool", content: "ok" }, { eventType: "tool", roundSeq: 1 });
    await completeTurn(r, "s", a.turnId, assistant("final one"));
    const b = await beginTurn(r, "s", user("two"));
    await appendTurnEvent(r, "s", b.turnId, assistant("answer two"), { eventType: "assistant", roundSeq: 1 });
    await completeTurn(r, "s", b.turnId, assistant("final two"));

    const page = await loadRecentTurns(r, "s", 10);
    expect(page.turns).toHaveLength(2);
    expect(page.turns[0]).toMatchObject({ turnId: a.turnId, turnSeq: a.turnSeq, status: "completed" });
    expect(page.turns[0]!.events).toHaveLength(2);
    expect(page.turns[1]).toMatchObject({ turnId: b.turnId, turnSeq: b.turnSeq, status: "completed" });
    expect(await loadTurn(r, "s", a.turnId)).toMatchObject({ turnId: a.turnId, status: "completed" });
    expect(conversationStorePath(r, "s")).toContain("s.conversation.sqlite");
  });

  it("returns new fields from events and preserves legacy turns with null defaults", async () => {
    const r = await root();
    const turn = await beginTurn(r, "s", user("input"));
    await appendTurnEvent(r, "s", turn.turnId, { steps: ["one"] }, { eventType: "task_decomposition" });
    await appendTurnEvent(r, "s", turn.turnId, { summary: "done" }, { eventType: "report" });
    await completeTurn(r, "s", turn.turnId);
    const result = await loadRecentTurns(r, "s", 10);
    expect(result.turns[0]).toMatchObject({
      user: user("input"),
      taskDecomposition: { steps: ["one"] },
      report: { summary: "done" },
    });

    const legacy = await beginTurn(r, "s", user("legacy"));
    await completeTurn(r, "s", legacy.turnId);
    const all = await loadRecentTurns(r, "s", 10);
    expect(all.turns.find((item) => item.turnId === legacy.turnId)).toMatchObject({
      user: user("legacy"),
      taskDecomposition: null,
      report: null,
    });
  });

  it("returns only complete turns for recent N and beforeSeq pagination", async () => {
    const r = await root();
    const ids: Array<{ turnId: string; turnSeq: number }> = [];
    for (const text of ["one", "two", "three"]) {
      const t = await beginTurn(r, "s", user(text));
      ids.push(t);
      await completeTurn(r, "s", t.turnId);
    }
    await beginTurn(r, "s", user("incomplete"));

    const recent = await loadRecentTurns(r, "s", 2);
    expect(recent.turns.map((t) => t.turnId)).toEqual([ids[1]!.turnId, ids[2]!.turnId]);
    expect(recent.hasMore).toBe(true);
    expect(recent.beforeSeq).toBe(ids[1]!.turnSeq);

    const older = await loadOlderTurns(r, "s", recent.beforeSeq!, 2);
    expect(older.turns.map((t) => t.turnId)).toEqual([ids[0]!.turnId]);
    expect(older.hasMore).toBe(false);
  });

  it("migrates legacy history at user message boundaries without repeating", async () => {
    const r = await root();
    await migrateLegacyHistory(r, "legacy", [
      assistant("leading"),
      { role: "tool", content: "tool output" },
      user("next"),
      assistant("reply"),
    ]);
    const page = await loadRecentTurns(r, "legacy", 10);
    expect(page.turns).toHaveLength(2);
    expect(page.turns[0]!.user).toEqual(assistant("leading"));
    expect(page.turns[0]!.events.map((e) => e.payload)).toEqual([{ role: "tool", content: "tool output" }]);
    expect(page.turns[1]!.user).toEqual(user("next"));
    expect(page.turns[1]!.events.map((e) => e.payload)).toEqual([assistant("reply")]);
    await migrateLegacyHistory(r, "legacy", [user("ignored")]);
    expect((await loadRecentTurns(r, "legacy", 10)).turns).toHaveLength(2);
  });

  it("projectConversationTurns drops in-turn duplicate user/assistant copies", () => {
    const turns = [
      {
        turnId: "live-1",
        turnSeq: 1,
        status: "completed" as const,
        startedAt: "t0",
        completedAt: "t1",
        user: user("hello"),
        taskDecomposition: null,
        report: null,
        events: [
          { seq: 1, eventType: "legacy_message", payload: user("hello"), at: "t0" },
          { seq: 2, eventType: "legacy_message", payload: assistant("world"), at: "t1" },
        ],
        final: { history: [user("hello"), assistant("world")] },
      },
    ];
    expect(projectConversationTurns(turns)).toEqual([
      user("hello"),
      assistant("world"),
    ]);
  });

  it("projectConversationTurns keeps identical user text across different turns", () => {
    const turns = [
      {
        turnId: "t1",
        turnSeq: 1,
        status: "completed" as const,
        startedAt: "t0",
        completedAt: "t1",
        user: user("hello"),
        taskDecomposition: null,
        report: null,
        events: [],
        final: assistant("one"),
      },
      {
        turnId: "t2",
        turnSeq: 2,
        status: "completed" as const,
        startedAt: "t2",
        completedAt: "t3",
        user: user("hello"),
        taskDecomposition: null,
        report: null,
        events: [],
        final: assistant("two"),
      },
    ];
    expect(projectConversationTurns(turns)).toEqual([
      user("hello"),
      assistant("one"),
      user("hello"),
      assistant("two"),
    ]);
  });

  it("does not migrate an in-flight user that only exists on disk after beginTurn claimed the store", async () => {
    // Mirrors the fixed sendMessage order: beginTurn first (store non-empty),
    // then persist session JSON that already contains the new user message.
    // A concurrent loadHistoryPage must NOT create a second legacy user turn.
    const r = await root();
    await beginTurn(r, "s", user("hello"), "live-1");
    await migrateLegacyHistory(r, "s", [user("hello")]);
    const page = await loadRecentTurns(r, "s", 10);
    // beginTurn row is still running, so loadRecentTurns excludes it; migrate
    // must have no-op'd because the store already had a row.
    expect(page.turns).toHaveLength(0);
    await completeTurn(r, "s", "live-1", assistant("world"));
    const done = await loadRecentTurns(r, "s", 10);
    expect(projectConversationTurns(done.turns)).toEqual([
      user("hello"),
      assistant("world"),
    ]);
  });

  it("serializes writes per session while allowing concurrent sessions", async () => {
    const r = await root();
    const [a, b] = await Promise.all([beginTurn(r, "a", user("a")), beginTurn(r, "b", user("b"))]);
    await Promise.all([
      appendTurnEvent(r, "a", a.turnId, assistant("a1")),
      appendTurnEvent(r, "a", a.turnId, assistant("a2")),
      appendTurnEvent(r, "b", b.turnId, assistant("b1")),
    ]);
    await Promise.all([completeTurn(r, "a", a.turnId), completeTurn(r, "b", b.turnId)]);
    expect((await loadTurn(r, "a", a.turnId))!.events).toHaveLength(2);
    expect((await loadTurn(r, "b", b.turnId))!.events).toHaveLength(1);
  });
});
