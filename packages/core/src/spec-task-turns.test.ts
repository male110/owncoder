import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import { beginTurn, closeConversationStore, loadRecentTurns, projectConversationTurns } from "./conversation-store.ts";
import { runAgentLoop } from "./harness/loop.ts";
import { readActiveMeta } from "./plans.ts";
import { createSessionRuntime } from "./session-runtime.ts";
import { prepareSpecTaskExecution, getSpecTaskDocument } from "./session-specs.ts";
import { assertSpecTaskReady, readApprovedSpecTask } from "./spec-task-document.ts";
import { saveTasks, writeFeatureState } from "./specs.ts";
import { executeAgentTurn, type AgentTurnContext } from "./turn-execution.ts";

vi.mock("./harness/loop.ts", () => ({ runAgentLoop: vi.fn() }));

const sid = "task-session";
const feature = "test-feature";
const tasks = ["无", "task_1", "task_2"].map((dependency, index) => [
  `- [ ] Task ${index + 1}`,
  `  - 依赖: ${dependency}`,
  "  - 文件: src/app.ts",
  "  - 实现: Make the selected change",
  "  - 验收: Verify the selected change",
  "  - 需求: R1",
].join("\n")).join("\n\n");

let root: string;
let runtime: ReturnType<typeof createSessionRuntime>;
let path: string;
let host: Parameters<typeof prepareSpecTaskExecution>[0];
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), "owncoder-spec-turns-"));
  runtime = createSessionRuntime(sid, "spec");
  host = { rt: (id) => id && id !== sid ? createSessionRuntime(id, "spec") : runtime, sessionWorkspaceRoot: () => root, focusSessionId: () => sid,
    setFocusMode: vi.fn(), persist: vi.fn(), getState: vi.fn() };
  path = await saveTasks(root, feature, `# Tasks\n\n${tasks}`, sid);
  await writeFeatureState(root, feature, "awaiting_tasks_approval", sid);
});
afterEach(async () => {
  closeConversationStore(root, sid);
  await rm(root, { recursive: true, force: true });
});

async function run(taskId: string, turnId: string, status: "completed" | "partial" | "failed" | "cancelled" = "completed") {
  const abortController = new AbortController();
  const doc = (await getSpecTaskDocument(host, path, sid))!;
  const taskRef = { path, version: doc.version, approvedAt: doc.approvedAt!, taskId };
  const checked = await readApprovedSpecTask(root, sid, runtime.activePlanPath, taskRef);
  assertSpecTaskReady(checked.meta, checked.task);
  const user = { role: "user" as const, content: `Run ${taskId}`, turnId };
  await beginTurn(root, sid, user, turnId);
  runtime.history.push(user);
  const onEvent = vi.fn<NonNullable<AgentTurnContext["onEvent"]>>();
  const report = `${taskId}: ${status}`;
  const link = `[tasks.md](${path})`;
  vi.mocked(runAgentLoop).mockImplementationOnce(async (opts) => {
    expect(opts.singleSpecTask).toBe(true);
    expect(opts.activeTasks?.map((task) => task.id)).toEqual([taskId]);
    expect(opts.currentTaskId).toBe(taskId);
    expect(opts.taskRunState).toBeNull();
    await opts.onTaskUpdate?.([{ ...opts.activeTasks![0]!, status: "in_progress" }], taskId);
    expect((await readActiveMeta(root, sid))?.tasks.find((task) => task.id === taskId)?.status).toBe("in_progress");
    expect((await readFile(join(root, path), "utf8")).split("\n")[checked.task.sourceLine! - 1]).toMatch(/^- \[\/\] /);
    if (status === "cancelled") abortController.abort();
    const assistantText = status === "completed" && taskId === "task_2" ? `${report}\n\n${link}` : report;
    return { history: [...opts.history, { role: "assistant", content: assistantText }], assistantText,
      specTaskOutcome: { status, result: assistantText } };
  });
  const result = await executeAgentTurn({ sessionId: sid, text: user.content, turnId, runtime, workspaceRoot: root,
    workflow: BUILTIN_WORKFLOW, checkpointEnabled: false, attachments: [], taskRef,
    abortController, onEvent, enqueueActivePlanUpdate: <T>(work: () => Promise<T>) => work(),
  } as unknown as AgentTurnContext);
  const expected = status === "completed" ? `${report}\n\n${link}` : report;
  expect(result.assistantText).toBe(expected);
  expect(runtime.history.at(-1)?.content).toBe(expected);
  expect(onEvent.mock.calls.at(-1)?.[0]).toMatchObject({
    type: "turn_complete", parts: [{ type: "text", text: expected }],
  });
  return result;
}

