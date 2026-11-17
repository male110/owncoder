import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// ── React hooks mock（与 PlanCard.test.ts 同模式）──────────────────────────────
const hooks = vi.hoisted(() => {
  vi.stubGlobal("self", {});
  return {
    states: [] as unknown[],
    stateIndex: 0,
    refs: [] as Array<{ current: unknown }>,
    refIndex: 0,
  };
});
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (value: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = value;
    // 支持函数式更新：setExpanded((v) => !v)
    return [hooks.states[index], (next: unknown) => {
      hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next;
    }];
  },
  useRef: (value: unknown) => {
    const index = hooks.refIndex++;
    return hooks.refs[index] ??= { current: value };
  },
  useEffect: () => undefined,
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (text: string) => text }),
}));
vi.mock("./LiveToolCard", () => ({ LiveToolCard: "mock-live-tool-card" }));

// ── 被测组件 ──────────────────────────────────────────────────────────────────
import { SubagentGroupCard } from "./SubagentGroup";
import type { SubagentGroup } from "../../store/chat-store";

// ── 测试辅助 ──────────────────────────────────────────────────────────────────
type Element = ReactElement<Record<string, any>>;

function findElement(node: unknown, predicate: (el: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("type" in node)) return undefined;
  const el = node as Element;
  if (predicate(el)) return el;
  return findElement(el.props.children, predicate);
}

function findAllByClass(node: unknown, className: string): Element[] {
  const results: Element[] = [];
  function walk(n: unknown) {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== "object" || !("type" in n)) return;
    const el = n as Element;
    if (typeof el.props.className === "string" && el.props.className.includes(className)) {
      results.push(el);
    }
    walk(el.props.children);
  }
  walk(node);
  return results;
}

function makeGroup(overrides: Partial<SubagentGroup> = {}): SubagentGroup {
  return {
    id: "planner-1",
    agentType: "Planner",
    task: "plan the feature",
    tools: [],
    status: "done",
    ...overrides,
  };
}

/** 渲染卡片：open 状态由 hooks.states[0] 控制（SubagentGroupCardImpl 的第一个 useState）。 */
function renderCard(group: SubagentGroup, open = true) {
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
  hooks.refs = [];
  // 只重置卡片自身的 open/showAll（索引 0、1），保留 HeadPrompt/InputPreview 的展开状态（索引 2+）
  hooks.states[0] = open;
  hooks.states[1] = false;
  // memo() 包装后需取 .type 拿到底层组件函数
  return (SubagentGroupCard as any).type({ group });
}

/** 取第 n 个 InputPreview 渲染出的 pre 元素（n=0 用户任务，n=1 系统提示词）。 */
function inputPre(tree: unknown, index: number) {
  const rootChildren = (tree as Element).props.children as unknown[];
  const body = rootChildren.find(
    (c) => c && typeof c === "object" && "type" in (c as Element) &&
      typeof (c as Element).props.className === "string" &&
      (c as Element).props.className.includes("subagent-card-body"),
  ) as Element;
  const bodyChildren = body.props.children as unknown[];
  const report = bodyChildren.find(
    (c) => c && typeof c === "object" && "type" in (c as Element) &&
      typeof (c as Element).props.className === "string" &&
      (c as Element).props.className.includes("subagent-report"),
  ) as Element;
  const children = report.props.children as unknown[];
  const previews = children.filter(
    (c) => c && typeof c === "object" && "type" in (c as Element) &&
      typeof (c as Element).type === "function" &&
      (c as Element).type.name === "InputPreview",
  );
  // InputPreview 是组件元素（props 只有 text），需调用组件函数得到 <pre> 元素
  const preview = previews[index] as Element;
  return preview.type(preview.props) as Element;
}

/** 取分组条头部 HeadPrompt 渲染出的 span 元素（subagent-card-prompt）。 */
function headPromptSpan(tree: unknown): Element {
  const head = findAllByClass(tree, "subagent-card-head")[0];
  const children = head.props.children as unknown[];
  const comp = children.find(
    (c) => c && typeof c === "object" && "type" in (c as Element) &&
      typeof (c as Element).type === "function" &&
      (c as Element).type.name === "HeadPrompt",
  ) as Element;
  return comp.type(comp.props) as Element;
}

/** prompt 容器内并列的两个子元素：[文本 span, 「...」按钮或 null]。 */
function partsOf(span: Element) {
  const children = span.props.children as unknown[];
  const textSpan = children[0] as Element;
  return {
    text: textSpan.props.children as string,
    textClassName: textSpan.props.className as string,
    toggle: (children[1] ?? null) as Element | null,
  };
}

