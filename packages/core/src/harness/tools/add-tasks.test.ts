import { describe, expect, it } from "vitest";
import { toolAddTasks } from "./add-tasks.ts";
import type { ToolContext } from "./types.ts";
import type { TaskListOps } from "../../plans.ts";

function makeCtx(updateTasks?: ToolContext["updateTasks"]): ToolContext {
  return {
    workspaceRoot: "/tmp/ws",
    mode: "agent",
    workflow: {} as never,
    index: {} as never,
    readSet: new Set(),
    maxOutputChars: 100_000,
    bashMaxChars: 10_000,
    updateTasks,
  };
}

describe("toolAddTasks", () => {
  it("未注入闭包 → 明确指引失败", async () => {
    const result = await toolAddTasks(makeCtx(), { add: [{ description: "x" }] });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("没有活动任务清单");
  });

  it("形状错误（add 非数组）→ 参数错误", async () => {
    const ctx = makeCtx(async () => ({ ok: true, summary: "should not be called" }));
    const result = await toolAddTasks(ctx, { add: "not-an-array" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("参数错误");
  });

  it("只转发 add，闭包成功时透传 summary", async () => {
    const ctx = makeCtx(async (ops: TaskListOps) => {
      expect(ops).toEqual({ add: [{ description: "新任务" }] });
      return { ok: true, summary: "added t2.\\nCurrent task list:\\n- [pending] t2: 新任务" };
    });
    const result = await toolAddTasks(ctx, { add: [{ description: "新任务" }] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("added t2");
  });

  it("闭包校验失败 → fail 带业务错误", async () => {
    const ctx = makeCtx(async () => ({ ok: false as const, error: "add 任务失败：description 必填。" }));
    const result = await toolAddTasks(ctx, { add: [{ description: "" }] });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("description");
  });
});
