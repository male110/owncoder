import type { ToolDef } from "@owncoder/llm";

// ── 动态任务清单 ────────────────────────────────────────────────────────────

/**
 * update_tasks —— 执行过程中可随时增删改的动态任务清单。
 *
 * 任务分解（task_decompose）产出的是初始清单；本工具让模型在执行中把它
 * 当活清单用：增删改都走机制层（plans.ts applyTaskListOps 校验 + 原子应用），
 * 不是提示词级别的"建议"。任务图路径下清单由调度器持有，更新对新任务
 * 立即可见（readyTasks 下一轮自然派发）。
 */
export const UPDATE_TASKS_TOOL_DEF: ToolDef = {
  type: "function",
  // 状态变更工具：重置连续只读计数（它本身就是探索→管理动作的转换信号）。
  readOnly: false,
  function: {
    name: "update_tasks",
    description:
      "Update the sequential task list for this turn: add tasks, modify descriptions/constraints/dependencies/status, or remove pending tasks. " +
      "Use it only when the requested worklist is genuinely incomplete or its order/status changed; do not add exploratory side quests. " +
      "Keep each task scoped to the user's request and mark it completed only after the requested result is verified.",
    parameters: {
      type: "object",
      properties: {
        add: {
          type: "array",
          description: "New tasks to append. id is optional (auto-assigned as t{n} when omitted).",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Optional unique id, e.g. t5. Auto-assigned when omitted." },
              title: { type: "string", description: "Short display title." },
              description: { type: "string", description: "The deliverable — what completing this task means." },
              prompt: { type: "string", description: "Constraint or acceptance note only; do not include search, reading, navigation, or verification steps." },
              kind: { type: "string", enum: ["implementation", "verification"] },
              dependsOn: { type: "array", items: { type: "string" }, description: "Task ids that must reach a terminal state first." },
            },
            required: ["description"],
          },
        },
        update: {
          type: "array",
          description: "Existing tasks to modify (matched by id). Only the provided fields change.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Task id to update." },
              title: { type: "string" },
              description: { type: "string" },
              prompt: { type: "string", description: "Constraint or acceptance note only; do not include search, reading, navigation, or verification steps." },
              kind: { type: "string", enum: ["implementation", "verification"] },
              dependsOn: { type: "array", items: { type: "string" } },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "failed", "skipped"] },
              acceptance: { type: "string" },
            },
            required: ["id"],
          },
        },
        remove: {
          type: "array",
          description: "Task ids to remove. in_progress tasks are rejected until the current sequential step finishes.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Task id to remove." },
            },
            required: ["id"],
          },
        },
      },
    },
  },
};
