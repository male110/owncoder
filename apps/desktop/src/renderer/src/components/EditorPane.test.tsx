import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const hooks = vi.hoisted(() => {
  vi.stubGlobal("self", {});
  return {
    refs: [] as Array<{ current: unknown }>,
    refIndex: 0,
    effects: [] as Array<() => void | (() => void)>,
    effectDeps: [] as Array<unknown[] | undefined>,
    states: [] as unknown[],
    stateIndex: 0,
    memos: [] as Array<{ value: unknown; deps: unknown[] }>,
    memoIndex: 0,
  };
});
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (value: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = value;
    return [hooks.states[index], (next: unknown) => { hooks.states[index] = next; }];
  },
  useRef: (value: unknown) => {
    const index = hooks.refIndex++;
    return hooks.refs[index] ??= { current: value };
  },
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    const index = hooks.memoIndex++;
    const previous = hooks.memos[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      hooks.memos[index] = { value: factory(), deps };
    }
    return hooks.memos[index].value;
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    hooks.effects.push(effect);
    hooks.effectDeps.push(deps);
  },
}));
vi.mock("@monaco-editor/react", () => ({
  default: "mock-editor",
  DiffEditor: "mock-diff",
  loader: { config: vi.fn() },
}));
vi.mock("monaco-editor", () => ({ KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49 } }));
vi.mock("./monaco-editor.worker?worker", () => ({ default: vi.fn() }));
vi.mock("./monaco-typescript.worker?worker", () => ({ default: vi.fn() }));
vi.mock("../store/ui-store", () => ({ useUiStore: () => "codex" }));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./Markdown", () => ({ Markdown: "mock-markdown" }));

import { EditorPane } from "./EditorPane";

type Element = ReactElement<Record<string, any>>;
function findElement(node: unknown, type: string): Element | undefined {
  if (Array.isArray(node)) return node.map((child) => findElement(child, type)).find(Boolean);
  if (!node || typeof node !== "object" || !("type" in node)) return undefined;
  const element = node as Element;
  return element.type === type ? element : findElement(element.props.children, type);
}
const findDiff = (node: unknown) => findElement(node, "mock-diff");
const findEditor = (node: unknown) => findElement(node, "mock-editor");
function render(props: Parameters<typeof EditorPane>[0]) {
  hooks.refIndex = 0;
  hooks.effects = [];
  hooks.effectDeps = [];
  hooks.stateIndex = 0;
  hooks.memoIndex = 0;
  return EditorPane(props);
}

beforeEach(() => {
  hooks.refs = [];
  hooks.refIndex = 0;
  hooks.effects = [];
  hooks.effectDeps = [];
  hooks.states = [];
  hooks.stateIndex = 0;
  hooks.memos = [];
  hooks.memoIndex = 0;
});

