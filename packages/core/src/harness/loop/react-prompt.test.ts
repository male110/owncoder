/**
 * Execution prompt contract: keep the discipline short, explicit, and
 * evidence-first without reintroducing the old long routing essay.
 */
import { describe, expect, it } from "vitest";
import { formatCurrentTaskContext } from "./react-prompt.ts";
import type { TaskItem } from "../../plans.ts";

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: "n1",
    description: "修改示例文件",
    status: "in_progress",
    dependsOn: [],
    retryCount: 0,
    maxRetries: 2,
    ...overrides,
  };
}

describe("任务上下文：短硬执行纪律", () => {
  it("注入精准任务、证据复用和停止条件", () => {
    const text = formatCurrentTaskContext(makeTask({
      description: "请修改 packages/core/src/harness/loop/context.ts:46 的 freshReadGuidance",
    }));
    expect(text).toMatch(/Execution discipline \(mandatory\)/);
    expect(text).toMatch(/exact file\/range/i);
    expect(text).toMatch(/fresh evidence/i);
    expect(text).toMatch(/stop exploring/i);
  });

  it("仍携带任务字段（做什么），顺序为标题在前", () => {
    const task = makeTask({
      description: "修改示例文件",
      guidance: "只改这一处",
    });
    const text = formatCurrentTaskContext(task);
    expect(text).toMatch(/## \*\*Current Task/);
    expect(text).toMatch(/ID: n1/);
    expect(text).toMatch(/Description: 修改示例文件/);
    expect(text).toMatch(/Guidance: 只改这一处/);
    expect(text.indexOf("## **Current Task")).toBeLessThan(text.indexOf("Description: 修改示例文件"));
  });
});
