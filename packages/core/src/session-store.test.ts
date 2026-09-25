import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionFile,
  deleteSessionFile,
  deleteSessionSidecars,
  listSessionMetas,
  loadSessionById,
  saveSessionById,
} from "./session-store.ts";
import { conversationStorePath } from "./conversation-store.ts";

const roots: string[] = [];
async function root() {
  const r = await mkdtemp(join(tmpdir(), "session-store-"));
  roots.push(r);
  return r;
}
afterEach(async () => {
  for (const r of roots.splice(0)) {
    await rm(r, { recursive: true, force: true });
  }
});

describe("session store history sanitization", () => {
  it("strips tool result bodies on save and load while keeping ids", async () => {
    const r = await root();
    const { meta } = await createSessionFile(r, { title: "t" });
    const huge = "TOOL_BODY_" + "x".repeat(50_000);

    await saveSessionById(r, meta.id, {
      title: "t",
      mode: "agent",
      history: [
        { role: "user", content: "run ls" },
        { role: "tool", id: "c1", toolName: "bash", content: huge },
        { role: "assistant", content: "done" },
      ],
      terminalLog: [],
      lastPlanPath: null,
      todoAnchor: null,
      lastCheckpointId: null,
      documentWorkflow: null,
    });

    const loaded = await loadSessionById(r, meta.id);
    expect(loaded?.history).toEqual([
      { role: "user", content: "run ls" },
      { role: "tool", id: "c1", toolName: "bash", content: "" },
      { role: "assistant", content: "done" },
    ]);
    expect(JSON.stringify(loaded)).not.toContain("TOOL_BODY_");
  });

  it("round-trips queued message attachments and history attachments", async () => {
    const r = await root();
    const { meta } = await createSessionFile(r, { title: "attachments" });
    const attachments = [
      { name: "a.png", mimeType: "image/png", url: "https://cdn.example/a.png", size: 12 },
      { name: "notes.pdf", mimeType: "application/pdf", url: "https://cdn.example/notes.pdf" },
    ];

    await saveSessionById(r, meta.id, {
      title: "attachments",
      mode: "agent",
      history: [{ role: "user", content: "see files", attachments }],
      terminalLog: [],
      lastPlanPath: null,
      todoAnchor: null,
      lastCheckpointId: null,
      documentWorkflow: null,
      queuedMessages: [{ text: "queued", attachments }],
    });

    const loaded = await loadSessionById(r, meta.id);
    expect(loaded?.history[0]).toEqual({
      role: "user",
      content: "see files",
      attachments,
    });
    expect(loaded?.queuedMessages).toEqual([{ text: "queued", attachments }]);
  });

  it("deleteSessionFile drops the session json and index entry", async () => {
    const r = await root();
    const { meta } = await createSessionFile(r, { title: "keep" });
    const extra = await createSessionFile(r, { title: "drop" });
    const next = await deleteSessionFile(r, extra.meta.id);
    expect(next).toBe(meta.id);
    const listed = await listSessionMetas(r);
    expect(listed.sessions.map((s) => s.id)).toEqual([meta.id]);
    await expect(access(join(r, ".owncoder", "sessions", `${extra.meta.id}.json`))).rejects.toThrow();
  });

  it("deleteSessionSidecars removes rounds and conversation sqlite files", async () => {
    const r = await root();
    const { meta } = await createSessionFile(r, { title: "sidecars" });
    const dir = join(r, ".owncoder", "sessions");
    await mkdir(dir, { recursive: true });
    const rounds = join(dir, `${meta.id}.rounds.json`);
    const sqlite = conversationStorePath(r, meta.id);
    await writeFile(rounds, "{}\n", "utf8");
    await writeFile(sqlite, "", "utf8");
    await writeFile(`${sqlite}-wal`, "", "utf8");
    await writeFile(`${sqlite}-shm`, "", "utf8");

    await deleteSessionSidecars(r, meta.id);

    await expect(access(rounds)).rejects.toThrow();
    await expect(access(sqlite)).rejects.toThrow();
    await expect(access(`${sqlite}-wal`)).rejects.toThrow();
    await expect(access(`${sqlite}-shm`)).rejects.toThrow();
    await expect(access(join(dir, `${meta.id}.json`))).resolves.toBeUndefined();
  });
});
