import { beforeEach, describe, expect, it } from "vitest";
import { useSessionStore } from "./session-store";
import type { ActivePlanMetaDto, PlanInfoDto } from "../../../preload/index";

function task(id: string, description: string, status: "in_progress" | "completed" = "in_progress") {
  return {
    id,
    description,
    status,
    dependsOn: [] as string[],
    retryCount: 0,
    maxRetries: 1,
  };
}

function plan(id: string, title: string): ActivePlanMetaDto {
  return {
    path: `.owncoder/sdd/${id}/spec.md`,
    approvedAt: "2026-01-01T00:00:00.000Z",
    title,
    tasks: [task(`${id}-t1`, `${title}-task`)],
    currentTaskId: `${id}-t1`,
    status: "approved",
  };
}

function pendingPlan(id: string, title: string): PlanInfoDto {
  return {
    path: `.owncoder/sdd/${id}/spec.md`,
    title,
    mtimeMs: 1,
    size: 10,
    kind: "plan",
    sessionId: id,
  };
}

describe("session-store plan isolation", () => {
  beforeEach(() => {
    useSessionStore.setState({
      activeSessionId: null,
      activePlanMeta: null,
      activePlanMetaBySession: {},
      activePlanPath: null,
      activePlanPathBySession: {},
      plans: [],
      plansBySession: {},
    });
  });

  it("does not leak session A's plan into session B on focus switch", () => {
    const store = useSessionStore.getState();
    store.setActiveSessionId("A");
    store.setActivePlanMeta(plan("A", "plan-A"));

    store.setActiveSessionId("B");
    expect(store.getActivePlanMetaForSession("B")).toBeNull();
    expect(useSessionStore.getState().activePlanMeta).toBeNull();
    expect(store.getActivePlanMetaForSession("A")?.title).toBe("plan-A");
  });

  it("writes a background session plan without overwriting the focused session", () => {
    const store = useSessionStore.getState();
    store.setActiveSessionId("A");
    store.setActivePlanMeta(plan("A", "plan-A"));

    store.setActivePlanMetaBySession("B", plan("B", "plan-B"));
    store.patchActivePlanMetaBySession("B", [
      task("B-t1", "plan-B-task", "completed"),
    ], null);

    expect(useSessionStore.getState().activePlanMeta?.title).toBe("plan-A");
    expect(store.getActivePlanMetaForSession("A")?.title).toBe("plan-A");
    expect(store.getActivePlanMetaForSession("B")?.title).toBe("plan-B");
    expect(store.getActivePlanMetaForSession("B")?.currentTaskId).toBeNull();
  });

  it("does not invent a plan for a session that never had one", () => {
    const store = useSessionStore.getState();
    store.setActiveSessionId("A");
    store.setActivePlanMeta(plan("A", "plan-A"));

    store.patchActivePlanMetaBySession("C", [
      task("C-t1", "ghost"),
    ], "C-t1");

    expect(store.getActivePlanMetaForSession("C")).toBeNull();
    expect(useSessionStore.getState().activePlanMeta?.title).toBe("plan-A");
  });

  it("clears only the focused session cache when setActivePlanMeta(null)", () => {
    const store = useSessionStore.getState();
    store.setActiveSessionId("A");
    store.setActivePlanMeta(plan("A", "plan-A"));
    store.setActivePlanMetaBySession("B", plan("B", "plan-B"));

    store.setActivePlanMeta(null);
    expect(store.getActivePlanMetaForSession("A")).toBeNull();
    expect(store.getActivePlanMetaForSession("B")?.title).toBe("plan-B");
  });

  it("does not hide session B's pending plans after A is approved", () => {
    const store = useSessionStore.getState();
    store.setActiveSessionId("A");
    store.setPlans([pendingPlan("A", "plan-A")], "A");
    store.setActivePlanPath(".owncoder/sdd/A/spec.md", "A");

    store.setPlans([pendingPlan("B", "plan-B")], "B");
    store.setActiveSessionId("B");

    expect(useSessionStore.getState().activePlanPath).toBeNull();
    expect(store.getActivePlanPathForSession("B")).toBeNull();
    expect(store.getActivePlanPathForSession("A")).toBe(".owncoder/sdd/A/spec.md");
    expect(useSessionStore.getState().plans.map((p) => p.title)).toEqual(["plan-B"]);
    expect(store.getPlansForSession("B").map((p) => p.title)).toEqual(["plan-B"]);
  });

  it("does not let a background plan-path write overwrite the focused session", () => {
    const store = useSessionStore.getState();
    store.setActiveSessionId("A");
    store.setPlans([pendingPlan("A", "plan-A")], "A");
    store.setActivePlanPath(null, "A");

    store.setActivePlanPath(".owncoder/sdd/B/spec.md", "B");
    store.setPlans([pendingPlan("B", "plan-B")], "B");

    expect(useSessionStore.getState().activePlanPath).toBeNull();
    expect(useSessionStore.getState().plans.map((p) => p.title)).toEqual(["plan-A"]);
    expect(store.getActivePlanPathForSession("B")).toBe(".owncoder/sdd/B/spec.md");
    expect(store.getPlansForSession("B").map((p) => p.title)).toEqual(["plan-B"]);
  });
});
