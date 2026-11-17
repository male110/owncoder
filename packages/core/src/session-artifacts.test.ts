import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import { activeMetaPath, approvePlannerPlan, listPlans, readActiveMeta, readPlanFile, readPlannerPlan, savePlannerPlan, samePlannerPlan, sessionArtifactDir, validatePlannerPlan, writeActiveMeta, writePlanFile } from "./plans.ts";
import { featureDirRel, getSpecStatus, listSpecs, phaseFileName, readFeatureState, readSpecPhase, saveSpec, writeFeatureState } from "./specs.ts";
import { toolSaveDesign } from "./harness/tools/save-design.ts";
import { toolSaveTasks } from "./harness/tools/save-tasks.ts";
import { executeTool } from "./harness/execute.ts";
import { buildSpecWorkflowUpdate } from "./harness/loop/document-workflow.ts";
import { approveSpecPhase } from "./session-specs.ts";
import { approvePlan, readPlan, type PlansHost } from "./session-plans.ts";
import { createSessionRuntime } from "./session-runtime.ts";
import type { ToolContext } from "./harness/tools/types.ts";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "owncoder-artifacts-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const context = (sessionId: string) => ({ workspaceRoot: root, sessionId, mode: "spec", workflow: BUILTIN_WORKFLOW, maxOutputChars: 10000 }) as ToolContext;

