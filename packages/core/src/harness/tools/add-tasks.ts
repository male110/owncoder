/**
 * add_tasks 工具 handler。
 *
 * 本层只把 LLM 的松散 JSON 整形成新增操作；任务内容与依赖的语义校验
 * 由 plans.ts 的 applyTaskListOps 统一承担，并保持批量操作的原子性。
 */
import type { TaskListAddOp, TaskListOps } from "../../plans.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { fail, ok } from "./shared.ts";

function normalizeAdds(raw: unknown): TaskListAddOp[] | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>).add;
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value.filter(
    (item): item is TaskListAddOp => !!item && typeof item === "object" && !Array.isArray(item),
  );
}

export async function toolAddTasks(ctx: ToolContext, rawArgs: unknown): Promise<ToolResult> {
  const adds = normalizeAdds(rawArgs);
  if (!adds) {
    return fail(
      "add_tasks 参数错误：需要对象，字段 add 必须为数组。例：{\"add\":[{\"description\":\"…\"}]}。",
    );
  }
  if (!ctx.updateTasks) {
    return fail(
      "add_tasks 不可用：本轮没有活动任务清单（task_decompose 未产出任务，或不在任务驱动的 agent 回合）。" +
        "任务清单在分解产出 ≥1 个任务后激活；简单回合无需清单，直接完成即可。",
    );
  }
  const outcome = await ctx.updateTasks({ add: adds } satisfies TaskListOps);
  if (!outcome.ok) return fail(outcome.error);
  return ok(outcome.summary);
}
