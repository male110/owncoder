import type { ToolDef } from "@owncoder/llm";

// ── User Memory Tools ─────────────────────────────────────

export const SAVE_MEMORY_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "save_memory",
    description:
      "Persist a durable user preference. " +
      "Call this ONLY when the user states a long-lasting preference " +
      "(e.g. 'reply in Chinese', 'use tabs', 'don't add comments', " +
      "'prefer functional style'). Do NOT save ephemeral task state, " +
      "file paths, or one-off instructions.\n" +
      "Use scope='global' (default) for preferences that apply to ALL projects, " +
      "or scope='project' for preferences specific to the current workspace only.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short descriptive title (<= 120 chars), e.g. 'Reply language'.",
        },
        content: {
          type: "string",
          description: "The full preference statement (<= 2000 chars).",
        },
        category: {
          type: "string",
          description:
            "Free-form category like 'user_communication', 'dev_spec', 'ui_style'. Default 'general'.",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "2-6 keywords for retrieval (e.g. ['language', 'chinese', 'reply']).",
        },
        scope: {
          type: "string",
          enum: ["global", "project"],
          description: "'global' = all projects (default); 'project' = current workspace only.",
        },
      },
      required: ["title", "content"],
    },
  },
};

export const UPDATE_MEMORY_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "update_memory",
    description:
      "Update an existing user memory. Use when the user refines or contradicts " +
      "a previously saved preference. Call list_memories first to find the id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id returned by list_memories / save_memory." },
        title: { type: "string", description: "Short title for the memory (optional override)." },
        content: { type: "string", description: "Full memory text to store. Must be non-empty. Pass the complete preference/instruction verbatim." },
        category: { type: "string", description: "Category label, e.g. preference / rule / fact (optional)." },
        keywords: { type: "array", items: { type: "string" }, description: "Keyword tags for retrieval (optional)." },
        scope: { type: "string", enum: ["global", "project"], description: "Which store to update. Default: global." },
      },
      required: ["id"],
    },
  },
};

export const FORGET_MEMORY_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "forget_memory",
    description:
      "Remove a user memory. Use when the user explicitly revokes a preference " +
      "(e.g. 'forget that', 'don't remember that', 'ignore my earlier request'). " +
      "Call list_memories first to find the id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id to forget." },
        scope: { type: "string", enum: ["global", "project"], description: "Which store to remove from. Default: global." },
      },
      required: ["id"],
    },
  },
};

export const LIST_MEMORIES_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: true,
  function: {
    name: "list_memories",
    description:
      "List all active user memories with their ids, titles, categories, and content. " +
      "Use this before update_memory / forget_memory to locate the target id.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "project"], description: "List only this scope. Omit to list both." },
      },
    },
  },
};
