import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect as ReactUseEffect, type ChangeEvent, type ComponentProps, type ReactElement, type RefObject } from "react";

// 在 Node 中执行真实事件回调、草稿存储、新会话创建与发送链路。
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [initial, vi.fn()],
  useEffect: vi.fn(),
}));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

import { mergeIncomingHistory, useChatActions } from "./useChatActions";
import { useSessionSync } from "./useSessionSync";
import { ComposerInput } from "../components/composer/ComposerInput";
import { useContextMenu } from "../components/composer/useContextMenu";
import { useSessionStore } from "../store/session-store";
import { useChatStore } from "../store/chat-store";
import { syncFocusSession } from "../store/focus-session";
import { getComposerDraftKey, PENDING_DRAFT_KEY, useUiStore } from "../store/ui-store";
import type { ChatTurnDto, SpecTaskDocumentDto, TaskItemDto } from "../../../preload/index";
import { dropQueue, hydrateQueue, requestStop, resumeQueue } from "./queue-controller";

describe("mergeIncomingHistory", () => {
  it("replaces an optimistic user turn when the persisted turn has an id", () => {
    const merged = mergeIncomingHistory(
      [{ role: "user", content: "hello" }],
      [
        { role: "user", id: "turn-1", content: "hello" },
        { role: "assistant", id: "reply-1", content: "world" },
      ],
    );

    expect(merged).toEqual([
      { role: "user", id: "turn-1", content: "hello" },
      { role: "assistant", id: "reply-1", content: "world" },
    ]);
  });

  it("does not duplicate a committed reply already present in local history", () => {
    const reply = { role: "assistant" as const, id: "reply-1", content: "world" };
    const merged = mergeIncomingHistory(
      [
        { role: "user", content: "hello" },
        reply,
      ],
      [
        { role: "user", id: "turn-1", content: "hello" },
        { role: "assistant", id: "reply-1", content: "world" },
      ],
    );

    expect(merged).toEqual([
      { role: "user", id: "turn-1", content: "hello" },
      reply,
    ]);
  });
});

