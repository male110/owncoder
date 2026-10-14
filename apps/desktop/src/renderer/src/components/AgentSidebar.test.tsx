import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

import { AgentSidebar } from "./AgentSidebar";

function find(element: ReactElement, className: string): ReactElement[] {
  const matches: ReactElement[] = [];
  const visit = (value: unknown): void => {
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