describe("Spec task turn persistence", () => {
  it("previews source positions before starting and persists each dependency-ready task as its own turn", async () => {
    const pending = (await getSpecTaskDocument(host, path, sid))!;
    expect(pending.approvedAt).toBeNull();
    expect(pending.tasks.map((task) => task.sourceLine)).toEqual([3, 10, 17]);
    expect(await getSpecTaskDocument(host, path, "other-session")).toBeNull();
    await prepareSpecTaskExecution(host, path, pending.version, sid);
    expect(vi.mocked(runAgentLoop)).not.toHaveBeenCalled();
    await expect(run("task_2", "too-soon")).rejects.toThrow(/前置任务/);
    const started = (await getSpecTaskDocument(host, path, sid))!;
    for (let i = 1; i <= 3; i++) {
      if (i > 1) {
        await prepareSpecTaskExecution(host, path, pending.version, sid);
        expect((await getSpecTaskDocument(host, path, sid))?.approvedAt).toBe(started.approvedAt);
      }
      const result = await run(`task_${i}`, `turn-${i}`);
      expect(result.specTaskOutcome?.status).toBe("completed");
      expect((await readActiveMeta(root, sid))?.tasks.map((task) => task.status)).toEqual(
        [1, 2, 3].map((number) => number <= i ? "completed" : "pending"),
      );
      // 完成状态必须落在 tasks.md 本身，否则源码视图和 list_specs 进度永远是未完成。
      const markdown = await readFile(join(root, path), "utf8");
      expect(markdown.split("\n").filter((line) => line.includes("[x]"))).toHaveLength(i);
      // 进度回写不得改变批次指纹，否则下一项任务的 taskRef 立即失效。
      expect((await getSpecTaskDocument(host, path, sid))?.version).toBe(pending.version);
    }
    const { turns } = await loadRecentTurns(root, sid);
    expect(turns.map(({ turnId, status }) => [turnId, status])).toEqual([
      ["turn-1", "completed"], ["turn-2", "completed"], ["turn-3", "completed"],
    ]);
    expect(projectConversationTurns(turns).filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(
      [1, 2, 3].map((i) => `task_${i}: completed\n\n[tasks.md](${path})`),
    );
  });

  it("retains failed and pending tasks and invalidates a changed document version", async () => {
    const doc = (await getSpecTaskDocument(host, path, sid))!;
    await prepareSpecTaskExecution(host, path, doc.version, sid);
    expect((await run("task_1", "failed-turn", "failed")).specTaskOutcome?.status).toBe("failed");
    expect((await readActiveMeta(root, sid))?.tasks.map((task) => task.status)).toEqual(["failed", "pending", "pending"]);
    expect(await readFile(join(root, path), "utf8")).toContain("- [-] Task 1");
    await expect(run("task_2", "blocked-turn")).rejects.toThrow(/前置任务/);
    expect((await loadRecentTurns(root, sid)).turns.map((turn) => turn.turnId)).toEqual(["failed-turn"]);
    await appendFile(join(root, path), "\nNew revision.\n");
    expect((await getSpecTaskDocument(host, path, sid))?.approvedAt).toBeNull();
    await expect(prepareSpecTaskExecution(host, path, doc.version, sid)).rejects.toThrow(/已修改/);
  });

  it("restores the pending marker when an in-progress task is cancelled", async () => {
    const doc = (await getSpecTaskDocument(host, path, sid))!;
    await prepareSpecTaskExecution(host, path, doc.version, sid);
    await expect(run("task_1", "cancelled-turn", "cancelled")).rejects.toMatchObject({ name: "AbortError" });
    const markdown = await readFile(join(root, path), "utf8");
    expect(markdown).toContain("- [ ] Task 1");
    expect(markdown).not.toContain("[/]");
    expect((await getSpecTaskDocument(host, path, sid))?.tasks[0]?.status).toBe("pending");
  });

  it("keeps a partially completed task visible in tasks.md and lets it run again", async () => {
    const doc = (await getSpecTaskDocument(host, path, sid))!;
    await prepareSpecTaskExecution(host, path, doc.version, sid);
    expect((await run("task_1", "partial-turn", "partial")).specTaskOutcome?.status).toBe("partial");
    expect((await readActiveMeta(root, sid))?.tasks.map((task) => task.status)).toEqual(["partial", "pending", "pending"]);
    expect((await readFile(join(root, path), "utf8")).split("\n").filter((line) => line.includes("[/]"))).toHaveLength(1);
    // 部分完成不是终结态：同一任务可再次执行并转为完成。
    await prepareSpecTaskExecution(host, path, doc.version, sid);
    expect((await run("task_1", "retry-turn", "completed")).specTaskOutcome?.status).toBe("completed");
    expect((await readActiveMeta(root, sid))?.tasks.map((task) => task.status)).toEqual(["completed", "pending", "pending"]);
    const markdown = await readFile(join(root, path), "utf8");
    expect(markdown).not.toContain("[/]");
    expect(markdown.split("\n").filter((line) => line.includes("[x]"))).toHaveLength(1);
  });
});
