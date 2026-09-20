import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import type { IndexClient } from "@owncoder/index";
import type { ChangeFile } from "../../changes.ts";
import { allEnhancedTools, PARALLEL_SAFE_TOOLS } from "../enhanced-tools.ts";
import { executeTool } from "../execute.ts";
import type { ToolContext } from "./types.ts";
import { toolListSessionChanges, toolUndoSessionChange } from "./session-changes.ts";

function stubIndex(): IndexClient {
  return {
    async open() {},
    async getTags() {
      return [];
    },
    async buildRepoMap() {
      return "";
    },
    invalidate() {},
    async rebuildAll() {},
    status() {
      return { kind: "ready", fileCount: 0, tagCount: 0 };
    },
  } as IndexClient;
}

function baseCtx(root: string, mode: "agent" | "plan" = "agent"): ToolContext {
  return {
    workspaceRoot: root,
    mode,
    workflow: BUILTIN_WORKFLOW,
    index: stubIndex(),
    readSet: new Set(["src/a.ts"]),
    readMtTimes: new Map([["src/a.ts", 1]]),
    touchedPaths: ["src/a.ts", "src/b.ts"],
    maxOutputChars: 24_000,
    bashMaxChars: 10_000,
  };
}

test("tool defs: list always, undo only in agent", () => {
  const plan = allEnhancedTools({ mode: "plan" }).map((t) => t.function.name);
  const agent = allEnhancedTools({ mode: "agent" }).map((t) => t.function.name);
  assert.ok(plan.includes("list_session_changes"));
  assert.ok(!plan.includes("undo_session_change"));
  assert.ok(agent.includes("list_session_changes"));
  assert.ok(agent.includes("undo_session_change"));
  assert.equal(PARALLEL_SAFE_TOOLS.has("list_session_changes"), true);
  assert.equal(PARALLEL_SAFE_TOOLS.has("undo_session_change"), false);
});

test("list_session_changes formats pending files", async () => {
  const root = await mkdtemp(join(tmpdir(), "owncoder-sc-"));
  try {
    const files: ChangeFile[] = [
      { path: "src/a.ts", kind: "modified", before: "old", after: "new", preview: "" },
      { path: "src/b.ts", kind: "added", before: "", after: "x", preview: "" },
    ];
    const ctx = baseCtx(root);
    ctx.sessionChanges = {
      getPendingChanges: async () => ({ checkpointId: "cp1", files }),
      undoChange: async () => {
        throw new Error("should not undo");
      },
    };
    const result = await toolListSessionChanges(ctx);
    assert.equal(result.ok, true);
    assert.match(result.output, /checkpoint: cp1/);
    assert.match(result.output, /src\/a\.ts \(modified\)/);
    assert.match(result.output, /src\/b\.ts \(added\)/);
    assert.match(result.output, /exactly one path per call/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("undo_session_change restores one path and reports remaining", async () => {
  const root = await mkdtemp(join(tmpdir(), "owncoder-sc-"));
  try {
    const pending: ChangeFile[] = [
      { path: "src/a.ts", kind: "modified", before: "old", after: "new", preview: "" },
      { path: "src/b.ts", kind: "added", before: "", after: "x", preview: "" },
    ];
    const undone: string[] = [];
    const ctx = baseCtx(root);
    ctx.sessionChanges = {
      getPendingChanges: async () => ({
        checkpointId: pending.length ? "cp1" : null,
        files: [...pending],
      }),
      undoChange: async (path: string) => {
        undone.push(path);
        const i = pending.findIndex((f) => f.path === path);
        if (i >= 0) pending.splice(i, 1);
      },
    };

    const result = await toolUndoSessionChange(ctx, "src/a.ts");
    assert.equal(result.ok, true);
    assert.deepEqual(undone, ["src/a.ts"]);
    assert.match(result.output, /Undid session change for src\/a\.ts/);
    assert.match(result.output, /src\/b\.ts/);
    assert.equal(ctx.readSet.has("src/a.ts"), false);
    assert.deepEqual(ctx.touchedPaths, ["src/b.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("undo_session_change rejects unknown path and plan mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "owncoder-sc-"));
  try {
    const files: ChangeFile[] = [
      { path: "src/a.ts", kind: "modified", before: "old", after: "new", preview: "" },
    ];
    const agent = baseCtx(root, "agent");
    agent.sessionChanges = {
      getPendingChanges: async () => ({ checkpointId: "cp1", files }),
      undoChange: async () => {},
    };
    const miss = await toolUndoSessionChange(agent, "src/missing.ts");
    assert.equal(miss.ok, false);
    assert.match(miss.output, /Not in pending session changes/);

    const plan = baseCtx(root, "plan");
    plan.sessionChanges = agent.sessionChanges;
    const blocked = await toolUndoSessionChange(plan, "src/a.ts");
    assert.equal(blocked.ok, false);
    assert.match(blocked.output, /Plan mode/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executeTool dispatches list_session_changes and undo_session_change", async () => {
  const root = await mkdtemp(join(tmpdir(), "owncoder-sc-"));
  try {
    const files: ChangeFile[] = [
      { path: "src/a.ts", kind: "modified", before: "old", after: "new", preview: "" },
    ];
    let undone = "";
    const ctx = baseCtx(root);
    ctx.sessionChanges = {
      getPendingChanges: async () => ({
        checkpointId: undone ? null : "cp1",
        files: undone ? [] : files,
      }),
      undoChange: async (path: string) => {
        undone = path;
      },
    };

    const listed = await executeTool(ctx, {
      id: "1",
      name: "list_session_changes",
      arguments: {},
      rawArguments: "{}",
    });
    assert.equal(listed.ok, true);
    assert.match(listed.output, /src\/a\.ts/);

    const undoneResult = await executeTool(ctx, {
      id: "2",
      name: "undo_session_change",
      arguments: { path: "src/a.ts" },
      rawArguments: '{"path":"src/a.ts"}',
    });
    assert.equal(undoneResult.ok, true);
    assert.equal(undone, "src/a.ts");
    assert.match(undoneResult.output, /No pending session changes remain/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
