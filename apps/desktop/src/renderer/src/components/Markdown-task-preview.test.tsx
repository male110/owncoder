import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  memo: (component: unknown) => component,
  useMemo: (factory: () => unknown) => factory(),
}));

import { Markdown } from "./Markdown";
import type { ActivePlanMetaDto, SpecTaskDocumentDto, TaskItemDto } from "../../../preload/index";

type Element = ReactElement<{ children?: unknown; className?: string; disabled?: boolean; onClick?: () => void; "aria-current"?: boolean }>;
function renderMarkdown(props: Parameters<typeof Markdown>[0]): Element[] {
  const element = Markdown(props);
  const render = element.type as (props: typeof element.props) => unknown;
  return nodes(render(element.props));
}
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("type" in value)) return [];
  const element = value as Element;
  return [element, ...nodes(element.props.children)];
}

const meta: ActivePlanMetaDto = {
  path: ".owncoder/specs/login/tasks.md",
  approvedAt: "2026-01-01T00:00:00.000Z",
  title: "登录任务",
  tasks: [
    { id: "task_1", executionGuidance: "实现登录", status: "completed", dependsOn: [], retryCount: 0, maxRetries: 2 },
    { id: "task_2", executionGuidance: "添加校验", status: "in_progress", dependsOn: ["task_1"], retryCount: 0, maxRetries: 2 },
    { id: "task_3", executionGuidance: "补充测试", status: "pending", dependsOn: ["task_2"], retryCount: 0, maxRetries: 2 },
  ],
  currentTaskId: "task_2",
};
const content = "# Tasks\n\n- [ ] 实现登录\n- [ ] 添加校验\n- [ ] 补充测试";
const contentWithFallback = `${content}\n- [ ] 备用任务`;
const specContent = [
  "", "# Tasks", "", "- [ ] Not in the DTO", "1. Not a checkbox", "- [ ]no space",
  "~~~md", "- [ ] Fenced example", "~~~", "> - [ ] Quoted example", "  * [x] First",
  "  2、 [ ] Second", "3) [ ] Third", "4. [ ] Fourth", "",
].join("\r\n");
const specTask = (id: string, sourceLine: number, status: TaskItemDto["status"], dependsOn: string[] = []): TaskItemDto => ({
  id, sourceLine, status, dependsOn, executionGuidance: id, retryCount: 0, maxRetries: 2,
});
const specDocument: SpecTaskDocumentDto = {
  path: ".owncoder/specs/sessions/scope/login/tasks.md", version: "version", sourceDigest: "source", approvedAt: meta.approvedAt,
  currentTaskId: "second",
  tasks: [specTask("fourth", 14, "failed", ["first"]), specTask("second", 12, "pending", ["first"]),
    specTask("first", 11, "completed"), specTask("third", 13, "pending", ["second"]),
    specTask("not-checkbox", 5, "completed"), specTask("bad-spacing", 6, "completed"),
    specTask("fenced", 8, "completed"), specTask("quoted", 10, "completed")],
};
const buttons = (elements: Element[], name: string) => elements.filter((element) => element.type === "button" && element.props.children === name);

describe("Markdown tasks preview", () => {
  it("renders inline task progress and maps live statuses to checkbox tasks", () => {
    const elements = renderMarkdown({ content, taskMeta: meta, onExecuteTasks: vi.fn() });
    expect(elements.find((element) => element.props.className === "md-task-progress")?.props.children).toBeTruthy();
    expect(elements.filter((element) => element.props.className?.includes("md-task-item--"))).toHaveLength(3);
    expect(elements.some((element) => element.props.className?.includes("md-task-item--in_progress"))).toBe(true);
    expect(elements.filter((element) => element.props.className?.split(" ").includes("md-task-item"))).toHaveLength(3);
  });

  it("disables execution while unsaved and leaves ordinary Markdown without task controls", () => {
    const dirty = renderMarkdown({ content, taskMeta: meta, tasksDirty: true, onExecuteTasks: vi.fn() });
    const execute = dirty.find((element) => element.type === "button" && element.props.children === "开始执行");
    expect(execute?.props.disabled).toBe(true);
    expect(dirty.some((element) => element.props.className === "md-task-unsaved")).toBe(true);

    const ordinary = renderMarkdown({ content });
    expect(ordinary.some((element) => element.props.className === "md-task-progress")).toBe(false);
    expect(ordinary.some((element) => element.props.className?.startsWith("md-task-status--"))).toBe(false);
  });

  it("wires skip and reset actions to the matching task id", () => {
    const onUpdateTask = vi.fn();
    const extended: ActivePlanMetaDto = {
      ...meta,
      tasks: [
        ...meta.tasks,
        { id: "task_4", executionGuidance: "备用任务", status: "failed", dependsOn: [], retryCount: 0, maxRetries: 2 },
      ],
    };
    const elements = renderMarkdown({ content: contentWithFallback, taskMeta: extended, onUpdateTask });
    const skip = elements.find((element) => element.type === "button" && element.props.children === "跳过");
    const reset = elements.find((element) => element.type === "button" && element.props.children === "重置");
    skip?.props.onClick?.();
    reset?.props.onClick?.();
    expect(onUpdateTask).toHaveBeenNthCalledWith(1, "task_3", "skipped");
    expect(onUpdateTask).toHaveBeenNthCalledWith(2, "task_4", "pending");
  });
});

