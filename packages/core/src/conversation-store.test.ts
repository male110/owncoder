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
  sanitizeOversizedEventPayloads,
  sanitizeOversizedFinalJson,
  slimDurableEvent,
  slimTurnFinal,
} from "./conversation-store.ts";
import Database from "better-sqlite3";

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
    await appendTurnEvent(
      r,
      "s",
      turn.turnId,
      {
        type: "task_decomposition",
        intent: "意图",
        tasks: [{ id: "task_1", description: "任务", steps: [{ id: "s1", description: "one", dependsOn: [], informationNeeds: [], stopReadingWhen: [] }] }],
      },
      { eventType: "task_decomposition" },
    );
    await appendTurnEvent(r, "s", turn.turnId, { summary: "done" }, { eventType: "report" });
    await completeTurn(r, "s", turn.turnId);
    const result = await loadRecentTurns(r, "s", 10);
    expect(result.turns[0]).toMatchObject({
      user: user("input"),
      taskDecomposition: {
        intent: "意图",
        tasks: [{ id: "task_1", description: "任务", steps: [{ id: "s1", description: "one", dependsOn: [], informationNeeds: [], stopReadingWhen: [] }] }],
      },
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
    expect(page.turns[0]!.events.map((e) => e.payload)).toEqual([
      { role: "tool", content: "", outputOmitted: true },
    ]);
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

  it("projectConversationTurns rebuilds tool rows from tool_start/tool_end events", () => {
    const turns = [
      {
        turnId: "live-tools",
        turnSeq: 1,
        status: "failed" as const,
        startedAt: "t0",
        completedAt: "t2",
        user: user("run tools"),
        taskDecomposition: null,
        report: null,
        events: [
          {
            seq: 1,
            eventType: "tool_start",
            payload: { type: "tool_start", id: "c1", name: "bash", args: { command: "ls" } },
            at: "t0",
          },
          {
            seq: 2,
            eventType: "tool_end",
            payload: { type: "tool_end", id: "c1", name: "bash", ok: true, output: "ok" },
            at: "t1",
          },
          {
            seq: 3,
            eventType: "tool_start",
            payload: { type: "tool_start", id: "c2", name: "web_fetch", args: { url: "https://x" } },
            at: "t1",
          },
          {
            seq: 4,
            eventType: "tool_end",
            payload: { type: "tool_end", id: "c2", name: "web_fetch", ok: true, output: "html" },
            at: "t2",
          },
          {
            seq: 5,
            eventType: "tool_start",
            payload: { type: "tool_start", id: "c3", name: "ask_user", args: {} },
            at: "t2",
          },
          {
            seq: 6,
            eventType: "tool_end",
            payload: { type: "tool_end", id: "c3", name: "ask_user", ok: true, output: "answered" },
            at: "t2",
          },
        ],
        final: { error: "LLM failed", aborted: false },
      },
    ];
    expect(projectConversationTurns(turns)).toEqual([
      user("run tools"),
      { role: "tool", id: "c1", toolName: "bash", content: "ok" },
      { role: "tool", id: "c2", toolName: "web_fetch", content: "html" },
      { role: "tool", id: "c3", toolName: "ask_user", content: "answered" },
    ]);
  });

  it("projectConversationTurns falls back to final.history tools when events lack tool rows", () => {
    const turns = [
      {
        turnId: "legacy-final",
        turnSeq: 1,
        status: "completed" as const,
        startedAt: "t0",
        completedAt: "t1",
        user: user("hello"),
        taskDecomposition: null,
        report: null,
        events: [],
        final: {
          history: [
            user("hello"),
            { role: "tool" as const, id: "t1", toolName: "bash", content: "ok" },
            { role: "tool" as const, id: "t2", toolName: "ask_user", content: "q" },
            assistant("done"),
          ],
        },
      },
    ];
    expect(projectConversationTurns(turns)).toEqual([
      user("hello"),
      { role: "tool", id: "t1", toolName: "bash", content: "ok" },
      { role: "tool", id: "t2", toolName: "ask_user", content: "q" },
      assistant("done"),
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

  it("slimTurnFinal stores assistant text instead of full AgentLoopResult.history", async () => {
    const r = await root();
    const turn = await beginTurn(r, "s", user("hello"));
    await appendTurnEvent(
      r,
      "s",
      turn.turnId,
      { type: "tool_start", id: "t1", name: "bash" },
      { eventType: "tool_start" },
    );
    await appendTurnEvent(
      r,
      "s",
      turn.turnId,
      { type: "tool_end", id: "t1", name: "bash", output: "ok", ok: true },
      { eventType: "tool_end" },
    );
    const huge = "x".repeat(50_000);
    await completeTurn(r, "s", turn.turnId, {
      history: [
        user("hello"),
        { role: "tool", id: "t1", toolName: "bash", content: huge },
        assistant("done"),
      ],
      assistantText: "done",
      successRejected: false,
    });

    const stored = slimTurnFinal({
      history: [user("hello"), assistant("done"), { role: "tool", id: "t1", toolName: "bash", content: huge }],
      assistantText: "done",
    });
    expect(stored).toMatchObject({ role: "assistant", content: "done" });
    expect(JSON.stringify(stored)).not.toContain(huge);

    const page = await loadRecentTurns(r, "s", 10);
    expect(projectConversationTurns(page.turns)).toEqual([
      user("hello"),
      { role: "tool", id: "t1", toolName: "bash", content: "" },
      assistant("done"),
    ]);
  });

  it("skips and sanitizes oversized legacy final_json without crashing pagination", async () => {
    const r = await root();
    const turn = await beginTurn(r, "s", user("hello"));
    await completeTurn(r, "s", turn.turnId, assistant("tiny"));
    closeConversationStore(r, "s");

    const db = new Database(conversationStorePath(r, "s"));
    const monster = JSON.stringify({
      history: [{ role: "assistant", content: "Z".repeat(2_000_000) }],
      assistantText: "legacy huge",
    });
    db.prepare("UPDATE turns SET final_json = ? WHERE turn_id = ?").run(monster, turn.turnId);
    db.close();

    const page = await loadRecentTurns(r, "s", 10);
    expect(page.turns[0]?.final).toMatchObject({ omitted: true, reason: "final_json_too_large" });
    expect(sanitizeOversizedFinalJson(r, "s")).toBe(1);
    const after = await loadRecentTurns(r, "s", 10);
    expect(after.turns[0]?.final).toMatchObject({ omitted: true, reason: "final_json_too_large" });
  });

  it("slimDurableEvent drops tool/terminal result bodies while keeping ids", () => {
    const huge = "H".repeat(80_000);
    const toolEnd = slimDurableEvent({
      type: "tool_end",
      id: "c1",
      name: "bash",
      ok: true,
      output: huge,
    }) as { type: string; id: string; name: string; ok: boolean; output?: string; outputOmitted?: boolean };
    expect(toolEnd).toMatchObject({
      type: "tool_end",
      id: "c1",
      name: "bash",
      ok: true,
      outputOmitted: true,
    });
    expect(toolEnd.output).toBeUndefined();
    expect(JSON.stringify(toolEnd)).not.toContain(huge);

    const toolStart = slimDurableEvent({
      type: "tool_start",
      id: "w1",
      name: "write_file",
      args: { path: "a.ts", content: "C".repeat(20_000) },
    }) as { args: { path: string; content: string } };
    expect(toolStart.args.path).toBe("a.ts");
    expect(toolStart.args.content.length).toBeLessThan(20_000);

    const terminal = slimDurableEvent({
      type: "terminal",
      entry: {
        id: "t1",
        command: "npm test",
        status: "ok",
        stdout: `${"old\n".repeat(1000)}${"NEW_TAIL"}`,
        stderr: "E".repeat(80_000),
      },
    }) as { entry: { id: string; command: string; status: string; stdout?: string; stderr?: string } };
    expect(terminal.entry).toMatchObject({ id: "t1", command: "npm test", status: "ok" });
    expect(terminal.entry.stdout).toBeUndefined();
    expect(terminal.entry.stderr).toBeUndefined();
  });

  it("appendTurnEvent does not persist tool_end output bodies", async () => {
    const r = await root();
    const turn = await beginTurn(r, "s", user("run"));
    const huge = "Y".repeat(100_000);
    await appendTurnEvent(
      r,
      "s",
      turn.turnId,
      { type: "tool_end", id: "c9", name: "bash", ok: true, output: huge },
      { eventType: "tool_end" },
    );
    await completeTurn(r, "s", turn.turnId, assistant("done"));

    const loaded = await loadTurn(r, "s", turn.turnId);
    const payload = loaded?.events[0]?.payload as { output?: string; outputOmitted?: boolean; id?: string };
    expect(payload).toMatchObject({ id: "c9", outputOmitted: true });
    expect(payload?.output).toBeUndefined();
    expect(JSON.stringify(loaded)).not.toContain(huge);

    expect(projectConversationTurns([loaded!])).toEqual([
      user("run"),
      { role: "tool", id: "c9", toolName: "bash", content: "" },
      assistant("done"),
    ]);
  });

  it("sanitizes oversized legacy event payloads without crashing pagination", async () => {
    const r = await root();
    const turn = await beginTurn(r, "s", user("hello"));
    await appendTurnEvent(r, "s", turn.turnId, { type: "tool_end", id: "x", name: "bash", ok: true, output: "ok" }, { eventType: "tool_end" });
    await completeTurn(r, "s", turn.turnId, assistant("tiny"));
    closeConversationStore(r, "s");

    const db = new Database(conversationStorePath(r, "s"));
    const monster = JSON.stringify({
      type: "tool_end",
      id: "x",
      name: "bash",
      ok: true,
      output: "Z".repeat(400_000),
    });
    db.prepare("UPDATE events SET payload_json = ? WHERE turn_id = ?").run(monster, turn.turnId);
    db.close();

    const page = await loadRecentTurns(r, "s", 10);
    expect(page.turns[0]?.events[0]?.payload).toMatchObject({
      omitted: true,
      reason: "event_payload_too_large",
    });
    expect(sanitizeOversizedEventPayloads(r, "s")).toBe(1);
  });
});
