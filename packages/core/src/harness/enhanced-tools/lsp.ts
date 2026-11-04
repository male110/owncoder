import type { ToolDef } from "@owncoder/llm";

// ── LSP Integration Tool ──────────────────────────────────

/**
 * LSP tool definitions for the agent.
 * These tools enable precise code navigation and understanding.
 */
export const LSP_TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    readOnly: true,
    function: {
      name: "lsp_diagnostics",
      description:
        "Get all diagnostic errors/warnings for files. Returns type errors, lint issues, " +
        "and other problems detected by the language server.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Optional: specific file path" },
        },
      },
    },
  },
];
