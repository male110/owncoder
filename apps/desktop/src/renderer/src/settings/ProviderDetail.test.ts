import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

/**
 * 组件以函数方式调用（同 AgentSidebar.test），useState/useRef 用按调用序号索引的
 * 槽位模拟真实状态，因此可以「改状态 → 重新 render」验证失焦保存后名称是否持久化。
 */
type Slot = [unknown, (v: unknown) => void];
const states: Slot[] = [];
let cursor = 0;
// useRef 槽位：跨 render 保持同一对象，模拟 editCommittedRef 的会话内防重复提交。
const refs: { current: unknown }[] = [];
let refCursor = 0;

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown): Slot => {
    const i = cursor++;
    if (!states[i]) {
      const value = typeof initial === "function" ? (initial as () => unknown)() : initial;
      states[i] = [value, () => {}];
    }
    const slot = states[i]!;
    slot[1] = (next: unknown) => {
      slot[0] = typeof next === "function" ? (next as (prev: unknown) => unknown)(slot[0]) : next;
    };
    return slot;
  },
  useRef: (initial: unknown) => {
    const i = refCursor++;
    if (!refs[i]) refs[i] = { current: initial };
    return refs[i];
  },
  useEffect: () => {},
  useCallback: (cb: unknown) => cb,
  useMemo: (fn: () => unknown) => fn(),
}));

vi.mock("../i18n", () => ({
  useI18n: () => ({ locale: "zh-CN", t: (id: string) => id }),
}));

import { ProviderDetail } from "./ProviderDetail";

// useState 调用序号：name…browseModels 之后依次是 editingId / editingName / copiedId。
const EDITING_ID = 11;
const EDITING_NAME = 12;
const COPIED_ID = 13;

interface Props {
  className?: string;
  title?: string;
  type?: string;
  children?: unknown;
  [key: string]: unknown;
}

