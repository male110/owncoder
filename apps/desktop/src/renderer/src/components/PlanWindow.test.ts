import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const hooks = vi.hoisted(() => ({ states: [] as unknown[], index: 0, effects: [] as Array<() => void | (() => void)> }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: unknown) => { hooks.states[index] = next; }];
  },
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
  useCallback: (callback: unknown) => callback,
}));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (value: string) => value }) }));
import { PlanWindow } from "./PlanWindow";
import { Markdown } from "./Markdown";

type Element = ReactElement<{ children?: unknown; className?: string; content?: string; onClick?: () => void; disabled?: boolean }>;
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("type" in value)) return [];
  const element = value as Element;
  return [element, ...nodes(element.props.children)];
}
function render() { hooks.index = 0; hooks.effects = []; return nodes(PlanWindow()); }
const plan = { path: "plans/launch.md", title: "发布计划", kind: "plan" as const, sessionId: "s1", size: 10, mtimeMs: 0 };
const content = "# 标题\n\n- 步骤\n\n```ts\nconst x = 1;\n```\n\n[文档](https://example.com)";

beforeEach(() => {
  hooks.states = []; hooks.index = 0; hooks.effects = [];
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), owncoder: {
    getPlanWindowData: vi.fn(async () => ({ plan, content, approved: false })),
    approvePlanInWindow: vi.fn(async () => undefined),
  } });
});

describe("PlanWindow", () => {
  it("refreshes authoritative approval status on focus and cleans up on close", async () => {
    render();
    const cleanup = hooks.effects[0]!();
    const focus = vi.mocked(window.addEventListener).mock.calls[0]![1] as () => void;
    focus();
    await vi.waitFor(() => expect(window.owncoder.getPlanWindowData).toHaveBeenCalledTimes(2));
    if (typeof cleanup === "function") cleanup();
    expect(window.removeEventListener).toHaveBeenCalledWith("focus", focus);
  });

  it("renders the full Markdown by default instead of a masked pre preview", async () => {
    render(); await hooks.effects[0]!();
    const elements = render();
    const markdown = elements.find((element) => element.type === Markdown);
    expect(markdown?.props.content).toBe(content);
    expect(elements.some((element) => element.type === "article")).toBe(true);
    expect(elements.some((element) => element.type === "pre" || element.props.className?.includes("masked"))).toBe(false);
    expect(elements.find((element) => element.type === "h1")?.props.children).toBe("发布计划");
  });

  it("approves via the main-window workflow then refreshes server state", async () => {
    render(); await hooks.effects[0]!();
    const button = render().find((element) => element.type === "button")!;
    button.props.onClick!();
    await vi.waitFor(() => expect(window.owncoder.approvePlanInWindow).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(window.owncoder.getPlanWindowData).toHaveBeenCalledTimes(2));
  });

  it("prevents repeat approval clicks while the first request is pending", async () => {
    hooks.states[0] = { plan, content, approved: false };
    let finish!: () => void;
    vi.mocked(window.owncoder.approvePlanInWindow).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    render().find((element) => element.type === "button")!.props.onClick!();
    const button = render().find((element) => element.type === "button")!;
    expect(button.props.disabled).toBe(true);
    button.props.onClick!();
    expect(window.owncoder.approvePlanInWindow).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(() => expect(window.owncoder.getPlanWindowData).toHaveBeenCalledOnce());
  });

  it("does not approve documents or previously approved plans", async () => {
    hooks.states[0] = { plan: { ...plan, kind: "document" }, content, approved: false };
    expect(render().some((element) => element.type === "button")).toBe(false);
    hooks.states[0] = { plan, content, approved: true };
    expect(render().some((element) => element.type === "button")).toBe(false);
  });

  it("shows load and approval failures without claiming success", async () => {
    vi.mocked(window.owncoder.getPlanWindowData).mockRejectedValueOnce(new Error("read failed"));
    render(); await hooks.effects[0]!();
    expect(render().find((element) => element.props.className === "plan-window-error")?.props.children).toBe("read failed");
    hooks.states[0] = { plan, content, approved: false };
    vi.mocked(window.owncoder.approvePlanInWindow).mockRejectedValueOnce(new Error("approve failed"));
    render().find((element) => element.type === "button")!.props.onClick!();
    await vi.waitFor(() => expect(render().find((element) => element.props.className === "plan-window-error")?.props.children).toBe("approve failed"));
    expect((hooks.states[0] as { approved: boolean }).approved).toBe(false);
  });
});
