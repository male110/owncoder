import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionOrchestrator } from "./index.ts";
import { beginTurn } from "./conversation-store.ts";
import { createSessionFile, listSessionMetas, loadSessionById, saveSessionById } from "./session-store.ts";

vi.mock("./conversation-store.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./conversation-store.ts")>(),
  migrateLegacyHistory: vi.fn(),
  beginTurn: vi.fn(),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "session-activity-"));
  roots.push(root);
  const ids: string[] = [];
  for (const title of ["1", "2", "3"]) {
    const { meta, session } = await createSessionFile(root, { title });
    ids.push(meta.id);
    await saveSessionById(root, meta.id, session, `2026-01-0${4 - Number(title)}T00:00:00.000Z`);
  }
  const orch = new SessionOrchestrator();
  const internal = orch as unknown as {
    state: { workspace: { root: string; name: string } | null };
    coordinator: { admit: (...args: unknown[]) => Promise<unknown> };
  };
  internal.state.workspace = { root, name: "test" };
  vi.spyOn(internal.coordinator, "admit").mockResolvedValue({});
  await orch.switchChatSession(ids[1]!);
  return { root, ids, orch };
}

describe("session activity ordering", () => {
  it("keeps 1,2,3 on switching 2 to 1 and saving, then promotes 3 only on a new message", async () => {
    const { root, ids, orch } = await setup();
    const before = (await listSessionMetas(root)).sessions;
    expect(before.map((s) => s.id)).toEqual(ids);

    await orch.switchChatSession(ids[0]!);
    await orch.persist(ids[0]!);
    await orch.drainPersists();
    expect((await listSessionMetas(root)).sessions).toEqual(before);
    expect((await loadSessionById(root, ids[1]!))?.updatedAt).toBe(before[1]!.updatedAt);

    await orch.switchChatSession(ids[2]!);
    await expect(orch.sendMessage("  ", undefined, ids[2]!)).rejects.toThrow("消息不能为空");
    expect((await listSessionMetas(root)).sessions).toEqual(before);

    vi.mocked(beginTurn).mockRejectedValueOnce(new Error("记录消息失败"));
    await expect(orch.sendMessage("not recorded", undefined, ids[2]!)).rejects.toThrow("记录消息失败");
    expect((await listSessionMetas(root)).sessions).toEqual(before);

    await orch.sendMessage("new task", undefined, ids[2]!);
    const after = (await listSessionMetas(root)).sessions;
    expect(after.map((s) => s.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(after[0]!.updatedAt > before[0]!.updatedAt).toBe(true);
    expect((await loadSessionById(root, ids[2]!))?.updatedAt).toBe(after[0]!.updatedAt);
    await orch.persist(ids[2]!);
    await orch.switchChatSession(ids[0]!);
    expect((await listSessionMetas(root)).sessions).toEqual(after);
  });

  it("updates on queue admission but not queue removal, restore or regeneration", async () => {
    const { root, ids, orch } = await setup();
    orch.setQueuedMessages([{ text: "queued task" }], ids[1]!);
    await orch.drainPersists();
    const queued = (await listSessionMetas(root)).sessions;
    expect(queued[0]!.id).toBe(ids[1]);
    orch.setQueuedMessages([{ text: "queued task" }], ids[1]!);
    orch.setQueuedMessages([], ids[1]!);
    await orch.drainPersists();
    expect((await listSessionMetas(root)).sessions).toEqual(queued);

    await orch.sendMessage("original task", undefined, ids[1]!);
    const sent = (await listSessionMetas(root)).sessions;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await orch.regenerateLastReply(undefined, ids[1]!);
    expect((await listSessionMetas(root)).sessions).toEqual(sent);
  });
});
