import type { ToolDef } from "@owncoder/llm";

const ADD_TASK_ITEM = {
  type: "object",
  properties: {
    id: { type: "string", description: "Optional unique id, e.g. t5. Auto-assigned when omitted." },
    title: { type: "string", description: "Short display title." },
    executionGuidance: {
      type: "string",
      description:
        "Execution guidance — instruct the assignee how to carry out this task (key entry points, pitfalls, how to verify). Required.",
    },
    kind: { type: "string", enum: ["implementation", "verification"] },
    dependsOn: { type: "array", items: { type: "string" }, description: "Task ids that must reach a terminal state first." },
  },
  required: ["executionGuidance"],
} as const;

const UPDATE_TASK_ITEM = {
  type: "object",
  properties: {
    id: { type: "string", description: "Task id to update." },
    title: { type: "string" },
    executionGuidance: {
      type: "string",
      description: "Execution guidance — instruct the assignee how to carry out this task.",
    },
    kind: { type: "string", enum: ["implementation", "verification"] },
    dependsOn: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["pending", "in_progress", "completed", "failed", "skipped"] },
    acceptance: { type: "string" },
  },
  required: ["id"],
} as const;

export const ADD_TASKS_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: false,
  function: {
    name: "add_tasks",
    description:
      "Append new tasks to the active task list. Use it only when the requested worklist is genuinely incomplete; do not add exploratory side quests.",
    parameters: {
      type: "object",
      properties: {
        add: {
          type: "array",
          description: "New tasks to append. id is optional (auto-assigned as t{n} when omitted).",
          items: ADD_TASK_ITEM,
        },
      },
      required: ["add"],
    },
  },
};

export const UPDATE_TASKS_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: false,
  function: {
    name: "update_tasks",
    description:
      "Modify existing tasks in the active task list by id. Only the provided fields change. Use it when task execution guidance, constraints, dependencies, status, or acceptance criteria change.",
    parameters: {
      type: "object",
      properties: {
        update: {
          type: "array",
          description: "Existing tasks to modify (matched by id). Only the provided fields change.",
          items: UPDATE_TASK_ITEM,
        },
      },
      required: ["update"],
    },
  },
};
