import type { ToolDef } from "@owncoder/llm";

// ── Experience harvest ────────────────────────────────────

export const SAVE_EXPERIENCE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "save_experience",
    description:
      "Persist a reusable engineering experience (symptom → root cause → fix) to .owncoder/experiences/ and index it for future retrieval. Use after solving a non-trivial problem so the lesson can be retrieved later.",
    parameters: {
      type: "object",
      properties: {
        symptom: { type: "string", description: "What went wrong / the observable symptom" },
        rootCause: { type: "string", description: "Why it happened — the underlying cause" },
        fix: { type: "string", description: "What change resolved it" },
        files: { type: "array", items: { type: "string" }, description: "Files involved" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags: typecheck/test/lint/build/runtime/general",
        },
      },
      required: ["symptom", "rootCause", "fix"],
    },
  },
};
