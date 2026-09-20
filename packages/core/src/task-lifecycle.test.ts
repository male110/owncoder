import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTaskRunState,
  fileEvidenceHash,
  loadTaskState,
  persistSharedEvidence,
  persistTaskCheckpoint,
  persistTaskState,
  prepareTaskState,
  isReusableEvidence,
  restoreTaskRunState,
} from "./index.ts";
import { listCheckpoints, loadCheckpoint, persistCheckpoint, restoreCheckpointFiles } from "./harness/checkpoint.ts";
import { createSessionFile, loadSessionById, saveSessionById } from "./session-store.ts";
import { makeFileEvidence, type Checkpoint, type TaskState } from "./turn-rounds.ts";

const roots: string[] = [];
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "task-lifecycle-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const checkpoint = (id: string, status: Checkpoint["status"]): Checkpoint => ({
  id,
  status,
  stepId: "step-1",
  createdAt: new Date().toISOString(),
});

function state(overrides: Partial<TaskState> = {}): TaskState {
  return {
    taskId: "task-1",
    relation: "new",
    goal: "原任务目标",
    scope: ["src/a.ts"],
    completedSteps: ["step-1"],
    pendingSteps: ["step-2"],
    fileEvidence: [],
    findings: [{ id: "finding-1", summary: "已发现问题", evidenceIds: [], createdAt: new Date().toISOString() }],
    checkpoints: [checkpoint("cp-started", "started")],
    ...overrides,
  };
}

describe("task lifecycle", () => {
  it("继续任务恢复目标、步骤、发现、证据和 checkpoint", async () => {
    const root = await workspace();
    const evidence = makeFileEvidence("src/a.ts", "const value = 1;", "v1");
    const original = state({ fileEvidence: [evidence] });
    await persistTaskState(root, original);

    const resumed = await prepareTaskState(root, "task-1", "continue", "被忽略的新目标", [], [], []);

    expect(resumed).toMatchObject(original);
    expect(await loadTaskState(root, "task-1")).toMatchObject({
      goal: "原任务目标",
      completedSteps: ["step-1"],
      pendingSteps: ["step-2"],
      fileEvidence: [evidence],
      findings: original.findings,
      checkpoints: original.checkpoints,
    });
  });

  it("新任务隔离执行状态，只复用有效共享证据", async () => {
    const root = await workspace();
    const valid = makeFileEvidence("src/shared.ts", "export const ok = true;", "v1");
    const changed = makeFileEvidence("src/changed.ts", "old", "v1");
    const incomplete = makeFileEvidence("src/incomplete.ts", "partial", "v1", false);
    await persistSharedEvidence(root, [valid, changed, incomplete]);

    const currentChanged = makeFileEvidence("src/changed.ts", "new", "v1");
    const next = await prepareTaskState(root, "task-2", "new", "新任务目标", ["src/new.ts"], ["step-new"], [valid, currentChanged, incomplete]);

    expect(next).toMatchObject({
      taskId: "task-2",
      goal: "新任务目标",
      scope: ["src/new.ts"],
      completedSteps: [],
      pendingSteps: ["step-new"],
      findings: [],
      checkpoints: [],
    });
    expect(next.fileEvidence.map((item) => item.path)).toEqual(["src/shared.ts", "src/changed.ts"]);
    expect(next.fileEvidence[0]).toEqual(valid);
    expect(isReusableEvidence(valid, "v1", fileEvidenceHash(valid.content))).toBe(true);
    expect(isReusableEvidence(changed, "v1", fileEvidenceHash(currentChanged.content))).toBe(false);
    expect(isReusableEvidence(incomplete, "v1")).toBe(false);
  });

  it("持久化 interrupted checkpoint，并能作为继续任务的恢复依据", async () => {
    const root = await workspace();
    const interrupted = checkpoint("cp-interrupted", "interrupted");
    const inProgress = state({ checkpoints: [] });
    const persisted = await persistTaskCheckpoint(root, inProgress, interrupted);
    expect(persisted.checkpoints).toContainEqual(interrupted);
    expect((await loadTaskState(root, "task-1"))?.checkpoints).toContainEqual(interrupted);

    await persistCheckpoint(root, {
      id: "disk-interrupted",
      createdAt: interrupted.createdAt,
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

    const resumed = await prepareTaskState(root, "task-1", "continue", "新目标", [], [], []);
    expect(resumed.checkpoints).toContainEqual(interrupted);
  });

  it("TaskRunState 随 task-state 持久化，continue 可恢复", async () => {
    const root = await workspace();
    const runState = createTaskRunState("task-1", 5);
    runState.phase = "repairing";
    runState.repairAttempts = 2;
    const original = state({ runState });
    await persistTaskState(root, original);

    const loaded = await loadTaskState(root, "task-1");
    expect(loaded?.runState).toMatchObject({
      taskId: "task-1",
      phase: "repairing",
      repairAttempts: 2,
      maxRepairAttempts: 5,
    });

    const resumed = await prepareTaskState(root, "task-1", "continue", "ignored", [], [], []);
    expect(resumed.runState).toMatchObject({
      taskId: "task-1",
      phase: "repairing",
      repairAttempts: 2,
    });
  });

  it("旧 task-state 无 runState 时仍可读取", async () => {
    const root = await workspace();
    await persistTaskState(root, state());
    const loaded = await loadTaskState(root, "task-1");
    expect(loaded?.runState).toBeUndefined();
    expect(loaded?.goal).toBe("原任务目标");
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
    const listed = await listCheckpoints(root);
    const a = listed.filter((cp) => cp.sessionId === "session-a").map((cp) => cp.id).sort();
    const b = listed.filter((cp) => cp.sessionId === "session-b").map((cp) => cp.id).sort();
    expect(a).toEqual(Array.from({ length: 12 }, (_, i) => `a-${String(i + 1).padStart(2, "0")}`));
    expect(b).toEqual(["b-00", "b-01", "b-02"]);
    expect(await loadCheckpoint(root, "a-00")).toBeNull();
    expect((await loadCheckpoint(root, "a-12"))?.sessionId).toBe("session-a");
  });
});