describe("会话产物隔离", () => {
  it("同名文件、相同 planId 分属不同目录，列表与打开严格隔离", async () => {
    const a = await savePlannerPlan(root, "a", "agent", "# A");
    const path = await writePlanFile(root, "# B", { filename: `${a.planId}-v1.md`, sessionId: "b" });
    expect(path).not.toBe(a.path);
    expect((await listPlans(root, "a")).map((p) => p.path)).toEqual([a.path]);
    expect((await listPlans(root, "b")).map((p) => p.path)).toEqual([path]);
    expect(await listPlans(root)).toEqual([]);
    expect(await readPlanFile(root, a.path, "a")).toBe("# A\n");
    await expect(readPlanFile(root, a.path, "b")).rejects.toThrow();
    await expect(readPlanFile(root, `${sessionArtifactDir("plans", "b")}/../a.md`, "b")).rejects.toThrow();
    const host = { focusSessionId: () => "b", sessionWorkspaceRoot: () => root } as unknown as PlansHost;
    await expect(readPlan(host, a.path)).rejects.toThrow();
    const b = { ...a, sessionId: "b", path, digest: createHash("sha256").update("# B\n").digest("hex") };
    const bMeta = join(root, ".owncoder/plans/.active", `planner-${createHash("sha256").update("b").digest("hex")}.json`);
    await fs.writeFile(bMeta, JSON.stringify(b));
    expect((await readPlannerPlan(root, "b"))?.planId).toBe(a.planId);
    expect(samePlannerPlan(a, b)).toBe(false);
    expect(await approvePlannerPlan(root, "b", b)).toBe("# B\n");
    await expect(approvePlannerPlan(root, "b", a)).rejects.toThrow();
    await expect(validatePlannerPlan(root, "b", a, true)).rejects.toThrow();
    await approvePlannerPlan(root, "a", a);
    expect(await validatePlannerPlan(root, "a", a, true)).toBe("# A\n");
  });

  it("旧全局活动计划、无归属文件、复制元数据不会被认领", async () => {
    await fs.mkdir(join(root, ".owncoder/plans"), { recursive: true });
    await fs.writeFile(join(root, ".owncoder/plans/old.md"), "旧计划");
    await fs.writeFile(join(root, ".owncoder/plans/.active.json"), JSON.stringify({ path: ".owncoder/plans/old.md", tasks: [] }));
    expect(await readActiveMeta(root, "a")).toBeNull();
    expect(await readActiveMeta(root, "b")).toBeNull();
    expect(await listPlans(root, "a")).toEqual([]);
    await fs.mkdir(join(root, ".owncoder/specs/legacy"), { recursive: true });
    await fs.writeFile(join(root, ".owncoder/specs/legacy/requirement.md"), "旧需求");
    await fs.writeFile(join(root, ".owncoder/specs/legacy/.state.json"), JSON.stringify({ feature: "legacy", stage: "approved" }));
    expect(await listSpecs(root, "a")).toEqual([]);
    expect(await readFeatureState(root, "legacy", "a")).toBeNull();
    const a = await savePlannerPlan(root, "a", "agent", "# A");
    const meta = { sessionId: "a", path: a.path, approvedAt: "now", tasks: [], currentTaskId: null };
    await writeActiveMeta(root, meta, "a");
    await fs.copyFile(activeMetaPath(root, "a"), activeMetaPath(root, "b"));
    expect((await readActiveMeta(root, "a"))?.sessionId).toBe("a");
    expect(await readActiveMeta(root, "b")).toBeNull();
    const plannerFile = (sid: string) => join(root, ".owncoder/plans/.active", `planner-${createHash("sha256").update(sid).digest("hex")}.json`);
    await fs.copyFile(plannerFile("a"), plannerFile("b"));
    await expect(readPlannerPlan(root, "b")).rejects.toThrow();
  });

  it("宿主不能通过外国路径批准计划", async () => {
    const a = await savePlannerPlan(root, "a", "agent", "# A");
    const r = createSessionRuntime("b", "agent");
    const host = { rt: () => r, sessionWorkspaceRoot: () => root } as unknown as PlansHost;
    await expect(approvePlan(host, { path: a.path }, "b")).rejects.toThrow();
    expect(r.activePlanPath).toBeNull();
  });

  it("需求、设计和任务仅在所属会话创建、恢复、展示和审批", async () => {
    const a = context("a"); const b = context("b");
    const specPath = await saveSpec(root, "login", "# A 需求\n\nR1: WHEN 用户提交凭证 THE SYSTEM SHALL 完成登录", "a");
    await writeFeatureState(root, "login", "awaiting_spec_approval", "a");
    expect(await listSpecs(root, "b")).toEqual([]);
    expect((await getSpecStatus(root, "login", "b")).phase).toBe("empty");
    expect(await readFeatureState(root, "login", "b")).toBeNull();
    for (const phase of ["spec", "design", "tasks"] as const) {
      await expect(readSpecPhase(root, "login", phase, "b")).rejects.toThrow();
    }
    expect((await toolSaveDesign(b, "login", "# B 设计")).ok).toBe(false);
    expect((await toolSaveTasks(b, "login", "# B 任务")).ok).toBe(false);
    const r = createSessionRuntime("b", "spec");
    const host = { rt: () => r, sessionWorkspaceRoot: () => root, focusSessionId: () => "b", persist: vi.fn(), getState: vi.fn(), setFocusMode: vi.fn() };
    await expect(approveSpecPhase(host, "login", "b")).rejects.toThrow();
    await writeFeatureState(root, "login", "spec_approved", "a");
    expect((await toolSaveDesign(a, "login", "# A 设计\n\n## 需求追踪矩阵\n\n- R1: 登录流程")).ok).toBe(true);
    await writeFeatureState(root, "login", "design_approved", "a");
    expect((await toolSaveTasks(a, "login", "# A 任务\n\n- [ ] 实施登录\n  - 依赖: 无\n  - 文件: src/login.ts\n  - 实现: 登录流程\n  - 验收: 登录成功\n  - 需求: R1")).ok).toBe(true);
    expect((await listSpecs(root, "a"))[0]?.phases).toEqual(["spec", "design", "tasks"]);
    for (const phase of ["spec", "design", "tasks"] as const) {
      expect(await readSpecPhase(root, "login", phase, "a")).toContain("A");
      await expect(readPlanFile(root, `${featureDirRel("login", "a")}/${phaseFileName(phase)}`, "b")).rejects.toThrow();
    }
    expect(await readPlanFile(root, specPath, "a")).toContain("A 需求");
    await saveSpec(root, "login", "# B 需求\n\nR1: WHEN 用户提交凭证 THE SYSTEM SHALL 完成 B 登录", "b");
    await writeFeatureState(root, "login", "awaiting_spec_approval", "b");
    expect((await listSpecs(root, "b"))[0]?.title).toBe("B 需求");
    expect(await readSpecPhase(root, "login", "spec", "a")).toContain("A 需求");
    await writeFeatureState(root, "login", "spec_approved", "b");
    expect((await toolSaveDesign(b, "login", "# B 设计\n\n## 需求追踪矩阵\n\n- R1: B 登录流程")).ok).toBe(true);
    await writeFeatureState(root, "login", "design_approved", "b");
    expect((await toolSaveTasks(b, "login", "# B 任务\n\n- [ ] 实施 B\n  - 依赖: 无\n  - 文件: src/b.ts\n  - 实现: B 登录流程\n  - 验收: B 登录成功\n  - 需求: R1")).ok).toBe(true);
    await approveSpecPhase(host, "login", "b");
    expect(r.activePlanPath).toBe(`${featureDirRel("login", "b")}/tasks.md`);
    expect((await readFeatureState(root, "login", "a"))?.stage).toBe("awaiting_tasks_approval");
  });

  it("Spec 当前阶段缓存不能继承外国会话的文档历史", () => {
    const aPath = `${featureDirRel("login", "a")}/requirement.md`;
    const bPath = `${featureDirRel("login", "b")}/requirement.md`;
    const a = buildSpecWorkflowUpdate({ feature: "login", path: aPath, phase: "spec" }, null, "a");
    const b = buildSpecWorkflowUpdate({ feature: "login", path: bPath, phase: "spec" }, a, "b");
    expect(b.sessionId).toBe("b");
    expect(b.allDocuments).toEqual([bPath]);
    expect(b.documents?.map((doc) => doc.path)).toEqual([bPath]);
    const resumed = buildSpecWorkflowUpdate({ feature: "login", path: `${featureDirRel("login", "a")}/design.md`, phase: "design" }, a, "a");
    expect(resumed.allDocuments).toContain(aPath);
  });

  it("通用工具读取和嵌套工具不能绕过外国文档路径", async () => {
    const a = await savePlannerPlan(root, "a", "agent", "# A");
    for (const name of ["read_file", "write_file", "read_outline"]) {
      const result = await executeTool(context("b"), { id: name, name, arguments: { file_path: a.path, content: "伪造" }, rawArguments: "{}" });
      expect(result.ok).toBe(false);
    }
    expect(await readPlanFile(root, a.path, "a")).toBe("# A\n");
  });
});
