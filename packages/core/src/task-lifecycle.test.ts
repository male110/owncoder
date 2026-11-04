import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskRunState, restoreTaskRunState } from "./index.ts";
import { listCheckpoints, loadCheckpoint, persistCheckpoint, restoreCheckpointFiles } from "./harness/checkpoint.ts";
import { createSessionFile, loadSessionById, saveSessionById } from "./session-store.ts";

const roots: string[] = [];
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "task-lifecycle-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("task lifecycle", () => {
  it("checkpoint 持久化到磁盘，并能恢复被删除的文件", async () => {
    const root = await workspace();
    await persistCheckpoint(root, {
      id: "disk-interrupted",
      createdAt: new Date().toISOString(),
      historyLen: 2,
      history: [],
      files: [{ path: "src/recovered.ts", existed: false }],
      touched: ["src/recovered.ts"],
      sessionId: "session-1",
    });
    const disk = await loadCheckpoint(root, "disk-interrupted");
    expect(disk?.sessionId).toBe("session-1");
    expect(disk?.touched).toEqual(["src/recovered.ts"]);
    await restoreCheckpointFiles(root, disk!);
    expect(await loadCheckpoint(root, "disk-interrupted")).toMatchObject({ id: "disk-interrupted" });
  });

  it("TaskRunState 随 session 持久化并可恢复，旧会话缺字段兼容", async () => {
    const root = await workspace();
    const { meta } = await createSessionFile(root, { title: "run-state", mode: "agent" });
    const runState = createTaskRunState(meta.id, 4);
    runState.phase = "verifying";
    runState.repairAttempts = 1;

    await saveSessionById(root, meta.id, {
      mode: "agent",
      history: [{ role: "user", content: "hi" }],
      terminalLog: [],
      lastPlanPath: null,
      todoAnchor: null,
      lastCheckpointId: null,
      documentWorkflow: null,
      queuedMessages: [],
      taskRunState: runState,
    });

    const loaded = await loadSessionById(root, meta.id);
    expect(loaded?.taskRunState).toMatchObject({
      taskId: meta.id,
      phase: "verifying",
      repairAttempts: 1,
      maxRepairAttempts: 4,
    });
    expect(restoreTaskRunState(loaded?.taskRunState, meta.id)?.phase).toBe("verifying");

    // 旧会话：无 taskRunState 字段
    const { meta: legacyMeta } = await createSessionFile(root, { title: "legacy", mode: "agent" });
    await saveSessionById(root, legacyMeta.id, {
      mode: "agent",
      history: [],
      terminalLog: [],
      lastPlanPath: null,
      todoAnchor: null,
      lastCheckpointId: null,
      documentWorkflow: null,
      queuedMessages: [],
    });
    const legacy = await loadSessionById(root, legacyMeta.id);
    expect(legacy?.taskRunState ?? null).toBeNull();
  });

  it("按会话保留最近 12 个 checkpoint，且不整文件解析历史", async () => {
    const root = await workspace();
    const write = (id: string, sessionId: string) =>
      persistCheckpoint(root, {
        id,
        createdAt: new Date().toISOString(),
        historyLen: 1,
        history: [{ role: "user", content: "x".repeat(2000) }],
        files: [{ path: "src/a.ts", existed: true, content: "y".repeat(2000) }],
        touched: ["src/a.ts"],
        sessionId,
      });
    for (let i = 0; i < 13; i++) {
      await write(`a-${String(i).padStart(2, "0")}`, "session-a");
    }
    for (let i = 0; i < 3; i++) {
      await write(`b-${String(i).padStart(2, "0")}`, "session-b");
    }
    const listedA = await listCheckpoints(root, "session-a");
    const listedB = await listCheckpoints(root, "session-b");
    const a = listedA.map((cp) => cp.id).sort();
    const b = listedB.map((cp) => cp.id).sort();
    expect(a).toEqual(Array.from({ length: 12 }, (_, i) => `a-${String(i + 1).padStart(2, "0")}`));
    expect(b).toEqual(["b-00", "b-01", "b-02"]);
    expect(await loadCheckpoint(root, "a-00")).toBeNull();
    expect((await loadCheckpoint(root, "a-12"))?.sessionId).toBe("session-a");
  });
});