describe("新会话输入到发送载荷", () => {
  const workspace = { root: "E:/project", name: "project" };
  let sync: ReturnType<typeof useSessionSync>;
  let actions: ReturnType<typeof useChatActions>;
  let ipc: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.useFakeTimers();
    useUiStore.setState({ drafts: {} });
    useChatStore.setState({ bySession: {} });
    useSessionStore.setState({
      workspace,
      llmConfigured: true,
      sessions: [],
      sessionsByProject: { [workspace.root]: [] },
      activePlanMetaBySession: {},
    });
    syncFocusSession(null);
    ipc = {
      switchWorkspacePath: vi.fn(async () => {}),
      createChatSession: vi.fn(async () => ({
        meta: { id: "new", title: "新会话", updatedAt: "2026-01-01", pinned: false },
        history: [],
      })),
      sendChat: vi.fn(async (text: string, sid: string) => ({
        ok: true, history: [{ role: "user", content: text }], sessionId: sid, sessionTitle: text,
      })),
      getChatHistoryPage: vi.fn(async () => ({ turns: [], hasMore: false })),
      setQueuedMessages: vi.fn(async () => {}),
      clearChat: vi.fn(async () => {}),
    };
    vi.stubGlobal("window", { owncoder: ipc });
    sync = useSessionSync();
    actions = useChatActions({
      ...sync,
      refreshChanges: vi.fn(async () => {}),
      refreshGit: vi.fn(async () => {}),
      refreshSessions: vi.fn(async () => {}),
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function input() {
    const key = getComposerDraftKey(useSessionStore.getState().activeSessionId, sync.pendingNewSessionRef.current);
    const onDraft = (text: string) => useUiStore.getState().setDraft(text, key);
    const draft = useUiStore.getState().drafts[key] ?? "";
    const textareaRef: RefObject<HTMLTextAreaElement | null> = { current: null };
    const ctx = useContextMenu(draft, onDraft, textareaRef);
    const tree = ComposerInput({
      draft, onDraft, textareaRef, ctx, mode: "agent", disabled: false,
      mention: { isOpen: false, mentionHits: [], mentionIndex: 0, syncMention: vi.fn(), insertMention: vi.fn(), handleKeyDown: () => false },
      attachments: [], attachmentImageSrc: () => null,
      onRemoveAttachment: vi.fn(), onRetryUpload: vi.fn(), onPreviewAttachment: vi.fn(), onNewSession: vi.fn(),
    });
    const textarea = (tree.props.children as ReactElement[]).find((child) => child?.type === "textarea")!;
    const props = textarea.props as ComponentProps<"textarea">;
    return {
      change: (value: string, inputType = "insertText") => props.onChange!({
        target: { value, selectionStart: value.length }, nativeEvent: { inputType },
      } as unknown as ChangeEvent<HTMLTextAreaElement>),
      ctx, textareaRef,
    };
  }

  it.each([
    ["仅粘贴普通文本", "粘贴的任务\n第二行", "insertFromPaste"],
    ["仅粘贴代码注释", "/* 修复输入同步 */\nconst value = 1;", "insertFromPaste"],
    ["仅粘贴绝对路径", "/home/user/project/file.ts", "insertFromPaste"],
    ["普通键盘输入", "键盘输入的任务", "insertText"],
    ["双斜杠注释", "// 注释内容", "insertFromPaste"],
  ])("%s 保留共享草稿并提交新会话", async (_name, text, inputType) => {
    await sync.onNewSession();
    input().change(text, inputType);
    expect(useUiStore.getState().drafts[PENDING_DRAFT_KEY]).toBe(text);
    await actions.onSend();
    await vi.runAllTimersAsync();
    expect(ipc.createChatSession).toHaveBeenCalledTimes(1);
    expect(ipc.sendChat).toHaveBeenCalledWith(text, "new", undefined);
    expect(useChatStore.getState().bySession.new?.history).toEqual([{ role: "user", content: text }]);
    expect(useUiStore.getState().drafts).toEqual({});
  });

  it.each([
    ["awaiting_spec_approval", "下一步"],
    ["awaiting_design_approval", "这个方案我看过了，可以拆成可执行的清单了"],
    ["awaiting_design_approval", "接下来会做什么？"],
    ["awaiting_design_approval", "先修改设计，不要生成任务"],
    ["awaiting_tasks_approval", "继续"],
    ["awaiting_tasks_approval", "next!"],
  ])("在 %s 阶段原样发送 %s，不走桌面端审批或执行", async (stage, text) => {
    const sid = "review-spec";
    syncFocusSession(sid);
    useSessionStore.getState().setMode("spec");
    ipc.getSessionState = vi.fn(async () => ({ currentFeature: "login" }));
    ipc.listSpecs = vi.fn(async () => [{ name: "login", stage }]);
    ipc.keepAllChanges = vi.fn(async () => {});
    ipc.approveSpec = vi.fn();
    ipc.prepareSpecTaskExecution = vi.fn();
    const attachments = [{ name: "design.png", mimeType: "image/png", url: "data:image/png;base64,AA==" }];
    input().change(text);
    await actions.onSend(attachments);
    await vi.runAllTimersAsync();
    expect(ipc.getSessionState).not.toHaveBeenCalled();
    expect(ipc.listSpecs).not.toHaveBeenCalled();
    expect(ipc.approveSpec).not.toHaveBeenCalled();
    expect(ipc.keepAllChanges).not.toHaveBeenCalled();
    expect(ipc.prepareSpecTaskExecution).not.toHaveBeenCalled();
    expect(ipc.sendChat).toHaveBeenCalledExactlyOnceWith(text, sid, attachments);
    expect(useSessionStore.getState().mode).toBe("spec");
  });

  it("粘贴后继续编辑，发送最后一次编辑的值", async () => {
    await sync.onNewSession();
    input().change("粘贴", "insertFromPaste");
    input().change("粘贴后继续编辑");
    await actions.onSend();
    await vi.runAllTimersAsync();
    expect(ipc.sendChat).toHaveBeenCalledWith("粘贴后继续编辑", "new", undefined);
  });

  it("纯空白不创建会话也不发送", async () => {
    await sync.onNewSession();
    input().change(" \n\t ", "insertFromPaste");
    await actions.onSend();
    await vi.runAllTimersAsync();
    expect(ipc.createChatSession).not.toHaveBeenCalled();
    expect(ipc.sendChat).not.toHaveBeenCalled();
  });

  it("右键菜单仅粘贴后直接发送，不依赖键盘事件", async () => {
    await sync.onNewSession();
    const text = "/* 从剪贴板粘贴 */\n任务正文";
    vi.stubGlobal("navigator", { clipboard: { readText: vi.fn(async () => text) } });
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    const editor = input();
    editor.textareaRef.current = { selectionStart: 0, selectionEnd: 0 } as HTMLTextAreaElement;
    editor.ctx.execCtxAction("paste");
    await Promise.resolve();
    expect(useUiStore.getState().drafts[PENDING_DRAFT_KEY]).toBe(text);
    await actions.onSend();
    await vi.runAllTimersAsync();
    expect(ipc.sendChat).toHaveBeenCalledWith(text, "new", undefined);
  });

  it("新会话创建期间清空草稿也不会改变已捕获的发送文本和附件", async () => {
    await sync.onNewSession();
    input().change("/path/to/file", "insertFromPaste");
    const attachments = [{ name: "file.txt", mimeType: "text/plain", url: "attachment://file-1", size: 10 }];
    ipc.createChatSession!.mockImplementationOnce(async () => {
      useUiStore.getState().clearSentDrafts();
      return { meta: { id: "new", title: "新会话", updatedAt: "2026-01-01", pinned: false }, history: [] };
    });
    await actions.onSend(attachments);
    await vi.runAllTimersAsync();
    expect(ipc.sendChat).toHaveBeenCalledWith("/path/to/file", "new", attachments);
  });

  it("已识别的斜杠命令仍执行且不发送给模型", async () => {
    await sync.onNewSession();
    useUiStore.getState().setDraft("/clear", PENDING_DRAFT_KEY);
    await actions.onSend();
    await vi.runAllTimersAsync();
    expect(ipc.clearChat).toHaveBeenCalledWith("new");
    expect(ipc.sendChat).not.toHaveBeenCalled();
    expect(useUiStore.getState().drafts).toEqual({});
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function task(id: string, status: TaskItemDto["status"] = "pending", dependsOn: string[] = []): TaskItemDto {
  return { id, status, dependsOn, executionGuidance: id, retryCount: 0, maxRetries: 2 };
}

describe("spec task orchestration", () => {
  const sid = "spec-task-session";
  const otherSid = "other-spec-task-session";
  const path = ".owncoder/specs/sessions/spec-task-session/login/tasks.md";
  const version = "revision-1";
  const approvedAt = "2026-01-01T00:00:00.000Z";
  const doc = (...tasks: TaskItemDto[]): SpecTaskDocumentDto => ({ path, version, approvedAt, tasks, currentTaskId: null });
  const ref = (taskId: string) => ({ path, version, approvedAt, taskId });
  const completed = (sessionId = sid, history: ChatTurnDto[] = []) => ({
    ok: true as const, history, sessionId, sessionTitle: null, taskOutcome: { status: "completed" as const },
  });
  const deps = {
    applySessionState: vi.fn(async () => null),
    refreshChanges: vi.fn(async () => {}),
    refreshGit: vi.fn(async () => {}),
    refreshSessions: vi.fn(async () => {}),
    refreshPlans: vi.fn(async () => {}),
    refreshSpecs: vi.fn(async () => {}),
    refreshActivePlan: vi.fn(async () => null),
    pendingNewSessionRef: { current: false },
    createPendingSession: vi.fn(async () => null),
    onNewSession: vi.fn(async () => {}),
  };
  let actions: ReturnType<typeof useChatActions>;
  let ipc: Record<string, ReturnType<typeof vi.fn>>;
  let latest: SpecTaskDocumentDto | null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ReactUseEffect).mockImplementation((effect) => { cleanup = effect(); });
    useChatStore.setState({ bySession: {} });
    useUiStore.setState({ drafts: {} });
    useSessionStore.setState({
      workspace: { root: "E:/project", name: "project" },
      llmConfigured: true,
      mode: "agent",
      activePlanMetaBySession: {},
    });
    syncFocusSession(sid);
    latest = doc(task("first"), task("second", "pending", ["first"]));
    ipc = {
      keepAllChanges: vi.fn(async () => {}),
      approvePlan: vi.fn(async () => ({ mode: "agent", activePlanPath: "plans/empty.md" })),
      getChatHistory: vi.fn(async () => []),
      getSpecTaskDocument: vi.fn(async () => latest),
      getChatHistoryPage: vi.fn(async () => ({ turns: [], hasMore: false })),
      prepareSpecTaskExecution: vi.fn(async () => {
        if (latest && !latest.approvedAt) latest = { ...latest, approvedAt };
        return { mode: "agent", currentFeature: "login", activePlanPath: path };
      }),
      updateTask: vi.fn(async () => null),
      sendChat: vi.fn(async () => completed()),
      setQueuedMessages: vi.fn(async () => {}),
    };
    vi.stubGlobal("window", { owncoder: ipc });
    actions = useChatActions(deps);
  });

  let cleanup: ReturnType<Parameters<typeof ReactUseEffect>[0]>;
  afterEach(() => {
    if (typeof cleanup === "function") cleanup();
    vi.mocked(ReactUseEffect).mockReset();
    dropQueue(sid);
    dropQueue(otherSid);
    vi.unstubAllGlobals();
  });

  it("runs dependency-ready pending tasks serially as chat turns using refreshed state", async () => {
    latest = doc(task("second", "pending", ["first", "skipped"]), task("first"), task("skipped", "skipped"));
    const initial = latest;
    const firstTurn = deferred<ReturnType<typeof completed>>();
    const persisted: ChatTurnDto[] = [];
    ipc.sendChat!.mockImplementationOnce((text: string) => {
      persisted.push({ role: "user", id: "user-1", content: text });
      return firstTurn.promise;
    }).mockImplementationOnce(async (text: string) => {
      persisted.push({ role: "user", id: "user-2", content: text });
      latest = doc(task("first", "completed"), task("second", "completed"));
      return completed(sid, [...persisted]);
    });

    const run = actions.onExecuteSpecTasks(sid, initial);
    await vi.waitFor(() => expect(ipc.sendChat).toHaveBeenCalledExactlyOnceWith(expect.any(String), sid, undefined, ref("first")));
    expect(useChatStore.getState().isSessionSending(sid)).toBe(true);
    expect(deps.refreshActivePlan).toHaveBeenCalledExactlyOnceWith(sid);
    latest = doc(task("second", "pending", ["first", "skipped"]), task("first", "completed"), task("skipped", "skipped"));
    firstTurn.resolve(completed(sid, [...persisted]));
    await run;

    expect(ipc.sendChat).toHaveBeenNthCalledWith(2, expect.any(String), sid, undefined, ref("second"));
    expect(ipc.sendChat).toHaveBeenCalledTimes(2);
    expect(ipc.getSpecTaskDocument).toHaveBeenCalledTimes(4);
    expect(deps.refreshActivePlan).toHaveBeenCalledTimes(3);
    expect(useChatStore.getState().bySession[sid]?.history).toEqual(persisted);
    expect(useChatStore.getState().isSessionSending(sid)).toBe(false);
    expect(ipc.setQueuedMessages).not.toHaveBeenCalled();
  });

  it("runs only the selected row without prior activation and does not start its dependent", async () => {
    const initial = { ...doc(task("unrelated"), task("selected"), task("dependent", "pending", ["selected"])), approvedAt: null };
    latest = initial;
    ipc.sendChat!.mockImplementationOnce(async () => {
      latest = doc(task("unrelated"), task("selected", "completed"), task("dependent", "pending", ["selected"]));
      return completed();
    });
    await actions.onExecuteSpecTasks(sid, initial, "selected");
    expect(ipc.prepareSpecTaskExecution).toHaveBeenCalledExactlyOnceWith(path, version, sid);
    expect(ipc.sendChat).toHaveBeenCalledExactlyOnceWith(expect.any(String), sid, undefined, ref("selected"));
  });

  it("does not run a different row when the selected row is blocked by a prerequisite", async () => {
    const initial = doc(task("prerequisite"), task("selected", "pending", ["prerequisite"]));
    latest = initial;
    await actions.onExecuteSpecTasks(sid, initial, "selected");
    expect(ipc.prepareSpecTaskExecution).not.toHaveBeenCalled();
    expect(ipc.sendChat).not.toHaveBeenCalled();
  });

  it("stops on failure and retries it only on another explicit batch start", async () => {
    latest = doc(task("retry", "pending", ["done"]), task("unrelated"), task("done", "completed"));
    ipc.sendChat!.mockImplementationOnce(async () => {
      latest = doc(task("retry", "failed", ["done"]), task("unrelated"), task("done", "completed"));
      return { ...completed(), taskOutcome: { status: "failed" } };
    }).mockImplementationOnce(async () => {
      latest = doc(task("retry", "completed"), task("unrelated"), task("done", "completed"));
      return completed();
    });

    await actions.onExecuteSpecTasks(sid, latest);
    expect(ipc.sendChat).toHaveBeenCalledExactlyOnceWith(expect.any(String), sid, undefined, ref("retry"));

    await actions.onExecuteSpecTasks(sid, latest);
    expect(ipc.sendChat).toHaveBeenCalledTimes(3);
    expect(ipc.sendChat).toHaveBeenNthCalledWith(2, expect.any(String), sid, undefined, ref("retry"));
    expect(ipc.sendChat).toHaveBeenNthCalledWith(3, expect.any(String), sid, undefined, ref("unrelated"));
  });

  it("shows a recoverable status when an approved plan has no executable tasks", async () => {
    deps.refreshActivePlan.mockResolvedValue({ path: "plans/empty.md", tasks: [] } as never);
    await actions.onApprovePlan();
    expect(useChatStore.getState().bySession[sid]?.liveStatus).toContain("没有可执行任务");
    expect(ipc.sendChat).not.toHaveBeenCalled();
  });

  it("shows a recoverable status when executing an active plan with no tasks", () => {
    useSessionStore.setState({ activePlanMetaBySession: { [sid]: { path: "plans/empty.md", tasks: [] } } });
    actions.onExecutePlan(sid);
    expect(useChatStore.getState().bySession[sid]?.liveStatus).toContain("没有可执行任务");
    expect(useChatStore.getState().isSessionSending(sid)).toBe(false);
  });

  it.each([
    ["empty", []],
    ["missing dependency", [task("blocked", "pending", ["missing"])]],
    ["failed dependency", [task("blocked", "pending", ["dependency"]), task("dependency", "failed", ["missing"])]],
    ["in-progress task", [task("busy", "in_progress"), task("ready")]],
    ["finished tasks", [task("done", "completed"), task("skipped", "skipped")]],
  ] as const)("does not prepare or execute a document with %s", async (_reason, tasks) => {
    const initial = doc(...tasks);
    latest = initial;
    await actions.onExecuteSpecTasks(sid, initial);
    expect(ipc.prepareSpecTaskExecution).not.toHaveBeenCalled();
    expect(ipc.sendChat).not.toHaveBeenCalled();
  });

  it.each(["failed", "blocked", "cancelled", "missing", "error", "rejected", "not persisted"] as const)(
    "does not advance after a %s outcome", async (status) => {
      const initial = doc(task("first"), task("independent"));
      latest = initial;
      ipc.sendChat!.mockImplementationOnce(async () => {
        latest = doc(task("first", status === "not persisted" ? "failed" : "completed"), task("independent"));
        if (status === "rejected") throw new Error("IPC rejected");
        if (status === "error") return { ...completed(), ok: false, error: "Send failed" };
        if (status === "not persisted") return completed();
        return { ...completed(), taskOutcome: status === "missing" ? undefined : { status } };
      });
      await actions.onExecuteSpecTasks(sid, initial);
      expect(ipc.sendChat).toHaveBeenCalledTimes(1);
      expect(ipc.getSpecTaskDocument).toHaveBeenCalledTimes(3);
      expect(useChatStore.getState().isSessionSending(sid)).toBe(false);
    },
  );

  it.each([
    ["unavailable", null],
    ["different path", { path: "other/tasks.md" }],
    ["changed version", { version: "revision-2" }],
    ["changed approval", { approvedAt: "2026-01-02T00:00:00.000Z" }],
    ["unapproved", { approvedAt: null }],
  ] as const)("stops at a %s document", async (_reason, change) => {
    const initial = doc(task("first"), task("independent"));
    const changed = change && { ...doc(task("first", "completed"), task("independent")), ...change };
    if (!change || "path" in change || "version" in change) {
      latest = changed;
      await actions.onExecuteSpecTasks(sid, initial);
      expect(ipc.prepareSpecTaskExecution).not.toHaveBeenCalled();
      expect(ipc.sendChat).not.toHaveBeenCalled();
    }

    latest = initial;
    ipc.sendChat!.mockImplementationOnce(async () => {
      latest = changed;
      return completed();
    });
    await actions.onExecuteSpecTasks(sid, initial);
    expect(ipc.sendChat).toHaveBeenCalledTimes(1);
  });

  it("locks duplicate runs per session without blocking another session", async () => {
    const initial = latest!;
    const loading = deferred<SpecTaskDocumentDto>();
    ipc.getSpecTaskDocument!.mockImplementationOnce(() => loading.promise);
    const run = actions.onExecuteSpecTasks(sid, initial);
    await actions.onExecuteSpecTasks(sid, initial);
    await actions.onExecuteSpecTasks(otherSid, initial);
    expect(ipc.sendChat).toHaveBeenCalledExactlyOnceWith(expect.any(String), otherSid, undefined, ref("first"));
    loading.resolve(initial);
    await run;
    expect(ipc.sendChat).toHaveBeenNthCalledWith(2, expect.any(String), sid, undefined, ref("first"));
  });

  it("honors Stop during document refresh without waking queued ordinary messages", async () => {
    const initial = latest!;
    const reloading = deferred<SpecTaskDocumentDto>();
    ipc.getSpecTaskDocument!.mockResolvedValueOnce(initial).mockResolvedValueOnce(initial).mockImplementationOnce(() => reloading.promise);
    const run = actions.onExecuteSpecTasks(sid, initial);
    await vi.waitFor(() => expect(ipc.getSpecTaskDocument).toHaveBeenCalledTimes(3));
    requestStop(sid);
    useChatStore.getState().setStopping(true, sid);
    useUiStore.getState().setDraft("ordinary", sid);
    await actions.onSend();
    reloading.resolve(doc(task("first", "completed"), task("second")));
    await run;
    resumeQueue(sid);
    expect(ipc.sendChat).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().bySession[sid]).toMatchObject({ sending: false, stopping: false, queuedMessages: [{ text: "ordinary" }] });

    actions.sendQueued(sid, 0);
    await vi.waitFor(() => expect(ipc.sendChat).toHaveBeenNthCalledWith(2, "ordinary", sid, undefined));
  });

  it("runs an ordinary message explicitly submitted during a batch only after the batch releases the lock", async () => {
    const initial = latest!;
    const turn = deferred<ReturnType<typeof completed>>();
    ipc.sendChat!.mockImplementationOnce(() => turn.promise);
    const run = actions.onExecuteSpecTasks(sid, initial);
    await vi.waitFor(() => expect(ipc.sendChat).toHaveBeenCalledTimes(1));
    useUiStore.getState().setDraft("ordinary", sid);
    await actions.onSend();
    expect(ipc.sendChat).toHaveBeenCalledTimes(1);
    turn.resolve(completed());
    await run;
    await vi.waitFor(() => expect(ipc.sendChat).toHaveBeenNthCalledWith(2, "ordinary", sid, undefined));
  });

  it("does not unpause ordinary messages when starting a fresh spec action", async () => {
    hydrateQueue(sid, [{ text: "paused ordinary message" }]);
    requestStop(sid);

    await actions.onExecuteSpecTasks(sid, latest!);
    resumeQueue(sid);
    expect(ipc.sendChat).toHaveBeenCalledExactlyOnceWith(expect.any(String), sid, undefined, ref("first"));
    expect(useChatStore.getState().bySession[sid]?.queuedMessages).toEqual([{ text: "paused ordinary message" }]);
  });

  it.each(["first activation", "switched back to Spec"])("prepares the exact document on %s and refreshes progress before sending", async (reason) => {
    const initial = { ...latest!, approvedAt: reason === "first activation" ? null : approvedAt };
    latest = initial;
    useSessionStore.getState().setMode("spec");
    const refreshing = deferred<null>();
    deps.refreshActivePlan.mockImplementationOnce(() => refreshing.promise);
    const run = actions.onExecuteSpecTasks(sid, initial);
    await vi.waitFor(() => expect(deps.refreshActivePlan).toHaveBeenCalledExactlyOnceWith(sid));
    expect(ipc.prepareSpecTaskExecution).toHaveBeenCalledExactlyOnceWith(path, version, sid);
    expect(deps.refreshSpecs).toHaveBeenCalledExactlyOnceWith(sid);
    expect(useSessionStore.getState().mode).toBe("agent");
    expect(ipc.sendChat).not.toHaveBeenCalled();
    refreshing.resolve(null);
    await run;
    expect(ipc.sendChat).toHaveBeenCalledExactlyOnceWith(expect.any(String), sid, undefined, ref("first"));
  });

  it("preserves the new session's focused mode when focus changes during preparation", async () => {
    const initial = latest!;
    const preparation = deferred<{ mode: string; currentFeature: string; activePlanPath: string }>();
    ipc.prepareSpecTaskExecution!.mockImplementationOnce(() => preparation.promise);
    const run = actions.onExecuteSpecTasks(sid, initial);
    await vi.waitFor(() => expect(ipc.prepareSpecTaskExecution).toHaveBeenCalledOnce());
    syncFocusSession(otherSid);
    useSessionStore.getState().setMode("spec");
    preparation.resolve({ mode: "agent", currentFeature: "login", activePlanPath: path });
    await run;
    expect(useSessionStore.getState().mode).toBe("spec");
    expect(deps.refreshSpecs).toHaveBeenCalledExactlyOnceWith(sid);
    expect(ipc.sendChat).toHaveBeenCalledExactlyOnceWith(expect.any(String), sid, undefined, ref("first"));
  });

  it("reports preparation errors and releases the lock for another click", async () => {
    const initial = latest!;
    ipc.prepareSpecTaskExecution!.mockRejectedValueOnce(new Error("Stale version"));
    await actions.onExecuteSpecTasks(sid, initial);
    expect(useChatStore.getState().bySession[sid]?.errorAlert).toMatchObject({ message: "Stale version" });
    expect(deps.refreshActivePlan).not.toHaveBeenCalled();
    expect(ipc.sendChat).not.toHaveBeenCalled();
    await actions.onExecuteSpecTasks(sid, initial);
    expect(ipc.prepareSpecTaskExecution).toHaveBeenCalledTimes(2);
    expect(ipc.sendChat).toHaveBeenCalledTimes(1);
  });

  it("honors Stop while the initial document is loading without preparing it", async () => {
    const initial = latest!;
    const loading = deferred<SpecTaskDocumentDto>();
    ipc.getSpecTaskDocument!.mockImplementationOnce(() => loading.promise);
    const run = actions.onExecuteSpecTasks(sid, initial);
    requestStop(sid);
    loading.resolve(initial);
    await run;
    expect(ipc.prepareSpecTaskExecution).not.toHaveBeenCalled();
    expect(ipc.sendChat).not.toHaveBeenCalled();
  });

  it("anchors document task updates to the approval and preserves the legacy call shape", async () => {
    await actions.onUpdateTask("first", "skipped", sid, { ...latest!, approvedAt: null });
    expect(ipc.updateTask).not.toHaveBeenCalled();
    await actions.onUpdateTask("first", "skipped", sid, latest!);
    await actions.onUpdateTask("first", "pending", sid);
    expect(ipc.updateTask).toHaveBeenNthCalledWith(1, "first", "skipped", undefined, sid, ref("first"));
    expect(ipc.updateTask).toHaveBeenNthCalledWith(2, "first", "pending", undefined, sid);
  });
});
