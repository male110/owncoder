import type { ToolDef } from "@owncoder/llm";

// ── Semantic Diff Tool ────────────────────────────────────

export const SEMANTIC_DIFF_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: true,
  function: {
    name: "semantic_diff",
    description:
      "Show a structured diff of changes made to a file with semantic analysis. " +
      "Highlights added/removed symbols, changed signatures, and potential breaking changes. " +
      "More informative than raw git diff for understanding code changes.",
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Relative file path to show diff for",
        },
        against: {
          type: "string",
          description: "Base to diff against (default: HEAD)",
        },
      },
      required: ["filePath"],
    },
  },
};

// ── Verification Tool ─────────────────────────────────────

export const TYPE_CHECK_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "type_check",
    description:
      "Run the project's type checker to verify code correctness. " +
      "Detects type errors, missing imports, and other compile-time issues.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

// ── Bug-fix analysis tool ─────────────────────────────────

export const ANALYZE_ISSUE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "analyze_issue",
    description:
      "Run a bug-fix analysis: parse the issue → reproduce via verification → localize root-cause candidates. Returns a structured plan (symptom, failing checks, likely files, strategy) to guide apply_patch. Use only for non-trivial bugs whose fix site is unknown; skip it when you already know where to patch.",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "The issue/bug description: symptom, expected behavior, reproduction steps, files, errors",
        },
      },
      required: ["description"],
    },
  },
};