function walk(value: unknown, visit: (node: ReactElement<Props>) => void): void {
  if (Array.isArray(value)) {
    value.forEach((v) => walk(v, visit));
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as ReactElement<Props>;
  visit(node);
  walk(node.props?.children, visit);
}

function byClass(tree: ReactElement, className: string): ReactElement<Props>[] {
  const out: ReactElement<Props>[] = [];
  walk(tree, (node) => {
    if (node.props?.className?.split(" ").includes(className)) out.push(node);
  });
  return out;
}

function byTitle(tree: ReactElement, title: string): ReactElement<Props> {
  const out: ReactElement<Props>[] = [];
  walk(tree, (node) => {
    if (node.props?.title === title) out.push(node);
  });
  expect(out).toHaveLength(1);
  return out[0]!;
}

/** 编辑态输入框（行内 .model-display-edit-input，与复选框同处 row-label）。 */
function editInput(tree: ReactElement): ReactElement<Props> {
  const out = byClass(tree, "model-display-edit-input");
  expect(out).toHaveLength(1);
  return out[0]!;
}

interface Draft {
  providers: { id: string; models: { id: string; name: string; displayName?: string }[] }[];
  selectedModels: { id: string; name: string; providerId: string; displayName?: string }[];
}

const MODEL_IDS = ["gpt-4o", "gpt-4o-mini"];

function setup(ids: string[] = ["gpt-4o"]) {
  const provider = {
    id: "p1",
    name: "P1",
    baseUrl: "https://api.example.com",
    apiKey: "k",
    apiFormat: "openai-chat",
    models: ids.map((id) => ({ id, name: id })),
  };
  const draft: Draft = {
    providers: [{ id: "p1", models: ids.map((id) => ({ id, name: id })) }],
    selectedModels: ids.map((id) => ({ id, name: id, providerId: "p1" })),
  };
  const patch = vi.fn((fn: (d: Draft) => void) => {
    const next = structuredClone(draft);
    fn(next);
    Object.assign(draft, next);
  });
  const render = () => {
    cursor = 0;
    refCursor = 0;
    return ProviderDetail({
      provider: provider as never,
      selectedModels: draft.selectedModels,
      patch: patch as never,
    });
  };
  /** 进入编辑态：置 editingId 后重新渲染，返回携带最新闭包的输入框。 */
  const enterEdit = (id = MODEL_IDS[0]!) => {
    render();
    states[EDITING_ID]![0] = id;
    return editInput(render());
  };
  /** 直接预置编辑态（需先渲染一次以建立状态槽位）。 */
  const prime = (id: string | null, name = "") => {
    render();
    states[EDITING_ID]![0] = id;
    states[EDITING_NAME]![0] = name;
  };
  const click = (node: ReactElement<Props>) => {
    (node.props.onClick as (e: unknown) => void)({ stopPropagation: vi.fn(), preventDefault: vi.fn() });
  };
  const fire = (handler: unknown, extra: Record<string, unknown> = {}) => {
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    (handler as (e: unknown) => void)({ stopPropagation, preventDefault, ...extra });
    return { stopPropagation, preventDefault };
  };
  return { draft, patch, render, enterEdit, prime, click, fire };
}

beforeEach(() => {
  states.length = 0;
  cursor = 0;
  refs.length = 0;
  refCursor = 0;
});

describe("已接入模型行内编辑展示名", () => {
  it("点击模型行进入编辑态并显示输入框，不触发删除", () => {
    const { draft, patch, render, click } = setup();

    click(byClass(render(), "model-detail-row")[0]!);

    expect(patch).not.toHaveBeenCalled();
    expect(draft.selectedModels).toHaveLength(1);
    expect(states[EDITING_ID]![0]).toBe("gpt-4o");

    const input = editInput(render());
    expect(input.props.value).toBe("gpt-4o");
    expect(input.props.placeholder).toBe("gpt-4o");
    expect(input.props.autoFocus).toBe(true);
  });

  it("无 display_name 时进入编辑态，输入框初值回退为模型 name", () => {
    const { draft, render, click } = setup();
    // 清除 displayName，确保走 name 回退路径。
    delete draft.selectedModels[0]!.displayName;

    click(byClass(render(), "model-detail-row")[0]!);

    expect(editInput(render()).props.value).toBe("gpt-4o");
  });

  it("已有展示名时进入编辑态，输入框初值为该展示名", () => {
    const { draft, render, click } = setup();
    draft.selectedModels[0]!.displayName = "我的模型";

    click(byClass(render(), "model-detail-row")[0]!);

    expect(editInput(render()).props.value).toBe("我的模型");
  });

  it("编辑态下再次点击同一行不重复进入编辑", () => {
    const { render, prime, click } = setup();
    prime("gpt-4o");
    const row = byClass(render(), "model-detail-row")[0]!;
    const setEditingId = vi.fn();
    states[EDITING_ID]![1] = setEditingId;

    click(row);

    expect(setEditingId).not.toHaveBeenCalled();
  });

  it("失焦保存展示名：仅写一次 patch、退出编辑态且重新渲染后名称保持", () => {
    const { draft, patch, render, enterEdit, fire } = setup();

    fire(enterEdit().props.onChange, { target: { value: "  我的模型  " } });
    // onChange 后组件重渲染，onBlur 闭包才会带上新值。
    fire(editInput(render()).props.onBlur);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(draft.selectedModels[0]!.displayName).toBe("我的模型");
    expect(draft.providers[0]!.models[0]!.displayName).toBe("我的模型");
    expect(states[EDITING_ID]![0]).toBeNull();
    expect(byClass(render(), "model-detail-row-name")[0]!.props.children).toBe("我的模型");
  });

  it("名称未变化时失焦不写入 patch，仅退出编辑态", () => {
    const { draft, patch, render, prime, fire } = setup();
    draft.selectedModels[0]!.displayName = "原名";
    prime("gpt-4o", "原名");

    fire(editInput(render()).props.onBlur);

    expect(patch).not.toHaveBeenCalled();
    expect(states[EDITING_ID]![0]).toBeNull();
  });

  it("清空后失焦按未设置展示名保存，界面回落显示模型标识", () => {
    const { draft, patch, render, enterEdit, fire } = setup();
    draft.selectedModels[0]!.displayName = "旧名";
    fire(enterEdit().props.onChange, { target: { value: "   " } });

    fire(editInput(render()).props.onBlur);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(draft.selectedModels[0]!.displayName).toBeUndefined();
    expect(byClass(render(), "model-detail-row-name")[0]!.props.children).toBe("gpt-4o");
  });

  it("输入框点击与 Ctrl 组合键不冒泡，避免触发行操作与搜索模式", () => {
    const { render, enterEdit, fire } = setup();
    const input = enterEdit();

    expect(fire(input.props.onClick).stopPropagation).toHaveBeenCalledOnce();
    expect(fire(editInput(render()).props.onKeyDown, { key: "f", ctrlKey: true }).stopPropagation)
      .toHaveBeenCalledOnce();
  });

  it("编辑态不渲染保存和取消按钮，仅保留名称旁的复制按钮", () => {
    const { render, enterEdit } = setup();
    enterEdit();

    const labels = byClass(render(), "model-detail-row-label");
    expect(labels).toHaveLength(1);
    const buttons: ReactElement<Props>[] = [];
    walk(labels[0]!, (node) => {
      if ((node as { type?: unknown }).type === "button") buttons.push(node);
    });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.props.className).toContain("model-copy-btn");
    expect(editInput(render()).props.className).toBe("model-display-edit-input");
  });

  it("编辑态保留左侧复选框，取消勾选仅移除模型、不进入编辑", () => {
    const { draft, render, enterEdit, fire } = setup();
    enterEdit();

    const label = byClass(render(), "model-detail-row-label")[0]!;
    const checkbox = (label.props.children as ReactElement<Props>[])[0]!;
    expect(checkbox.props.type).toBe("checkbox");
    expect(checkbox.props.checked).toBe(true);

    const { stopPropagation } = fire(checkbox.props.onClick);
    expect(stopPropagation).toHaveBeenCalledOnce();
    fire(checkbox.props.onChange, { target: { checked: false } });
    expect(draft.selectedModels).toHaveLength(0);
  });

  it("独立删除入口仍生效且点击不冒泡到行", () => {
    const { draft, render, fire } = setup();

    const { stopPropagation } = fire(byTitle(render(), "移除该模型").props.onClick);

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(draft.selectedModels).toHaveLength(0);
    expect(draft.providers[0]!.models).toHaveLength(0);
  });

  it("模型行右侧不再提供设置入口，点击行仍可进入展示名编辑", () => {
    const { draft, patch, render, fire, click } = setup();

    const actions = byClass(render(), "model-detail-row-actions")[0]!;
    const buttons: ReactElement<Props>[] = [];
    walk(actions, (node) => {
      if ((node as { type?: unknown }).type === "button") buttons.push(node);
    });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.props.className).toContain("danger");

    click(byClass(render(), "model-detail-row")[0]!);

    expect(patch).not.toHaveBeenCalled();
    expect(draft.selectedModels).toHaveLength(1);
    expect(states[EDITING_ID]![0]).toBe("gpt-4o");
  });

  it("勾选框点击阻止冒泡，避免误入编辑态", () => {
    const { render, fire } = setup();
    const checkbox = (byClass(render(), "model-detail-row-label")[0]!.props
      .children as ReactElement<Props>[])[0]!;

    const { stopPropagation } = fire(checkbox.props.onClick);

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(states[EDITING_ID]![0]).toBeNull();
  });

  it("编辑中点击另一行：blur 唯一落盘上一行，切换本身不再提交", () => {
    const { draft, patch, render, enterEdit, fire, click } = setup(MODEL_IDS);
    fire(enterEdit("gpt-4o").props.onChange, { target: { value: "切换前名称" } });
    // 真实 DOM 中点击其他行会先触发输入框 blur，这是唯一提交路径。
    fire(editInput(render()).props.onBlur);
    expect(patch).toHaveBeenCalledTimes(1);

    click(byClass(render(), "model-detail-row")[1]!);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(draft.selectedModels[0]!.displayName).toBe("切换前名称");
    expect(states[EDITING_ID]![0]).toBe("gpt-4o-mini");
    expect(editInput(render()).props.value).toBe("gpt-4o-mini");
  });

  it("同一次编辑重复失焦只提交一次", () => {
    const { draft, patch, render, enterEdit, fire } = setup();
    fire(enterEdit().props.onChange, { target: { value: "新名" } });
    const input = editInput(render());

    fire(input.props.onBlur);
    fire(input.props.onBlur);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(draft.selectedModels[0]!.displayName).toBe("新名");
  });

  it("未改动回退初值（name）时失焦不写入 patch", () => {
    const { patch, render, prime, fire } = setup();
    prime("gpt-4o", "gpt-4o");

    fire(editInput(render()).props.onBlur);

    expect(patch).not.toHaveBeenCalled();
    expect(states[EDITING_ID]![0]).toBeNull();
  });

  it("Enter/Escape 不提交也不取消，仅失焦保存", () => {
    const { patch, render, enterEdit, fire } = setup();
    fire(enterEdit().props.onChange, { target: { value: "键盘名" } });
    const input = editInput(render());

    fire(input.props.onKeyDown, { key: "Enter" });
    fire(input.props.onKeyDown, { key: "Escape" });

    expect(patch).not.toHaveBeenCalled();
    expect(states[EDITING_ID]![0]).toBe("gpt-4o");

    fire(editInput(render()).props.onBlur);
    expect(patch).toHaveBeenCalledTimes(1);
  });
});

