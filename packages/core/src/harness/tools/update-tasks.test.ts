/**
 * update_tasks handler 单元测试。
 *
 * 锁住的语义：
 * - 未注入闭包（非任务驱动回合 / Explore 子代理）→ 明确指引失败
 * - 形状错误（非数组字段）→ 参数错误
 * - 闭包成功 → ok 且 summary 透传
 * - 闭包校验失败 → fail 带 applyTaskListOps 的 error
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
  it("未注入闭包 → 明确指引失败（不是静默成功）", async () => {
    const result = await toolUpdateTasks(makeCtx(), { add: [{ description: "x" }] });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("没有活动任务清单");
  });

  it("形状错误（add 非数组）→ 参数错误", async () => {
    const ctx = makeCtx(async () => ({ ok: true, summary: "should not be called" }));
    const result = await toolUpdateTasks(ctx, { add: "not-an-array" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("参数错误");
  });

  it("null/非对象入参 → 参数错误", async () => {
    const ctx = makeCtx(async () => ({ ok: true, summary: "x" }));
    expect((await toolUpdateTasks(ctx, null)).ok).toBe(false);
    expect((await toolUpdateTasks(ctx, "t1")).ok).toBe(false);
  });

  it("闭包成功 → ok 且 summary 透传", async () => {
    const ctx = makeCtx(async (ops: TaskListOps) => {
      expect(ops.add).toHaveLength(1);
      return { ok: true, summary: "added t2.\nCurrent task list:\n- [pending] t2: 新任务" };
    });
    const result = await toolUpdateTasks(ctx, { add: [{ description: "新任务" }] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("added t2");
  });

  it("闭包校验失败 → fail 带 applyTaskListOps 的 error", async () => {
    const ctx = makeCtx(async () => ({
      ok: false as const,
      error: 'update 任务失败：id "ghost" 不存在。',
    }));
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
      add: [{ description: "ok" }, "garbage", null, 42],
    } as unknown as TaskListOps);
    expect(result.ok).toBe(true);
    expect(seen?.add).toHaveLength(1);
    expect(seen?.add?.[0]!.description).toBe("ok");
  });
});
