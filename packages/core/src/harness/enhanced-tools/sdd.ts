import type { ToolDef } from "@owncoder/llm";

// ── SDD tools ─────────────────────────────────────────────

export const SAVE_SPEC_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "save_spec",
    description:
      "Save a spec document (WHAT to build) to .owncoder/sdd/<feature>/spec.md. Creates the feature dir if needed. Use first in the spec→design→tasks chain.",
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Feature name (slugified for dir)" },
        content: { type: "string", description: "Spec markdown: problem, requirements, constraints, acceptance criteria" },
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
      "Save a design document (HOW to build) to .owncoder/sdd/<feature>/design.md. Seeds a skeleton on first creation. Use after save_spec.",
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Feature name" },
        content: { type: "string", description: "Design markdown: approach, components, data/interfaces, trade-offs" },
      },
      required: ["feature", "content"],
    },
  },
};

export const LIST_SDD_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: true,
  function: {
    name: "list_sdd",
    description:
      "List SDD features and their phase status (spec/design/tasks readiness + task progress). Pass a feature name to get detailed status for one feature.",
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Optional: single feature name for detailed status" },
      },
    },
  },
};
