import type { ToolDef } from "@owncoder/llm";

// ── Spec workflow tools (Kiro-style spec → design → tasks) ─

export const SAVE_SPEC_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "save_spec",
    description:
      "Save the requirements spec (WHAT to build) to .owncoder/specs/<feature>/spec.md and PAUSE for the user's approval. " +
      "Use first in the spec → design → tasks chain. Do not write design.md or tasks.md in the same turn.",
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Feature name (slugified for dir)" },
        content: {
          type: "string",
          description:
            "Spec markdown: problem statement, requirements in EARS format (WHEN <trigger> THE SYSTEM SHALL <response>), user stories, acceptance criteria",
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
            "Design markdown: context, goals & non-goals, data models, API, components, error handling, testing",
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
            "Tasks markdown: numbered checkbox list, ordered by dependency, each task with verification steps",
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
