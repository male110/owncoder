import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionOrchestrator } from "./index.ts";

describe("cleanupAllSessions skips running / unfinished sessions", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempRoot(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  it("drops idle runtimes but keeps in-flight and queued sessions", async () => {
    const orch = new SessionOrchestrator();
    const root = await tempRoot("owncoder-cleanup-");
    await orch.openWorkspace(root, "proj");
    const idleId = orch.getState().activeSessionId;
    expect(idleId).toBeTruthy();

    const running = orch.createChatSession("running");
    const queued = orch.createChatSession("queued");
    const runningMeta = await running;
    const queuedMeta = await queued;

    const runtimes = (orch as unknown as { runtimes: Map<string, { abort: AbortController | null; queuedMessages: string[] }> }).runtimes;
    const runningRt = runtimes.get(runningMeta.id);
    const queuedRt = runtimes.get(queuedMeta.id);
    expect(runningRt).toBeTruthy();
    expect(queuedRt).toBeTruthy();
    runningRt!.abort = new AbortController();
    queuedRt!.queuedMessages = ["next"];

    await orch.cleanupAllSessions();

    expect(runtimes.has(idleId!)).toBe(false);
    expect(runtimes.has(runningMeta.id)).toBe(true);
    expect(runtimes.has(queuedMeta.id)).toBe(true);
    expect(runningRt!.abort).not.toBeNull();
    expect(queuedRt!.queuedMessages).toEqual(["next"]);
  });

  it("switchWorkspace does not abort a running session from the previous project", async () => {
    const orch = new SessionOrchestrator();
    const projectA = await tempRoot("owncoder-proj-a-");
    const projectB = await tempRoot("owncoder-proj-b-");
    await orch.openWorkspace(projectA, "A");
    const a1 = orch.getState().activeSessionId;
    expect(a1).toBeTruthy();

    const runtimes = (orch as unknown as {
      runtimes: Map<string, { abort: AbortController | null; queuedMessages: string[]; history: unknown[] }>;
      coordinator: { isActive: (id: string) => boolean };
    }).runtimes;
    const a1Rt = runtimes.get(a1!);
    expect(a1Rt).toBeTruthy();
    a1Rt!.abort = new AbortController();
    a1Rt!.history = [{ role: "user", content: "keep me" }];

    await orch.switchWorkspace(projectB, "B");
    expect(runtimes.has(a1!)).toBe(true);
    expect(a1Rt!.abort?.signal.aborted).toBe(false);
    expect(a1Rt!.history).toEqual([{ role: "user", content: "keep me" }]);

    await orch.switchWorkspace(projectA, "A");
    expect(orch.getState().activeSessionId).toBe(a1);
    expect(runtimes.get(a1!)?.history).toEqual([{ role: "user", content: "keep me" }]);
    expect(runtimes.get(a1!)?.abort?.signal.aborted).toBe(false);
  });

  it("file lookup stays on the send-time project after a later workspace switch", async () => {
    const orch = new SessionOrchestrator();
    const projectA = await tempRoot("owncoder-bind-a-");
    const projectB = await tempRoot("owncoder-bind-b-");
    await orch.openWorkspace(projectA, "A");
    const created = await orch.createChatSession("new-in-a");
    const sid = created.id;

    type Runtime = {
      workspaceRoot: string | null;
      abort: AbortController | null;
    };
    type OrchInternal = {
      runtimes: Map<string, Runtime>;
      sessionWorkspaceRoot: (sessionId?: string | null) => string;
      sessionIndex: (sessionId: string, workspaceRoot: string) => object;
      index: { status: () => { root?: string } };
    };
    const internal = orch as unknown as OrchInternal;
    const rt = internal.runtimes.get(sid);
    expect(rt?.workspaceRoot).toBe(projectA);
    rt!.abort = new AbortController();

    await orch.switchWorkspace(projectB, "B");
    expect(orch.getState().workspace?.root).toBe(projectB);
    expect(internal.sessionWorkspaceRoot(sid)).toBe(projectA);
    const boundIndex = internal.sessionIndex(sid, projectA);
    expect(boundIndex).not.toBe(internal.index);
  });
});
