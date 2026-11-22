import type { ToolDef } from "@owncoder/llm";

// ── Spec workflow tools (Kiro-style spec → design → tasks) ─

export const SAVE_SPEC_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "save_spec",
    description:
      "Save the requirements document (WHAT to build) to docs/<feature>-requirement.md and PAUSE for review. The user can ask to continue or request a revision in their own words. " +
      "Use first in the spec → design → tasks chain. Do not write design.md or tasks.md in the same turn.",
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Feature name (slugified for dir)" },
        content: {
          type: "string",
          description:
            "Requirements markdown ONLY: goals, scope, user stories, requirements with optional R1/FR1 identifiers (EARS format is recommended, not required), acceptance criteria, constraints. " +
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
      "Save the technical design (HOW to build) to docs/<feature>-design.md and PAUSE so the user can read it. Continue when the user asks to proceed; no separate approval is needed. " +
      "Use when the user asks to continue from the requirements or requests a revision to the current design.",
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Feature name" },
        content: {
          type: "string",
          description:
            "Save a concrete implementation design, not just options: use the verified existing stack when applicable, or recommend one stack with reasons and assumptions for a new project without a prescribed stack. " +
            "Explain module boundaries, key flows, interfaces, data models, error handling, implementation order and verification. " +
            "Include all remaining implementation-relevant open questions in this same document (假设与待确认), with their impact, proposed defaults if any, and when confirmation is needed. Do not leave them only in research notes or chat, and do not treat unanswered questions as decisions. " +
            "Organize the document with Markdown headings or another clear structure. It must contain a concrete technical design covering architecture and module boundaries, key flows, interfaces, data models, error handling, implementation order, and verification; equivalent Chinese or English headings are acceptable, and do not omit these details even if the document uses a different section layout. If the requirements define R/FR identifiers, trace each in the design (unknown or missing references are rejected).",
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
      "Save the implementation task list to the session-private .owncoder/specs/.../tasks.md and PAUSE for review. Execution starts only through the 执行 or 全部执行 buttons in the preview. " +
      "Draft it after the user has asked to continue from the design review. Numbered markdown checkboxes; each task references the design.",
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Feature name" },
        content: {
          type: "string",
          description:
            "Kiro-style tasks markdown: checkbox list (\"- [ ]\" or \"N. [ ]\"), ordered by dependency. " +
            "Each task must include: 依赖: (dependencies), 文件: (files/modules), 实现: (implementation requirements), 验收: (verification), 需求: R…/FR… (requirement references). " +
            "Use the recommended design as the baseline. For an unresolved decision with no reasonable default, list a clarification task rather than scheduling the dependent implementation. " +
            "Tasks must cover every requirement traced in the design; unknown references are rejected.",
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
      "List spec features and their phase status (requirements, design, task list, and execution progress). " +
      "Pass a feature name to get detailed status for one feature.",
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Optional: single feature name for detailed status" },
      },
    },
  },
};