describe("Spec task documents", () => {
  it.each([null, specDocument.approvedAt])("offers batch and row execution without an approval step (approvedAt=%s)", (approvedAt) => {
    const onExecuteSpecTasks = vi.fn();
    const onUpdateTask = vi.fn();
    const document = { ...specDocument, approvedAt };
    const result = renderMarkdown({ content: specContent, specTaskDocument: document, onExecuteSpecTasks, onUpdateTask });
    expect(result.filter((node) => node.props.className?.startsWith("md-task-status md-task-status--")).map((node) => node.props.children))
      .toEqual(["已完成", "待执行", "待执行", "失败"]);
    expect(result.filter((node) => node.props["aria-current"])).toHaveLength(1);
    expect(result.filter((node) => node.type === "button").map((node) => node.props.children))
      .toEqual(approvedAt ? ["全部执行", "执行", "跳过", "执行", "跳过", "执行", "重置"] : ["全部执行", "执行", "执行", "执行"]);
    const [runSecond, runThird, runFourth] = buttons(result, "执行");
    expect([runSecond, runThird, runFourth].map((button) => button?.props.disabled)).toEqual([false, true, false]);
    expect(result.some((node) => node.props.children === "待审批" || node.props.children === "已批准")).toBe(false);

    const progress = result.find((node) => node.props.className === "md-task-progress");
    const [batch] = buttons(nodes(progress), "全部执行");
    const [skip] = buttons(result, "跳过");
    const [reset] = buttons(result, "重置");
    expect(batch?.props.disabled).toBe(false);
    expect(onExecuteSpecTasks).not.toHaveBeenCalled();
    runSecond?.props.onClick?.();
    runFourth?.props.onClick?.();
    batch?.props.onClick?.();
    expect(onExecuteSpecTasks.mock.calls).toEqual([[document, "second"], [document, "fourth"], [document]]);
    if (approvedAt) {
      expect(skip?.props.disabled).toBe(false);
      expect(reset?.props.disabled).toBe(false);
      skip?.props.onClick?.();
      reset?.props.onClick?.();
      expect(onUpdateTask.mock.calls).toEqual([["second", "skipped", document], ["fourth", "pending", document]]);
    } else {
      expect(skip).toBeUndefined();
      expect(reset).toBeUndefined();
    }
  });

  it("blocks batch start for dirty, stale, busy, or running tasks and without a handler", () => {
    const document = { ...specDocument, approvedAt: null };
    const props = { content: specContent, specTaskDocument: document, onExecuteSpecTasks: vi.fn(), onUpdateTask: vi.fn() };
    for (const disabled of [{ tasksDirty: true }, { specTasksStale: true }, { taskBusy: true }, { onExecuteSpecTasks: undefined }, {
      specTaskDocument: { ...document, tasks: [...document.tasks, specTask("running", 4, "in_progress")] },
    }]) {
      expect(buttons(renderMarkdown({ ...props, ...disabled }), "全部执行")[0]?.props.disabled).toBe(true);
    }
    const busy = renderMarkdown({ ...props, specTaskDocument: specDocument, taskBusy: true });
    for (const name of ["执行", "跳过", "重置"]) {
      const controls = buttons(busy, name);
      expect(controls.length).toBeGreaterThan(0);
      expect(controls.every((button) => button.props.disabled)).toBe(true);
    }
  });

  it("uses live statuses and current task only for matching document metadata", () => {
    const document = {
      ...specDocument,
      tasks: [specTask("second", 12, "pending", ["first"]), specTask("first", 11, "failed", ["missing"])],
    };
    const taskMeta: ActivePlanMetaDto = {
      ...meta, path: document.path, documentDigest: document.version, currentTaskId: null,
      tasks: [specTask("first", 1, "completed")],
    };
    const props = { content: specContent, specTaskDocument: document, onExecuteSpecTasks: vi.fn() };
    const live = renderMarkdown({ ...props, taskMeta });
    expect(buttons(live, "全部执行")[0]?.props.disabled).toBe(false);
    expect(live.some((node) => node.props["aria-current"])).toBe(false);
    for (const mismatched of [{ path: "other.md" }, { documentDigest: "old" }, { approvedAt: "old" }]) {
      const result = renderMarkdown({ ...props, taskMeta: { ...taskMeta, ...mismatched } });
      expect(buttons(result, "全部执行")[0]?.props.disabled).toBe(true);
      expect(result.some((node) => node.props["aria-current"])).toBe(true);
    }
  });

  it("renders live execution and terminal states on the persisted Spec markers", () => {
    const document = {
      ...specDocument,
      tasks: [specTask("second", 12, "partial"), specTask("fourth", 14, "failed")],
    };
    const taskMeta: ActivePlanMetaDto = {
      ...meta, path: document.path, documentDigest: document.version, currentTaskId: "second",
      tasks: [specTask("second", 12, "in_progress"), specTask("fourth", 14, "failed")],
    };
    const persisted = specContent.replace("[ ] Second", "[/] Second").replace("[ ] Fourth", "[-] Fourth");
    const props = { content: persisted, specTaskDocument: document, onExecuteSpecTasks: vi.fn() };
    const live = renderMarkdown({ ...props, taskMeta });
    expect(live.find((node) => node.props["aria-current"])?.props.className).toContain("md-task-item--in_progress");
    const statuses = (result: Element[]) => result.filter((node) => node.props.className?.startsWith("md-task-status "))
      .map((node) => node.props.children);
    expect(statuses(live)).toEqual(["执行中", "失败"]);
    expect(statuses(renderMarkdown(props))).toEqual(["部分完成", "失败"]);
  });

  it("offers manual batch relaunch when a failed task is the only eligible task", () => {
    const onExecuteSpecTasks = vi.fn();
    const document = {
      ...specDocument, approvedAt: null,
      tasks: [specTask("first", 11, "skipped"), specTask("fourth", 14, "failed", ["first"])],
    };
    const result = renderMarkdown({ content: specContent, specTaskDocument: document, onExecuteSpecTasks });
    expect(onExecuteSpecTasks).not.toHaveBeenCalled();
    const [batch] = buttons(result, "全部执行");
    expect(batch?.props.disabled).toBe(false);
    batch?.props.onClick?.();
    expect(onExecuteSpecTasks).toHaveBeenCalledExactlyOnceWith(document);
  });

  it("blocks batch start when no rendered pending or failed task has satisfied dependencies", () => {
    const props = { content: specContent, onExecuteSpecTasks: vi.fn() };
    for (const tasks of [
      [specTask("second", 12, "pending", ["missing"])],
      [specTask("first", 11, "pending", ["fourth"]), specTask("fourth", 14, "failed", ["first"])],
      [specTask("fenced", 8, "pending")],
      [specTask("first", 11, "completed"), specTask("fourth", 14, "skipped")],
    ]) {
      const result = renderMarkdown({ ...props, specTaskDocument: { ...specDocument, tasks } });
      expect(buttons(result, "全部执行")[0]?.props.disabled).toBe(true);
    }
  });

  it("leaves ordinary Markdown list text unchanged", () => {
    const result = renderMarkdown({ content: "- [x] Ordinary\n1. [ ] Checklist" });
    expect(result.filter((node) => node.type === "li").map((node) => node.props.children)).toEqual([["[x] Ordinary"], ["[ ] Checklist"]]);
    expect(result.some((node) => node.props.className?.includes("md-task"))).toBe(false);
  });
});