describe("模型 name 复制按钮", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("有展示名时复制按钮紧跟原始 name 之后，点击复制 name 而非展示名且不进入编辑态", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { draft, patch, render, fire } = setup();
    draft.selectedModels[0]!.displayName = "我的模型";

    // 行内顺序：复选框 → 展示名 → 原始 name → 复制按钮（按钮贴在 name 后，不是展示名后）。
    const children = byClass(render(), "model-detail-row-label")[0]!.props
      .children as ReactElement<Props>[];
    expect(children[1]!.props.className).toBe("model-detail-row-name");
    expect(children[1]!.props.children).toBe("我的模型");
    expect(children[2]!.props.className).toBe("model-detail-row-id");
    expect(children[2]!.props.children).toBe("gpt-4o");
    expect(children[3]!.props.className).toContain("model-copy-btn");

    const { stopPropagation } = fire(byTitle(render(), "复制模型名称").props.onClick);
    await Promise.resolve();

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("gpt-4o");
    expect(patch).not.toHaveBeenCalled();
    expect(states[EDITING_ID]![0]).toBeNull();
  });

  it("未设展示名时不重复渲染 name，复制按钮直接跟在名称后", () => {
    const { render } = setup();

    // 无展示名时次要 name 槽位为 null，过滤后仅剩：复选框 → 名称 → 复制按钮。
    const children = (
      byClass(render(), "model-detail-row-label")[0]!.props.children as (ReactElement<Props> | null)[]
    ).filter(Boolean) as ReactElement<Props>[];
    expect(children).toHaveLength(3);
    expect(children[1]!.props.className).toBe("model-detail-row-name");
    expect(children[1]!.props.children).toBe("gpt-4o");
    expect(children[2]!.props.className).toContain("model-copy-btn");
  });

  it("复制成功后按钮显示 ✓，1.5 秒后恢复；重复点击重置计时", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { render, fire } = setup();

    fire(byTitle(render(), "复制模型名称").props.onClick);
    await vi.advanceTimersByTimeAsync(0);

    expect(states[COPIED_ID]![0]).toBe("gpt-4o");
    const copied = byTitle(render(), "已复制");
    expect(copied.props.children).toBe("✓");
    expect(copied.props.className).toContain("copied");

    // 1 秒后再次点击：旧定时器被清除，反馈从新点击起重新计 1.5 秒。
    await vi.advanceTimersByTimeAsync(1000);
    fire(byTitle(render(), "已复制").props.onClick);
    await vi.advanceTimersByTimeAsync(1000);
    expect(states[COPIED_ID]![0]).toBe("gpt-4o");

    await vi.advanceTimersByTimeAsync(500);
    expect(states[COPIED_ID]![0]).toBeNull();
    expect(byTitle(render(), "复制模型名称").props.className).not.toContain("copied");
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("剪贴板写入失败时静默忽略，不显示已复制反馈", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("clipboard denied");
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { render, fire } = setup();

    fire(byTitle(render(), "复制模型名称").props.onClick);
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledOnce();
    expect(states[COPIED_ID]![0]).toBeNull();
  });

  it("多行各自复制自己的 name，✓ 反馈只落在被点击的行", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { render, fire } = setup(MODEL_IDS);

    const buttons = byClass(render(), "model-copy-btn");
    expect(buttons).toHaveLength(2);
    fire(buttons[1]!.props.onClick);
    await vi.advanceTimersByTimeAsync(0);

    expect(writeText).toHaveBeenCalledExactlyOnceWith("gpt-4o-mini");
    const after = byClass(render(), "model-copy-btn");
    expect(after[0]!.props.className).not.toContain("copied");
    expect(after[1]!.props.className).toContain("copied");
    expect(after[1]!.props.children).toBe("✓");
  });
});
