import type { ToolDef } from "@owncoder/llm";

// ── Spec workflow tools (Kiro-style spec → design → tasks) ─

export const SAVE_SPEC_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "save_spec",
    description:
      "Save the requirements document (WHAT to build) to .owncoder/specs/<feature>/spec.md and PAUSE for the user's approval. " +
      "Use first in the spec → design → tasks chain. Do not write design.md or tasks.md in the same turn.",
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Feature name (slugified for dir)" },
        content: {
          type: "string",
          description:
            "Requirements markdown ONLY: goals, scope, user stories, numbered requirements (R1, R2, … in EARS format: WHEN <trigger> THE SYSTEM SHALL <response>), acceptance criteria, constraints. " +
            "NO technical design — architecture, interfaces, data models, file layouts and task lists belong in design.md/tasks.md and will be rejected",
        },
      },
      required: ["feature", "content"],
    },
  },
};

export const SAVE_DESIGN_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "save_design",
    description:
      "Save the technical design (HOW to build) to .owncoder/specs/<feature>/design.md and PAUSE for the user's approval. " +
      "Only use AFTER the user approved the spec; otherwise wait.",
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Feature name" },
        content: {
          type: "string",
          description:
            "Design markdown: context, goals & non-goals, architecture, components, interfaces, data models, flows, error handling, testing strategy, " +
            "PLUS a requirements traceability matrix that references and covers every R number from the approved spec (unknown or missing R references are rejected)",
        },
      },
      required: ["feature", "content"],
    },
  },
};

export const SAVE_TASKS_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "save_tasks",
    description:
      "Save the implementation task list to .owncoder/specs/<feature>/tasks.md and PAUSE for the user's approval. " +
      "Only use AFTER the user approved the design. Numbered markdown checkboxes; each task references the design.",
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Feature name" },
        content: {
          type: "string",
          description:
            "Kiro-style tasks markdown: checkbox list (\"- [ ]\" or \"N. [ ]\"), ordered by dependency. " +
            "Each task must include: 依赖: (dependencies), 文件: (files/modules), 实现: (implementation requirements), 验收: (verification), 需求: R… (requirement references). " +
            "Tasks must cover every requirement traced in the approved design; unknown R references are rejected",
        },
      },
      required: ["feature", "content"],
    },
  },
};

export const LIST_SPECS_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: true,
  function: {
    name: "list_specs",
    description:
      "List spec features and their phase status (spec/design/tasks readiness, approval gate, task progress). " +
      "Pass a feature name to get detailed status for one feature.",
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Optional: single feature name for detailed status" },
      },
    },
  },
};
