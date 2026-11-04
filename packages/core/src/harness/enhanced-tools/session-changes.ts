import type { ToolDef } from "@owncoder/llm";

// ── Session pending changes ───────────────────────────────

export const LIST_SESSION_CHANGES_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: true,
  function: {
    name: "list_session_changes",
    description:
      "List pending session file changes from the current turn checkpoint (same list as the UI Changes bar). " +
      "Use before undo_session_change to confirm target paths. Read-only.",
    parameters: { type: "object", properties: {} },
  },
};

export const UNDO_SESSION_CHANGE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "undo_session_change",
    description:
      "Undo ONE pending session file change by restoring it from the turn checkpoint " +
      "(same as the UI Changes bar single-file Undo). Pass exactly one workspace-relative path. " +
      "To undo multiple files, call this tool once per path. " +
      "Do NOT use write_file/apply_patch to fake an undo. There is no multi-path batch undo.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Single workspace-relative file path from list_session_changes / the Changes bar.",
        },
      },
      required: ["file_path"],
    },
  },
};
