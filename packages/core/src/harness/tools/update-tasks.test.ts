/**
 * update_tasks handler 单元测试。
 *
 * 锁住修改操作的参数整形、闭包转发、错误处理和结果透传。
 */
import { describe, expect, it } from "vitest";
import { toolUpdateTasks } from "./update-tasks.ts";
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

describe("toolUpdateTasks", () => {
  it("未注入闭包 → 明确指引失败", async () => {
    const result = await toolUpdateTasks(makeCtx(), { update: [{ id: "t1", status: "completed" }] });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("没有活动任务清单");
  });

  it("形状错误（update 非数组）→ 参数错误", async () => {
    const ctx = makeCtx(async () => ({ ok: true, summary: "should not be called" }));
    const result = await toolUpdateTasks(ctx, { update: "not-an-array" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("参数错误");
  });

  it("null/非对象入参 → 参数错误", async () => {
    const ctx = makeCtx(async () => ({ ok: true, summary: "x" }));
    expect((await toolUpdateTasks(ctx, null)).ok).toBe(false);
    expect((await toolUpdateTasks(ctx, "t1")).ok).toBe(false);
  });

  it("只转发 update，闭包成功时透传 summary", async () => {
    const ctx = makeCtx(async (ops: TaskListOps) => {
      expect(ops).toEqual({ update: [{ id: "t1", status: "completed" }] });
      return { ok: true, summary: "updated t1.\\nCurrent task list:\\n- [completed] t1: task" };
    });
    const result = await toolUpdateTasks(ctx, { update: [{ id: "t1", status: "completed" }] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("updated t1");
  });

  it("闭包校验失败 → fail 带业务错误", async () => {
    const ctx = makeCtx(async () => ({ ok: false as const, error: 'update 任务失败：id "ghost" 不存在。' }));
    const result = await toolUpdateTasks(ctx, { update: [{ id: "ghost", status: "completed" }] });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("ghost");
  });

  it("非对象条目被滤掉，剩余合法条目仍整形通过", async () => {
    let seen: TaskListOps | undefined;
    const ctx = makeCtx(async (ops: TaskListOps) => {
      seen = ops;
      return { ok: true, summary: "ok" };
    });
    const result = await toolUpdateTasks(ctx, {
      update: [{ id: "t1", status: "completed" }, "garbage", null, 42],
    });
    expect(result.ok).toBe(true);
    expect(seen?.update).toHaveLength(1);
    expect(seen?.update?.[0]!.id).toBe("t1");
  });
});
