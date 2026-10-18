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
  setActiveSessionId,
  toggleSessionPin,
  renameSession,
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

  it("自定义名称在普通保存后保留，空名称被拒绝", async () => {
    const r = await root();
    const { meta, session } = await createSessionFile(r);
    await renameSession(r, meta.id, "  我的会话  ");
    await saveSessionById(r, meta.id, { ...session, history: [{ role: "user", content: "自动标题" }] });
    expect((await loadSessionById(r, meta.id))?.title).toBe("我的会话");
    expect((await listSessionMetas(r)).sessions[0].title).toBe("我的会话");
    await renameSession(r, meta.id, "新会话");
    await saveSessionById(r, meta.id, { ...session, history: [{ role: "user", content: "自动标题" }] });
    expect((await loadSessionById(r, meta.id))?.title).toBe("新会话");
    await expect(renameSession(r, meta.id, "  ")).rejects.toThrow("会话名称不能为空");
  });

  it("其他会话并发保存时，重命名在重新读取和后续保存后仍保留", async () => {
    const r = await root();
    const first = await createSessionFile(r, { title: "旧名称" });
    const second = await createSessionFile(r);
    await Promise.all([
      saveSessionById(r, second.meta.id, second.session),
      renameSession(r, first.meta.id, "用户输入的名称"),
    ]);
    expect((await listSessionMetas(r)).sessions.find((s) => s.id === first.meta.id)?.title).toBe("用户输入的名称");
    expect((await loadSessionById(r, first.meta.id))?.title).toBe("用户输入的名称");
    await saveSessionById(r, first.meta.id, first.session);
    expect((await loadSessionById(r, first.meta.id))?.title).toBe("用户输入的名称");
    expect((await listSessionMetas(r)).sessions.find((s) => s.id === first.meta.id)?.customTitle).toBe(true);
  });

  it("多个置顶按置顶时间倒序，消息活动不改变置顶顺序", async () => {
    const r = await root();
    const first = await createSessionFile(r);
    const second = await createSessionFile(r);
    const third = await createSessionFile(r);
    await toggleSessionPin(r, second.meta.id);
    await toggleSessionPin(r, first.meta.id);
    await saveSessionById(r, second.meta.id, second.session, "2099-01-01T00:00:00.000Z");
    expect((await listSessionMetas(r)).sessions.map((s) => s.id)).toEqual([first.meta.id, second.meta.id, third.meta.id]);
    await toggleSessionPin(r, first.meta.id);
    expect((await listSessionMetas(r)).sessions[0].id).toBe(second.meta.id);
    await toggleSessionPin(r, first.meta.id);
    expect((await listSessionMetas(r)).sessions[0].id).toBe(first.meta.id);
  });

  it("lists sessions by the latest user-message update time", async () => {
    const r = await root();
    const first = await createSessionFile(r, { title: "first" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await createSessionFile(r, { title: "second" });

    await new Promise((resolve) => setTimeout(resolve, 2));
    await saveSessionById(r, first.meta.id, {
      title: "first",
      mode: "agent",
      history: [{ role: "user", content: "a newer task" }],
      terminalLog: [],
      lastPlanPath: null,
      todoAnchor: null,
      lastCheckpointId: null,
      documentWorkflow: null,
    }, new Date().toISOString());

    const listed = await listSessionMetas(r);
    expect(listed.sessions.map((s) => s.id)).toEqual([first.meta.id, second.meta.id]);
  });

  it("preserves activity time, focus and pin on ordinary saves", async () => {
    const r = await root();
    const first = await createSessionFile(r, { title: "first" });
    const second = await createSessionFile(r, { title: "second" });
    await toggleSessionPin(r, first.meta.id);
    await setActiveSessionId(r, second.meta.id);
    const before = await listSessionMetas(r);
    const snapshot = (await loadSessionById(r, first.meta.id))!;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveSessionById(r, first.meta.id, snapshot);
    await saveSessionById(r, first.meta.id, {
      ...snapshot,
      history: [...snapshot.history, { role: "assistant", content: "background reply" }],
    });

    expect(await listSessionMetas(r)).toEqual(before);
    expect((await loadSessionById(r, first.meta.id))?.updatedAt).toBe(first.meta.updatedAt);
  });

  it("freezes a non-default title across ordinary saves", async () => {
    const r = await root();
    const { meta } = await createSessionFile(r, { title: "XXX" });

    // Ordinary persist (no explicit title) after the user sends "我帅吗" must
    // keep the user-visible title "XXX" — it must not drift to the message text.
    const saved = await saveSessionById(r, meta.id, {
      mode: "agent",
      history: [
        { role: "user", content: "我帅吗" },
        { role: "assistant", content: "当然" },
      ],
      terminalLog: [],
      lastPlanPath: null,
      todoAnchor: null,
      lastCheckpointId: null,
      documentWorkflow: null,
    });

    expect(saved.title).toBe("XXX");
    expect((await loadSessionById(r, meta.id))?.title).toBe("XXX");
    expect((await listSessionMetas(r)).sessions[0]?.title).toBe("XXX");
  });

  it("derives a title from history only while the title is still a default placeholder", async () => {
    const r = await root();
    const { meta } = await createSessionFile(r, { title: "新会话" });

    const firstSave = await saveSessionById(r, meta.id, {
      mode: "agent",
      history: [{ role: "user", content: "我帅吗" }],
      terminalLog: [],
      lastPlanPath: null,
      todoAnchor: null,
      lastCheckpointId: null,
      documentWorkflow: null,
    });
    expect(firstSave.title).toBe("我帅吗");

    // Once named, later messages (and compaction shifting the first user turn)
    // must not rewrite the fixed title.
    const secondSave = await saveSessionById(r, meta.id, {
      mode: "agent",
      history: [
        { role: "system", content: "[历史摘要，原始内容已压缩]" },
        { role: "user", content: "再帮我做点别的" },
      ],
      terminalLog: [],
      lastPlanPath: null,
      todoAnchor: null,
      lastCheckpointId: null,
      documentWorkflow: null,
    });
    expect(secondSave.title).toBe("我帅吗");
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
