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

export const ADD_TASKS_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: false,
  function: {
    name: "add_tasks",
    description:
      "Append new tasks to the active task list. The task list is append-only: existing tasks cannot be edited, replaced, or removed — when execution shows the plan is missing work, extending it is the only option.\n\nUse it only when execution has proved the worklist is genuinely incomplete — i.e. a concrete, independently verifiable deliverable is missing and no existing task covers it. Do not add exploratory side quests, and never add a task whose purpose is to redo or bypass a task that has already failed; a failed task is a terminal state, and retrying it as a new task is not allowed.\n\nEach added task must be self-contained, bounded, and own a write scope disjoint from every other task's files.",
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