/** 一次渲染内取出 prompt 容器与其子元素，避免重复调用组件函数多消费一个 state。 */
function headPromptParts(tree: unknown) {
  return partsOf(headPromptSpan(tree));
}

describe("SubagentGroupCard Planner 输入预览", () => {
  beforeEach(() => {
    hooks.states = [];
    hooks.stateIndex = 0;
  });

  it("长输入默认截断为 200 字符并显示「...」按钮", () => {
    const long = "a".repeat(500);
    const tree = renderCard(makeGroup({
      input: { userMessage: long, systemPromptOverride: "sys", thoroughness: "medium" },
    }));
    const pre = inputPre(tree, 0);
    const children = pre.props.children as unknown[];
    expect(children[0]).toBe("a".repeat(200));
    const toggle = children[1] as Element;
    expect(toggle.props.className).toBe("subagent-input-toggle");
    expect(toggle.props.children).toBe("...");
  });

  it("短输入不截断、不显示「...」按钮", () => {
    const tree = renderCard(makeGroup({
      input: { userMessage: "短任务", systemPromptOverride: "sys", thoroughness: "medium" },
    }));
    const pre = inputPre(tree, 0);
    // pre 的 children 恒为数组 [shown, toggle|null]
    const children = pre.props.children as unknown[];
    expect(children[0]).toBe("短任务");
    expect(children[1]).toBeNull();
  });

  it("恰好 200 字符视为不超限，不出现「...」", () => {
    const tree = renderCard(makeGroup({
      input: { userMessage: "b".repeat(200), systemPromptOverride: "s", thoroughness: "low" },
    }));
    const pre = inputPre(tree, 0);
    const children = pre.props.children as unknown[];
    expect(children[0]).toBe("b".repeat(200));
    expect(children[1]).toBeNull();
  });

  it("点击「...」展开完整内容，再次点击收起", () => {
    const long = "x".repeat(300);
    const group = makeGroup({
      input: { userMessage: long, systemPromptOverride: "y".repeat(300), thoroughness: "medium" },
    });
    const tree = renderCard(group);
    const toggle = (inputPre(tree, 0).props.children as unknown[])[1] as Element;
    // renderCard 直接调用组件函数，JSX 里的 InputPreview 不会执行；
    // inputPre 首次调用 InputPreview 时 useState 位于索引 2
    toggle.props.onClick();
    expect(hooks.states[2]).toBe(true);
    const expanded = renderCard(group);
    const children = inputPre(expanded, 0).props.children as unknown[];
    expect(children[0]).toBe(long);
    expect((children[1] as Element).props.children).toBe("收起");
    (children[1] as Element).props.onClick();
    expect(hooks.states[2]).toBe(false);
  });

  it("空输入渲染空 pre，不出现「...」按钮", () => {
    const tree = renderCard(makeGroup({
      input: { userMessage: "", systemPromptOverride: "", thoroughness: "medium" },
    }));
    const pre = inputPre(tree, 0);
    const children = pre.props.children as unknown[];
    expect(children[0]).toBe("");
    expect(children[1]).toBeNull();
  });

  it("换行与 JSON 内容按原样保留在截断预览中", () => {
    const json = `{"a": 1,\n"b": "值"}\n` + "c".repeat(250);
    const tree = renderCard(makeGroup({
      input: { userMessage: json, systemPromptOverride: "s", thoroughness: "medium" },
    }));
    const children = inputPre(tree, 0).props.children as unknown[];
    expect(children[0]).toBe(json.slice(0, 200));
    expect((children[1] as Element).props.children).toBe("...");
  });

  it("点击分组条头部切换的是执行过程展开状态，而非输入内容", () => {
    const group = makeGroup({
      input: { userMessage: "task", systemPromptOverride: "sys", thoroughness: "medium" },
      report: "节点报告内容",
    });
    const tree = renderCard(group, false);
    // 收起状态：body（含输入与报告）不渲染
    expect(findAllByClass(tree, "subagent-card-body")).toHaveLength(0);
    const head = findAllByClass(tree, "subagent-card-head")[0];
    head.props.onClick();
    expect(hooks.states[0]).toBe(true);
    const openTree = renderCard(group, true);
    // 展开后 body 内同时包含输入预览与执行过程（节点报告）
    expect(findAllByClass(openTree, "subagent-card-body")).toHaveLength(1);
    expect(findAllByClass(openTree, "subagent-report").length).toBeGreaterThanOrEqual(2);
  });

  it("头部 prompt 超过 200 字符默认截断并显示「...」", () => {
    const long = "p".repeat(500);
    const tree = renderCard(makeGroup({ task: long }));
    const span = headPromptSpan(tree);
    expect(span.props.className).toBe("subagent-card-prompt");
    const parts = headPromptParts(tree);
    expect(parts.text).toBe("p".repeat(200));
    expect(parts.textClassName).toBe("subagent-card-prompt-text");
    expect(parts.toggle?.props.className).toBe("subagent-input-toggle");
    expect(parts.toggle?.props.children).toBe("...");
  });

  it("头部 prompt 短文本不截断、不显示「...」", () => {
    const tree = renderCard(makeGroup({ task: "短任务" }));
    const parts = headPromptParts(tree);
    expect(parts.text).toBe("短任务");
    expect(parts.toggle).toBeNull();
  });

  it("点击头部「...」展开完整 prompt，再次点击收起", () => {
    const long = "q".repeat(300);
    const group = makeGroup({ task: long });
    const tree = renderCard(group);
    const toggle = headPromptParts(tree).toggle as Element;
    // HeadPrompt 的 useState 位于卡片 open/showAll 之后：索引 2
    toggle.props.onClick({ stopPropagation: () => {} });
    expect(hooks.states[2]).toBe(true);
    const expandedTree = renderCard(group);
    const expandedSpan = headPromptSpan(expandedTree);
    const parts = partsOf(expandedSpan);
    expect(parts.text).toBe(long);
    expect(expandedSpan.props.className).toContain("expanded");
    expect(parts.toggle?.props.children).toBe("收起");
    parts.toggle?.props.onClick({ stopPropagation: () => {} });
    expect(hooks.states[2]).toBe(false);
  });

  it("头部容器不是 <button>，「...」是独立 button，点击「...」不改变 open", () => {
    const long = "s".repeat(300);
    const group = makeGroup({ task: long });
    const tree = renderCard(group, false);
    const head = findAllByClass(tree, "subagent-card-head")[0];
    // 头部改为 div[role=button]：button 内嵌 button 是非法结构，会把「...」的点击并入头部
    expect(head.type).toBe("div");
    expect(head.props.role).toBe("button");
    expect(head.props.tabIndex).toBe(0);
    const toggle = headPromptParts(tree).toggle as Element;
    expect(toggle.type).toBe("button");
    // 「...」不在头部点击处理链上：阻止冒泡后 open 保持收起
    let stopped = false;
    toggle.props.onClick({ stopPropagation: () => { stopped = true; } });
    expect(stopped).toBe(true);
    expect(hooks.states[0]).toBe(false);
    expect(hooks.states[2]).toBe(true);
    // 键盘回车作用于「...」时也不冒泡到头部容器
    let keyStopped = false;
    toggle.props.onKeyDown({ stopPropagation: () => { keyStopped = true; } });
    expect(keyStopped).toBe(true);
  });

  it("点击头部「...」不触发展开执行过程，点击头部不改变 prompt 展开态", () => {
    const long = "r".repeat(300);
    const group = makeGroup({ task: long });
    const tree = renderCard(group, false);
    const toggle = headPromptParts(tree).toggle as Element;
    // 模拟事件冒泡被阻止：stopPropagation 存在且可调用
    let stopped = false;
    const event = { stopPropagation: () => { stopped = true; } };
    toggle.props.onClick(event);
    expect(stopped).toBe(true);
    expect(hooks.states[2]).toBe(true);
    // 点击分组条头部：切换 open，不改变 prompt 展开态
    const head = findAllByClass(tree, "subagent-card-head")[0];
    head.props.onClick();
    expect(hooks.states[0]).toBe(true);
    expect(hooks.states[2]).toBe(true);
  });

  it("头部容器支持 Enter / Space 键盘切换执行过程展开态", () => {
    const group = makeGroup({ task: "task" });
    const tree = renderCard(group, false);
    const head = findAllByClass(tree, "subagent-card-head")[0];
    let prevented = false;
    head.props.onKeyDown({ key: "Enter", preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(hooks.states[0]).toBe(true);
    head.props.onKeyDown({ key: " ", preventDefault: () => { prevented = true; } });
    expect(hooks.states[0]).toBe(false);
    // 其他按键不触发切换
    head.props.onKeyDown({ key: "a", preventDefault: () => { prevented = true; } });
    expect(hooks.states[0]).toBe(false);
  });
});

