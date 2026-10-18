import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef, useState, type ReactElement } from "react";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: vi.fn((initial: unknown) => [initial, vi.fn()]),
  useRef: vi.fn(() => ({ current: null })),
  useCallback: (callback: unknown) => callback,
  useEffect: vi.fn(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

import { AgentSidebar } from "./AgentSidebar";

function find(element: ReactElement, className: string): ReactElement[] {
  const matches: ReactElement[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const node = value as ReactElement<{ className?: string; children?: unknown }>;
    if (node.props?.className?.split(" ").includes(className)) matches.push(node);
    const children = node.props?.children;
    if (Array.isArray(children)) children.forEach(visit);
    else visit(children);
  };
  visit(element);
  return matches;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderRename(title: string | null = "修改后的名称", disabled = false) {
  const setRename = vi.fn();
  const contains = vi.fn(() => false);
  vi.mocked(useState)
    .mockImplementationOnce(() => [null, vi.fn()] as never)
    .mockImplementationOnce(() => [null, vi.fn()] as never)
    .mockImplementationOnce(() => [title === null ? null : { id: "one", root: "a", title, originalTitle: "one" }, setRename] as never);
  vi.mocked(useRef).mockReturnValueOnce({ current: { contains } } as never);
  const onRenameSession = vi.fn(async () => {});
  const onSwitchSession = vi.fn(async () => {});
  const onDeleteSession = vi.fn();
  const session = (id: string) => ({ id, title: id, projectRoot: "a", updatedAt: "2026-01-01" });
  const tree = AgentSidebar({
    projects: [{ root: "a", name: "a" }],
    sessions: [session("one"), session("two")] as never, sessionsByProject: {},
    workspace: { root: "a" } as never, activeSessionId: "one", expanded: { a: true }, disabled,
    onNewSession: vi.fn(), onAddProject: vi.fn(), onOpenSettings: vi.fn(),
    onSelectProject: vi.fn(async () => {}), onRemoveProject: vi.fn(async () => {}),
    onMoveProject: vi.fn(async () => {}), onSwitchSession, onDeleteSession, onRenameSession,
  });
  const [form] = find(tree, "session-rename");
  return { tree, form, setRename, contains, onRenameSession, onSwitchSession, onDeleteSession };
}

describe("会话行内重命名", () => {
  it("单击名称仍切换会话，双击名称进入行内编辑", async () => {
    const { tree, setRename, onSwitchSession, onRenameSession } = renderRename(null);
    await find(tree, "session-row")[1].props.onClick();
    expect(onSwitchSession).toHaveBeenCalledExactlyOnceWith("two", "a");
    expect(setRename).not.toHaveBeenCalled();

    const stopPropagation = vi.fn();
    find(tree, "session-title")[1].props.onDoubleClick({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalled();
    expect(setRename).toHaveBeenCalledExactlyOnceWith({ id: "two", root: "a", title: "two", originalTitle: "two" });
    expect(onRenameSession).not.toHaveBeenCalled();
  });

  it("禁用时双击名称不进入编辑", () => {
    const { tree, setRename } = renderRename(null, true);
    find(tree, "session-title")[0].props.onDoubleClick({ stopPropagation: vi.fn() });
    expect(setRename).not.toHaveBeenCalled();
  });

  it("编辑输入框自动聚焦并选中名称", () => {
    const { form } = renderRename("one");
    expect(form.props.children.props.autoFocus).toBe(true);
    const select = vi.fn();
    form.props.children.props.onFocus({ target: { select } });
    expect(select).toHaveBeenCalledOnce();
  });

  it("只显示输入框，通过表单提交保存名称，随后失焦不重复保存", async () => {
    const { form, onRenameSession } = renderRename();
    expect(form.props.children.type).toBe("input");
    const preventDefault = vi.fn();
    await form.props.onSubmit({ preventDefault });
    form.props.children.props.onBlur();
    expect(preventDefault).toHaveBeenCalled();
    expect(onRenameSession).toHaveBeenCalledExactlyOnceWith("one", "修改后的名称", "a");
  });

  it("Esc 取消，随后失焦也不保存", () => {
    const { form, setRename, onRenameSession } = renderRename();
    form.props.children.props.onKeyDown({ key: "Escape" });
    form.props.children.props.onBlur();
    expect(setRename).toHaveBeenCalledWith(null);
    expect(onRenameSession).not.toHaveBeenCalled();
  });

  it.each(["one", "  one  ", "   "])("名称未变化或为空时仅退出编辑：%s", async (title) => {
    const { form, setRename, onRenameSession } = renderRename(title);
    await form.props.onSubmit({ preventDefault: vi.fn() });
    expect(setRename).toHaveBeenCalledWith(null);
    expect(onRenameSession).not.toHaveBeenCalled();
  });

  it("失焦提交输入的名称", async () => {
    const { form, setRename, onRenameSession } = renderRename("  新名称  ");
    form.props.children.props.onBlur();
    await Promise.resolve();
    expect(onRenameSession).toHaveBeenCalledExactlyOnceWith("one", "新名称", "a");
    expect(setRename).toHaveBeenCalledWith(null);
  });

  it("点击框内保留编辑，点击外部提交且移除监听器", async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("document", { addEventListener, removeEventListener });
    const { contains, setRename, onRenameSession } = renderRename();
    const effect = vi.mocked(useEffect).mock.calls.find(([, deps]) => typeof deps?.[0] === "object" && deps[0] !== null)![0];
    const cleanup = effect();
    const [, cancel, capture] = addEventListener.mock.calls[0];
    expect(capture).toBe(true);
    contains.mockReturnValueOnce(true);
    cancel({ target: {} });
    expect(setRename).not.toHaveBeenCalled();
    cancel({ target: {} });
    await Promise.resolve();
    expect(setRename).toHaveBeenCalledWith(null);
    expect(onRenameSession).toHaveBeenCalledExactlyOnceWith("one", "修改后的名称", "a");
    if (typeof cleanup === "function") cleanup();
    expect(removeEventListener).toHaveBeenCalledWith("pointerdown", cancel, true);
  });

  it("点击其他会话提交编辑并继续切换，删除叉号仍需确认", async () => {
    const addEventListener = vi.fn();
    vi.stubGlobal("document", { addEventListener, removeEventListener: vi.fn() });
    const { tree, form, onRenameSession, onSwitchSession, onDeleteSession } = renderRename();
    const effect = vi.mocked(useEffect).mock.calls.find(([, deps]) => typeof deps?.[0] === "object" && deps[0] !== null)![0];
    effect();
    addEventListener.mock.calls[0][1]({ target: {} });
    form.props.children.props.onBlur();
    await find(tree, "session-row")[0].props.onClick();
    expect(onSwitchSession).toHaveBeenCalledWith("two", "a");
    expect(onRenameSession).toHaveBeenCalledExactlyOnceWith("one", "修改后的名称", "a");
    find(tree, "session-delete")[0].props.onClick({ stopPropagation: vi.fn() });
    expect(onDeleteSession).not.toHaveBeenCalled();
  });
});

describe("项目标题栏拖动", () => {
  it("不显示拖动手柄，名称仍可拖动、选择，箭头仍可展开折叠", async () => {
    const onSelectProject = vi.fn(async () => {});
    const onToggleExpand = vi.fn();
    const onMoveProject = vi.fn(async () => {});
    const tree = AgentSidebar({
      projects: [{ root: "a", name: "a" }, { root: "b", name: "b" }],
      sessions: [], sessionsByProject: {}, workspace: null, activeSessionId: null, expanded: {},
      onNewSession: vi.fn(), onAddProject: vi.fn(), onOpenSettings: vi.fn(),
      onSelectProject, onToggleExpand, onRemoveProject: vi.fn(async () => {}), onMoveProject,
      onSwitchSession: vi.fn(async () => {}), onDeleteSession: vi.fn(),
    });
    const [header] = find(tree, "project-header");
    const [row] = find(tree, "project-row");
    expect(find(tree, "project-drag-handle")).toHaveLength(0);
    const [chevron] = find(tree, "project-chevron");
    expect(row.props.draggable).toBe(true);

    expect(chevron.props.draggable).toBeUndefined();
    const setData = vi.fn();
    const transfer = { effectAllowed: "", setData };
    header.props.onDragStart({ dataTransfer: transfer });
    expect(transfer.effectAllowed).toBe("move");
    expect(setData).toHaveBeenCalledWith("text/plain", "a");
    await row.props.onClick();
    expect(onSelectProject).toHaveBeenCalledWith("a");
    chevron.props.onClick();
    expect(onToggleExpand).toHaveBeenCalledWith("a");
  });
});
