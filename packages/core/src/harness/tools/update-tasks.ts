/**
 * update_tasks 工具 handler。
 *
 * 参数整形与业务校验分离：本层只把 LLM 的松散 JSON 整形成 TaskListOps
 * （非数组字段拒绝、非对象条目滤掉），语义校验（id 冲突、依赖悬空、
 * 成环、状态合法）全部由 plans.ts 的 applyTaskListOps 纯函数承担——
 * 顺序路径与任务图路径的闭包复用同一份校验，不会漂移。
 */
import type { TaskListOps, TaskListAddOp, TaskListUpdateOp, TaskListRemoveOp } from "../../plans.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { fail, ok } from "./shared.ts";

/** 把松散入参整形为 TaskListOps；形状错误返回 null。 */
function normalizeOps(raw: unknown): TaskListOps | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const ops: TaskListOps = {};
  for (const key of ["add", "update", "remove"] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return null;
    const items = value.filter(
      (item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item),
    );
    // 条目内容的语义校验（必填字段/id 存在性/状态合法）全部由
    // applyTaskListOps 承担，这里只做形状整形。
    const typed = items as unknown[];
    if (key === "add") ops.add = typed as TaskListAddOp[];
    else if (key === "update") ops.update = typed as TaskListUpdateOp[];
    else ops.remove = typed as TaskListRemoveOp[];
  }
  return ops;
}

export async function toolUpdateTasks(ctx: ToolContext, rawOps: unknown): Promise<ToolResult> {
  const ops = normalizeOps(rawOps);
  if (!ops) {
    return fail(
      "update_tasks 参数错误：需要对象，可选字段 add / update / remove，均为数组。" +
        '例：{"add":[{"description":"…"}],"update":[{"id":"t1","status":"completed"}]}。',
    );
  }
  if (!ctx.updateTasks) {
    return fail(
      "update_tasks 不可用：本轮没有活动任务清单（task_decompose 未产出任务，或不在任务驱动的 agent 回合）。" +
        "任务清单在分解产出 ≥1 个任务后激活；简单回合无需清单，直接完成即可。",
    );
  }
  const outcome = await ctx.updateTasks(ops);
  if (!outcome.ok) return fail(outcome.error);
  return ok(outcome.summary);
}