describe("变更查看器", () => {
  it("首次渲染直接传入完整快照，不等待加载 effect", () => {
    const diff = findDiff(render({ path: "src/a.ts", diffMode: true, originalContent: "旧内容", content: "新内容" }))!;
    expect(diff.props.original).toBe("旧内容");
    expect(diff.props.modified).toBe("新内容");
    expect(diff.props.options.hideUnchangedRegions.enabled).toBe(true);
  });

  it("已打开的普通文件切换到变更时也有独立模型 URI", () => {
    render({ path: "src/a.ts" });
    const diff = findDiff(render({ path: "src/a.ts", diffMode: true, originalContent: "旧", content: "新" }))!;
    expect(diff.props.originalModelPath).toMatch(/^inmemory:\/\/owncoder\/diff\//);
    expect(diff.props.modifiedModelPath).toMatch(/^inmemory:\/\/owncoder\/diff\//);
    expect(diff.props.originalModelPath).not.toBe(diff.props.modifiedModelPath);
  });

  it("关闭页签后才延迟释放普通和 Diff 模型，并防止重复释放", async () => {
    const diff = findDiff(render({ path: "src/a.ts", diffMode: true, originalContent: "旧", content: "新" }))!;
    const model = () => ({ isDisposed: () => false, dispose: vi.fn() });
    const original = model();
    const modified = model();
    const normal = model();
    diff.props.onMount({ getModel: () => ({ original, modified }), layout: vi.fn(), getModifiedEditor: () => ({ focus: vi.fn() }) });
    const tree = render({ path: "src/a.ts", diffMode: true, originalContent: "旧", content: "新" });
    findEditor(tree)!.props.onMount({ getModel: () => normal, updateOptions: vi.fn(), addCommand: vi.fn() });
    // 倒数第二个 effect 负责页签生命周期清理，最后一个负责显示布局。
    const cleanup = hooks.effects.at(-2)!() as () => void;
    cleanup();
    expect(original.dispose).not.toHaveBeenCalled();
    expect(modified.dispose).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(original.dispose).toHaveBeenCalledOnce();
    expect(modified.dispose).toHaveBeenCalledOnce();
    expect(normal.dispose).toHaveBeenCalledOnce();
    cleanup();
    await Promise.resolve();
    expect(normal.dispose).toHaveBeenCalledOnce();
    expect(original.dispose).toHaveBeenCalledOnce();
  });

  it("往返切换保留两个编辑器、Diff URI 和最后一次快照", () => {
    const normal = render({ path: "src/a.ts" });
    expect(findEditor(normal)).toBeDefined();
    expect(findDiff(normal)).toBeUndefined();
    const first = render({ path: "src/a.ts", diffMode: true, originalContent: "旧", content: "新" });
    const firstDiff = findDiff(first)!;
    expect(findEditor(first)!.props.options.readOnly).toBe(true);
    const back = render({ path: "src/a.ts" });
    expect(findDiff(back)!.props.original).toBe("旧");
    expect(findDiff(back)!.props.modified).toBe("新");
    expect(findDiff(back)!.props.originalModelPath).toBe(firstDiff.props.originalModelPath);
    expect(findEditor(back)!.props.options.readOnly).toBe(false);
    const repeated = render({ path: "src/a.ts", diffMode: true, originalContent: "旧2", content: "新2" });
    expect(findDiff(repeated)!.props.originalModelPath).toBe(firstDiff.props.originalModelPath);
    expect(findDiff(repeated)!.props.modified).toBe("新2");
  });

  it("隐藏普通编辑器不接收内容修改，切回时恢复未保存内容", () => {
    const normal = render({ path: "src/a.ts" });
    findEditor(normal)!.props.onChange("未保存");
    const diff = render({ path: "src/a.ts", diffMode: true, originalContent: "旧", content: "新" });
    findEditor(diff)!.props.onChange("隐藏编辑器的回调");
    const back = render({ path: "src/a.ts" });
    expect(findEditor(back)!.props.value).toBe("未保存");
  });

  it("普通文件异步读取不能覆盖 Diff 快照，取消的读取可重新加载", async () => {
    let resolveRead!: (text: string) => void;
    const read = vi.fn(() => new Promise<string>((resolve) => { resolveRead = resolve; }));
    vi.stubGlobal("window", { owncoder: { readWorkspaceFile: read } });
    render({ path: "src/a.ts" });
    const cancelRead = hooks.effects[1]() as () => void;
    cancelRead();
    render({ path: "src/a.ts", diffMode: true, originalContent: "快照前", content: "快照后" });
    hooks.effects[1]();
    resolveRead("过期磁盘内容");
    await Promise.resolve();
    const tree = render({ path: "src/a.ts" });
    expect(findDiff(tree)!.props.modified).toBe("快照后");
    expect(findEditor(tree)!.props.value).toBe("");
    hooks.effects[1]();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("普通内容加载成功后往返切换不重新读取或丢失修改", async () => {
    const read = vi.fn().mockResolvedValue("磁盘内容");
    vi.stubGlobal("window", { owncoder: { readWorkspaceFile: read } });
    render({ path: "src/a.ts" });
    const cancel = hooks.effects[1]() as () => void;
    await Promise.resolve();
    const normal = render({ path: "src/a.ts" });
    findEditor(normal)!.props.onChange("未保存修改");
    cancel();
    render({ path: "src/a.ts", diffMode: true, originalContent: "旧", content: "新" });
    hooks.effects[1]();
    render({ path: "src/a.ts" });
    hooks.effects[1]();
    expect(read).toHaveBeenCalledOnce();
    expect(findEditor(render({ path: "src/a.ts" }))!.props.value).toBe("未保存修改");
  });

  it("按请求定位到指定行", () => {
    const ed = {
      getModel: () => null,
      updateOptions: vi.fn(),
      layout: vi.fn(),
      focus: vi.fn(),
      addCommand: vi.fn(),
      setPosition: vi.fn(),
      revealLineInCenter: vi.fn(),
    };
    findEditor(render({ path: "src/a.ts", revealLine: { line: 81, requestId: 1 } }))!.props.onMount(ed);
    expect(ed.setPosition).toHaveBeenCalledWith({ lineNumber: 81, column: 1 });
    expect(ed.revealLineInCenter).toHaveBeenCalledWith(81);
  });

  it("页签显示后恢复布局和焦点，隐藏页签保持只读", () => {
    const ed = { getModel: () => null, updateOptions: vi.fn(), layout: vi.fn(), focus: vi.fn(), addCommand: vi.fn() };
    findEditor(render({ path: "src/a.ts", active: false }))!.props.onMount(ed);
    expect(ed.focus).not.toHaveBeenCalled();
    render({ path: "src/a.ts", active: true });
    hooks.effects.at(-1)!();
    expect(ed.layout).toHaveBeenCalledOnce();
    expect(ed.focus).toHaveBeenCalledOnce();
    render({ path: "src/a.ts", active: false });
    hooks.effects.at(-1)!();
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ readOnly: true });
  });

  it("不同页签使用独立 Diff URI 和快照", () => {
    const a = findDiff(render({ path: "a.ts", diffMode: true, originalContent: "A旧", content: "A新" }))!;
    hooks.refs = [];
    const b = findDiff(render({ path: "b.ts", diffMode: true, originalContent: "B旧", content: "B新" }))!;
    expect(a.props.originalModelPath).not.toBe(b.props.originalModelPath);
    expect(a.props.modified).toBe("A新");
    expect(b.props.modified).toBe("B新");
  });

  it("新增及删除文件保留合法的空快照", () => {
    const added = findDiff(render({ path: "new.ts", diffMode: true, originalContent: "", content: "新增" }))!;
    expect(added.props.original).toBe("");
    hooks.refs = [];
    const deleted = findDiff(render({ path: "old.ts", diffMode: true, originalContent: "删除", content: "" }))!;
    expect(deleted.props.modified).toBe("");
  });
});
