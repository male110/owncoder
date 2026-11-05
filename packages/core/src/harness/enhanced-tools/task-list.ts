import type { ToolDef } from "@owncoder/llm";

const ADD_TASK_ITEM = {
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
} as const;

const UPDATE_TASK_ITEM = {
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
      "Modify existing tasks in the active task list by id. Only the provided fields change. Use it when task descriptions, constraints, dependencies, status, or acceptance criteria change.",
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
