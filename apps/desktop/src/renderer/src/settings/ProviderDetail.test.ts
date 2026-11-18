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
import { ModelBrowserModal } from "./ModelBrowserModal";

// useState 调用序号：name…modelSearchQuery 之后依次是 editingId / editingName / copiedId。
const EDITING_ID = 10;
const EDITING_NAME = 11;
const COPIED_ID = 12;
// 弹窗数据源 browseModels 追加在 catalogNotice（13 号槽位）之后。
const BROWSE_MODELS = 14;

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

function setup(
  ids: string[] = ["gpt-4o"],
  overrides: {
    baseUrl?: string;
    apiKey?: string;
    models?: { id: string; name: string; displayName?: string }[];
    selectedModels?: { id: string; name: string; providerId: string; displayName?: string }[];
    autoOpenCatalog?: boolean;
  } = {},
) {
  const models = overrides.models ?? ids.map((id) => ({ id, name: id }));
  const provider = {
    id: "p1",
    name: "P1",
    baseUrl: overrides.baseUrl ?? "https://api.example.com",
    apiKey: overrides.apiKey ?? "k",
    apiFormat: "openai-chat",
    models,
  };
  const draft: Draft = {
    providers: [{ id: "p1", models }],
    selectedModels: overrides.selectedModels ?? ids.map((id) => ({ id, name: id, providerId: "p1" })),
  };
  const patch = vi.fn((fn: (d: Draft) => void) => {
    const next = structuredClone(draft);
    fn(next);
    Object.assign(draft, next);
  });
  const render = () => {
    cursor = 0;
    refCursor = 0;
    // 模拟真实链路：patch 写入配置后父组件以最新 provider 重新传参。
    provider.models = draft.providers[0]!.models;
    return ProviderDetail({
      provider: provider as never,
      selectedModels: draft.selectedModels,
      patch: patch as never,
      autoOpenCatalog: overrides.autoOpenCatalog ?? false,
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

    // 分组渲染下改名后的模型（无拉丁字母系列词）排入空系列组末尾，
    // 「另一行」（gpt-4o-mini）在前，点击第一行完成切换。
    click(byClass(render(), "model-detail-row")[0]!);

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

describe("获取所有模型弹窗", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));
  const fetchButton = (tree: ReactElement) => byClass(tree, "primary")[0]!;

  function stubFetch(
    impl: (...args: unknown[]) => Promise<{ ok: boolean; models?: unknown[]; error?: string }>,
  ) {
    const fetchModelList = vi.fn(impl);
    vi.stubGlobal("window", { owncoder: { fetchModelList } });
    return fetchModelList;
  }

  /** 弹窗渲染为独立组件元素；fake React 不展开子组件，按 type 定位元素。 */
  function modalOf(tree: ReactElement): ReactElement<Props> | null {
    let el: ReactElement<Props> | null = null;
    walk(tree, (node) => {
      if ((node as { type?: unknown }).type === ModelBrowserModal) el = node;
    });
    return el;
  }

  /** 手动调用弹窗组件函数，得到弹窗内部元素树（分组列表、添加按钮等）。 */
  function modalTree(tree: ReactElement): ReactElement {
    const el = modalOf(tree);
    expect(el).not.toBeNull();
    return ModelBrowserModal((el as ReactElement<Props>).props as never) as ReactElement;
  }

  /** 弹窗内某个模型条目（按展示名定位，避免依赖分组排序）。 */
  function itemByName(body: ReactElement, name: string): ReactElement<Props> {
    const hit = byClass(body, "model-browser-item").find((li) => {
      const names = byClass(li, "model-browser-item-name");
      return names.length === 1 && names[0]!.props.children === name;
    });
    expect(hit).toBeTruthy();
    return hit!;
  }

  it("点击「获取所有模型」拉取成功后打开弹窗，关闭后可再次点击重新拉取打开", async () => {
    const fetchModelList = stubFetch(async () => ({
      ok: true,
      models: [{ id: "o3", name: "o3" }],
    }));
    const { render, fire } = setup([]);

    fire(fetchButton(render()).props.onClick);
    await flush();

    let tree = render();
    expect(fetchModelList).toHaveBeenCalledOnce();
    expect(modalOf(tree)).not.toBeNull();

    // 关闭弹窗后页面回到常态。
    (modalOf(tree)!.props.onClose as () => void)();
    tree = render();
    expect(modalOf(tree)).toBeNull();

    // 再次点击「获取所有模型」重新拉取并重开弹窗。
    fire(fetchButton(tree).props.onClick);
    await flush();
    tree = render();
    expect(modalOf(tree)).not.toBeNull();
    expect(fetchModelList).toHaveBeenCalledTimes(2);
  });

  it("autoOpenCatalog（「获取并添加」完成）：挂载即展示目录弹窗，无需再次点击", async () => {
    const fetchModelList = vi.fn();
    vi.stubGlobal("window", { owncoder: { fetchModelList } });
    const { render } = setup([], {
      autoOpenCatalog: true,
      models: [{ id: "o3", name: "o3", displayName: "O3 旗舰" }],
    });

    const tree = render();
    // 「获取并添加」已在表单里拉取过：详情挂载直接展示目录，不再发起请求。
    expect(modalOf(tree)).not.toBeNull();
    expect(fetchModelList).not.toHaveBeenCalled();

    // 弹窗内容来自 provider.models 目录（含自定义展示名）。
    const body = modalTree(tree);
    expect(byClass(body, "model-browser-item")).toHaveLength(1);
    expect(byClass(body, "model-browser-item-name")[0]!.props.children).toBe("O3 旗舰");
  });

  it("autoOpenCatalog 但目录为空：不弹空弹窗", () => {
    vi.stubGlobal("window", { owncoder: { fetchModelList: vi.fn() } });
    const { render } = setup([], { autoOpenCatalog: true, models: [] });

    expect(modalOf(render())).toBeNull();
  });

  it("默认（非「获取并添加」进入）：挂载不自动弹窗", () => {
    vi.stubGlobal("window", { owncoder: { fetchModelList: vi.fn() } });
    const { render } = setup([], { models: [{ id: "o3", name: "o3" }] });

    expect(modalOf(render())).toBeNull();
  });

  it("弹窗成功展示平台目录：展示名、补显原始 name 与逐条添加状态", async () => {
    stubFetch(async () => ({
      ok: true,
      models: [
        { id: "model_p1_gpt4o", name: "gpt-4o", display_name: "GPT-4o 最佳" },
        { id: "o3", name: "o3" },
      ],
    }));
    const { draft, render, fire } = setup([]);

    fire(fetchButton(render()).props.onClick);
    await flush();

    const tree = render();
    expect(draft.providers[0]!.models.map((m) => m.id)).toEqual(["model_p1_gpt4o", "o3"]);
    const body = modalTree(tree);
    expect(byClass(body, "model-browser-item")).toHaveLength(2);

    const custom = itemByName(body, "GPT-4o 最佳");
    // 有自定义展示名时补显原始 name（请求标识），其后是模型 id。
    expect(byClass(custom, "model-browser-item-id").map((n) => n.props.children)).toEqual([
      "gpt-4o",
      "model_p1_gpt4o",
    ]);
    const plain = itemByName(body, "o3");
    expect(byClass(plain, "model-browser-item-id").map((n) => n.props.children)).toEqual(["o3"]);

    const addBtn = byClass(plain, "model-browser-add")[0]!;
    expect(addBtn.props.title).toBe("添加到已接入列表");
    expect(addBtn.props.disabled).toBe(false);

    (addBtn.props.onClick as () => void)();

    expect(draft.selectedModels).toEqual([{ id: "o3", name: "o3", providerId: "p1" }]);
    const after = byClass(itemByName(modalTree(render()), "o3"), "model-browser-add")[0]!;
    expect(after.props.disabled).toBe(true);
    expect(after.props.title).toBe("已添加");
    expect(after.props.children).toBe("✓");
  });

  it("获取成功但目录为空时给出明确提示而非空白", async () => {
    stubFetch(async () => ({ ok: true, models: [] }));
    const { render, fire } = setup([]);

    fire(fetchButton(render()).props.onClick);
    await flush();

    const tree = render();
    const hints = byClass(tree, "hint").map((n) => n.props.children);
    expect(hints).toContain("模型目录为空");
    expect(modalOf(tree)).toBeNull();
  });

  it("接口报错时展示可见错误且按钮恢复可用，重试成功后打开弹窗", async () => {
    const fetchModelList = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "HTTP 401: unauthorized" })
      .mockResolvedValueOnce({ ok: true, models: [{ id: "m1", name: "m1" }] });
    vi.stubGlobal("window", { owncoder: { fetchModelList } });
    const { render, fire } = setup([]);

    fire(fetchButton(render()).props.onClick);
    await flush();

    let tree = render();
    expect(byClass(tree, "error-text")[0]!.props.children).toBe("HTTP 401: unauthorized");
    expect(fetchButton(tree).props.disabled).toBe(false);
    expect(modalOf(tree)).toBeNull();

    fire(fetchButton(tree).props.onClick);
    await flush();

    tree = render();
    expect(fetchModelList).toHaveBeenCalledTimes(2);
    expect(byClass(modalTree(tree), "model-browser-item")).toHaveLength(1);
  });

  it("加载中重复点击只发起一次请求，完成后恢复可用", async () => {
    const fetchModelList = stubFetch(async () => ({ ok: true, models: [{ id: "m1", name: "m1" }] }));
    const { render, fire } = setup([]);
    const btn = fetchButton(render());

    fire(btn.props.onClick);
    fire(btn.props.onClick);
    await flush();

    expect(fetchModelList).toHaveBeenCalledOnce();
    const tree = render();
    expect(fetchButton(tree).props.disabled).toBe(false);
    expect(modalOf(tree)).not.toBeNull();
  });

  it("缺少服务地址且缺少密钥时点击给出可见错误而不是无响应", async () => {
    const fetchModelList = stubFetch(async () => ({ ok: true, models: [] }));

    const { render, fire } = setup([], { baseUrl: "", apiKey: "" });
    expect(fetchButton(render()).props.disabled).toBe(false);
    fire(fetchButton(render()).props.onClick);

    expect(byClass(render(), "error-text")[0]!.props.children).toBe(
      "请先填写服务地址（Base URL）和 API Key",
    );
    expect(fetchModelList).not.toHaveBeenCalled();
  });

  it("仅缺少服务地址时点击提示补填 Base URL", async () => {
    const fetchModelList = stubFetch(async () => ({ ok: true, models: [] }));

    const { render, fire } = setup([], { baseUrl: "", apiKey: "k" });
    fire(fetchButton(render()).props.onClick);

    expect(byClass(render(), "error-text")[0]!.props.children).toBe(
      "请先填写服务地址（Base URL）",
    );
    expect(fetchModelList).not.toHaveBeenCalled();
  });

  it("弹窗内添加不覆盖已有同名模型配置（含自定义展示名）", () => {
    const { draft, render } = setup([], {
      models: [{ id: "gpt-4o", name: "gpt-4o" }],
      selectedModels: [{ id: "legacy-1", name: "gpt-4o", providerId: "p1", displayName: "我的模型" }],
    });
    render();
    // 直接预置弹窗数据源（「获取所有模型」打开的即这份目录数据）。
    states[BROWSE_MODELS]![0] = [{ id: "gpt-4o", name: "gpt-4o" }];

    const addBtn = byClass(modalTree(render()), "model-browser-add")[0]!;
    expect(addBtn.props.disabled).toBe(true);
    expect(addBtn.props.title).toBe("已添加");

    // 即使直接调用处理器，防重判据也应阻止覆盖既有条目。
    (addBtn.props.onClick as () => void)();

    expect(draft.selectedModels).toHaveLength(1);
    expect(draft.selectedModels[0]!.id).toBe("legacy-1");
    expect(draft.selectedModels[0]!.displayName).toBe("我的模型");
  });
});
