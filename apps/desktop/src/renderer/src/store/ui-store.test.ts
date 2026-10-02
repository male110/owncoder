import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value);
  },
  removeItem: (key: string) => {
    memory.delete(key);
  },
  clear: () => {
    memory.clear();
  },
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() {
    return memory.size;
  },
} satisfies Storage;

vi.stubGlobal("localStorage", storage);

const {
  DRAFTS_STORAGE_KEY,
  PENDING_DRAFT_KEY,
  getComposerDraftKey,
  loadDrafts,
  resolveComposerDraftText,
  useUiStore,
} = await import("./ui-store");

describe("composer draft persistence", () => {
  beforeEach(() => {
    memory.clear();
    useUiStore.setState({ drafts: {} });
  });

  afterEach(() => {
    memory.clear();
    useUiStore.setState({ drafts: {} });
  });

  it("keeps unsent input after close/reopen", () => {
    useUiStore.getState().setDraft("还没发出去", "sess-1");
    expect(JSON.parse(memory.get(DRAFTS_STORAGE_KEY) ?? "{}")).toEqual({ "sess-1": "还没发出去" });
    expect(loadDrafts()).toEqual({ "sess-1": "还没发出去" });
  });

  it("does not notify subscribers when reopening the active editor tab", () => {
    useUiStore.setState({ editorTabs: ["src/app.ts"], editorPath: "src/app.ts" });
    const listener = vi.fn();
    const unsubscribe = useUiStore.subscribe(listener);

    useUiStore.getState().setEditorPath("src/app.ts");

    expect(listener).not.toHaveBeenCalled();
    expect(useUiStore.getState()).toMatchObject({
      editorTabs: ["src/app.ts"],
      editorPath: "src/app.ts",
    });
    unsubscribe();
  });

  it("activates an existing inactive editor tab without adding a duplicate", () => {
    useUiStore.setState({ editorTabs: ["src/a.ts", "src/b.ts"], editorPath: "src/a.ts" });

    useUiStore.getState().setEditorPath("src/b.ts");

    expect(useUiStore.getState()).toMatchObject({
      editorTabs: ["src/a.ts", "src/b.ts"],
      editorPath: "src/b.ts",
    });
  });

  it("keeps pending composer text when there is no active session", () => {
    useUiStore.getState().setDraft("新会话草稿", PENDING_DRAFT_KEY);
    expect(loadDrafts()[PENDING_DRAFT_KEY]).toBe("新会话草稿");
  });

  it("drops the draft from memory and storage after send", () => {
    useUiStore.getState().setDraft("准备发送", "sess-1");
    useUiStore.getState().setDraft("pending leftover", PENDING_DRAFT_KEY);

    useUiStore.getState().clearSentDrafts("sess-1");

    expect(useUiStore.getState().drafts["sess-1"]).toBeUndefined();
    expect(useUiStore.getState().drafts[PENDING_DRAFT_KEY]).toBeUndefined();
    expect(memory.get(DRAFTS_STORAGE_KEY)).toBeUndefined();
    expect(loadDrafts()).toEqual({});
  });

  it("does not persist empty text after the user clears the composer", () => {
    useUiStore.getState().setDraft("临时内容", "sess-1");
    useUiStore.getState().setDraft("", "sess-1");
    expect(useUiStore.getState().drafts["sess-1"]).toBeUndefined();
    expect(memory.get(DRAFTS_STORAGE_KEY)).toBeUndefined();
  });

  it("clears all drafts when sending from session with pending new session", () => {
    // Simulate the full flow: send from session A, then create new session
    // User types in session A and sends
    useUiStore.getState().setDraft("会话A的内容", "sess-a");
    useUiStore.getState().clearSentDrafts("sess-a");
    
    // Should be cleared
    expect(useUiStore.getState().drafts["sess-a"]).toBeUndefined();
    expect(memory.get(DRAFTS_STORAGE_KEY)).toBeUndefined();
  });

  it("getComposerDraftKey uses pending key when pending or no session", () => {
    expect(getComposerDraftKey(null)).toBe(PENDING_DRAFT_KEY);
    expect(getComposerDraftKey("sess-1", true)).toBe(PENDING_DRAFT_KEY);
    expect(getComposerDraftKey("sess-1", false)).toBe("sess-1");
  });

  it("resolveComposerDraftText finds text across session and pending keys", () => {
    expect(
      resolveComposerDraftText({ "sess-1": "  hello  " }, "sess-1", false),
    ).toBe("hello");
    // UI wrote pending while focus still reports old sid (pending new session)
    expect(
      resolveComposerDraftText(
        { [PENDING_DRAFT_KEY]: "新任务", "sess-old": "旧草稿" },
        "sess-old",
        true,
      ),
    ).toBe("新任务");
    // Focus null but draft only under pending
    expect(
      resolveComposerDraftText({ [PENDING_DRAFT_KEY]: "only pending" }, null, false),
    ).toBe("only pending");
    // Focus sid empty, leftover pending still recoverable
    expect(
      resolveComposerDraftText({ [PENDING_DRAFT_KEY]: "leftover" }, "sess-1", false),
    ).toBe("leftover");
  });

  it("clears both session draft and pending draft after send", () => {
    // Simulate: user sends from session A, then clicks new session
    useUiStore.getState().setDraft("会话A的内容", "sess-a");
    useUiStore.getState().setDraft("pending内容", PENDING_DRAFT_KEY);

    // onSend clears the current session's draft
    useUiStore.getState().clearSentDrafts("sess-a");

    // Both should be cleared from memory and storage
    expect(useUiStore.getState().drafts["sess-a"]).toBeUndefined();
    expect(useUiStore.getState().drafts[PENDING_DRAFT_KEY]).toBeUndefined();
    expect(memory.get(DRAFTS_STORAGE_KEY)).toBeUndefined();
  });

  it("does not leave pending draft after send when creating new session", async () => {
    // Simulate the flow: send from old session, then create new session
    useUiStore.getState().setDraft("旧会话内容", "sess-old");
    useUiStore.getState().setDraft("pending残留", PENDING_DRAFT_KEY);

    // This is what onSend does when createPendingSession succeeds
    const oldSid = "sess-old";
    const newSid = "sess-new";
    useUiStore.getState().clearSentDrafts(oldSid);
    useUiStore.getState().clearSentDrafts(newSid);

    // Pending draft should not survive
    expect(useUiStore.getState().drafts[PENDING_DRAFT_KEY]).toBeUndefined();
    expect(memory.get(DRAFTS_STORAGE_KEY)).toBeUndefined();
  });
});
