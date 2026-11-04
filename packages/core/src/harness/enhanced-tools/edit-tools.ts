import type { ToolDef } from "@owncoder/llm";

// ── Parameter builders ────────────────────────────────────

const writeFileParams = () => ({
  type: "object" as const,
  properties: {
    file_path: { type: "string", description: "Relative to workspace root, or an absolute path to edit that exact file (including outside the workspace)" },
    content: {
      type: "string",
      description:
        "Complete file content. " +
        "WARNING: Content >50KB causes 'file_path field was lost' error. " +
        "For large files: Use write_file for first part (<50KB), then append_file for rest."
    },
    allow_shrink: {
      type: "boolean",
      description:
        "Set true only to confirm an intentional large shrink of an existing file. " +
        "Writing content under 50% of the current file size is rejected without this, " +
        "since write_file replaces the whole file and that usually means truncated content. " +
        "The file must also have been read first — this flag cannot confirm deleting content you have not seen. " +
        "Prefer apply_patch for partial edits.",
    },
  },
  required: ["file_path", "content"] as string[],
});

const appendFileParams = () => ({
  type: "object" as const,
  properties: {
    file_path: { type: "string", description: "Relative to workspace root, or an absolute path to edit that exact file (including outside the workspace)" },
    content: {
      type: "string",
      description:
        "Content to append to end of file. Each call adds this text to the file's end. " +
        "Keep each append <50KB to avoid JSON payload issues."
    },
  },
  required: ["file_path", "content"] as string[],
});
const applyPatchParams = () => ({
  type: "object" as const,
  properties: {
    file_path: { type: "string", description: "Required. Relative paths are resolved against the workspace root; an absolute path edits that exact file (may be outside the workspace). The target always comes from this parameter." },
    old_string: {
      type: "string",
      description:
        "The exact text in the file to replace. Must match the file content exactly (including indentation and whitespace) and be unique in the file; " +
        "if it is not unique, add more surrounding context to make it unique, or set replace_all=true. read_file first, then copy the exact text.",
    },
    new_string: {
      type: "string",
      description:
        "The new text replacing old_string. An empty string deletes old_string. Line-ending style follows the target file automatically.",
    },
    replace_all: {
      type: "boolean",
      description: "When true, replace every occurrence of old_string (default false, which requires old_string to be unique).",
    },
    patch: {
      type: "string",
      description:
        "Legacy format (kept for compatibility only): SEARCH/REPLACE blocks or a single-file unified diff.\n\n" +
        "Prefer old_string / new_string instead — more reliable, no marker syntax to remember.\n\n" +
        "SEARCH/REPLACE example:\n" +
        "```\n" +
        "<<<<<<< SEARCH\n" +
        "old text\n" +
        "=======\n" +
        "new text\n" +
        ">>>>>>> REPLACE\n" +
        "```\n" +
        "- SEARCH must match the text, indentation, and whitespace exactly as shown by read_file; LF and CRLF line endings are treated as equivalent\n" +
        "- Multiple blocks may be included in one patch, all applying to the same file\n" +
        "- Multi-file patches, renames, and the Assistant *** Begin Patch format are not supported; split them into separate calls",
    },
  },
  required: ["file_path"] as string[],
});
const bashParams = () => ({
  type: "object" as const,
  properties: {
    command: {
      type: "string",
      description:
        "Shell command to execute in the current terminal. On Windows, the default terminal is the system-provided PowerShell (`powershell.exe`); use PowerShell syntax. Must be non-empty.",
    },
  },
  required: ["command"] as string[],
});

// ── Spec-mode file tools ──────────────────────────────────

export const PLAN_WRITE_FILE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "write_file",
    description: "Create new file or replace entire file. For edits use apply_patch. For large files: write_file first part, then append_file rest.",
    parameters: writeFileParams(),
  },
};

export const PLAN_APPEND_FILE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "append_file",
    description: "Append content to end of existing file. Use after write_file to build large files incrementally. File must exist first.",
    parameters: appendFileParams(),
  },
};

export const PLAN_APPLY_PATCH_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "apply_patch",
    description: "Edit an existing file via exact fragment replacement (old_string/new_string).",
    parameters: applyPatchParams(),
  },
};

export const PLAN_BASH_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "bash",
    description: "Run readonly shell commands in the current terminal; on Windows this is the system-provided PowerShell (`powershell.exe`).", 
    parameters: bashParams(),
  },
};

// ── Agent-mode file tools ─────────────────────────────────

export const AGENT_APPLY_PATCH_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "apply_patch",
    description: "Edit an existing file via exact fragment replacement (old_string/new_string; set replace_all for repeated occurrences). Legacy SEARCH/REPLACE or unified-diff patch body also accepted.",
    parameters: applyPatchParams(),
  },
};

export const AGENT_WRITE_FILE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "write_file",
    description: "Create new file or replace entire file. For large files (>50KB): write_file first chunk, then append_file rest.",
    parameters: writeFileParams(),
  },
};

export const AGENT_APPEND_FILE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "append_file",
    description: "Append content to end of existing file. Use after write_file to build large files incrementally. File must exist first.",
    parameters: appendFileParams(),
  },
};

export const AGENT_BASH_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command in the workspace using the current terminal; on Windows this is the system-provided PowerShell (`powershell.exe`).",
    parameters: bashParams(),
  },
};
