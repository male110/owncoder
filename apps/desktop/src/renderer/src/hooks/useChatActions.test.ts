import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeEvent, ComponentProps, ReactElement, RefObject } from "react";

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
