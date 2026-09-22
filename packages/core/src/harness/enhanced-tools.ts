/**
 * Enhanced Tool System
 * Adds LSP integration, Web search, semantic diff, and smart tool scheduling.
 */

import type { ToolDef } from "@owncoder/llm";
import type { AgentMode } from "@owncoder/shared";

// ── LSP Integration Tool ──────────────────────────────────


/**
 * LSP tool definitions for the agent.
 * These tools enable precise code navigation and understanding.
 */
const LSP_TOOL_DEFS: Record<string, ToolDef> = {
  lsp_go_to_definition: {
    type: "function",
    function: {
      name: "lsp_go_to_definition",
      description:
        "Jump to the definition of a symbol at a specific file location. " +
        "Returns the location(s) where the symbol is defined. Use this to understand " +
        "where functions, classes, or variables are defined.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Relative file path" },
          line: { type: "integer", description: "Line number (1-based)" },
          column: { type: "integer", description: "Column number (1-based)" },
        },
        required: ["filePath", "line", "column"],
      },
    },
  },
  lsp_find_references: {
    type: "function",
    function: {
      name: "lsp_find_references",
      description:
        "Find all references to a symbol. Returns every location where this symbol " +
        "is used. Essential for understanding the impact of changes.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Relative file path" },
          line: { type: "integer", description: "Line number (1-based)" },
          column: { type: "integer", description: "Column number (1-based)" },
        },
        required: ["filePath", "line", "column"],
      },
    },
  },
  lsp_hover: {
    type: "function",
    function: {
      name: "lsp_hover",
      description:
        "Get type information and documentation for a symbol at a location. " +
        "Shows the inferred type, JSDoc/docstring, and other hover information.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Relative file path" },
          line: { type: "integer", description: "Line number (1-based)" },
          column: { type: "integer", description: "Column number (1-based)" },
        },
        required: ["filePath", "line", "column"],
      },
    },
  },
  lsp_document_symbols: {
    type: "function",
    function: {
      name: "lsp_document_symbols",
      description:
        "List all symbols (functions, classes, types, variables) defined in a file. " +
        "Use this to understand a file's structure without reading it fully.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Relative file path" },
        },
        required: ["filePath"],
      },
    },
  },
  lsp_workspace_symbols: {
    type: "function",
    function: {
      name: "lsp_workspace_symbols",
      description:
        "Search for symbols across the entire workspace by name. Returns all matching " +
        "symbols with their locations. Use this to find where a function/class/type is defined.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Symbol name to search for" },
        },
        required: ["query"],
      },
    },
  },
  lsp_diagnostics: {
    type: "function",
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
  lsp_code_actions: {
    type: "function",
    function: {
      name: "lsp_code_actions",
      description:
        "Get available code actions at a location (quick fixes, refactorings, etc.). " +
        "The language server may suggest fixes for errors or code improvements.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Relative file path" },
          line: { type: "integer", description: "Line number (1-based)" },
          column: { type: "integer", description: "Column number (1-based)" },
        },
        required: ["filePath", "line", "column"],
      },
    },
  },
};

// ── Web Search Tool ───────────────────────────────────────


const WEB_SEARCH_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web. Use this proactively when you do not know something or are stuck: " +
      "unfamiliar errors, missing API/docs, library behavior, version-specific details, " +
      "or after one local retry still fails. Do not guess — search first, then web_fetch " +
      "the best official/source URL. Also use for latest documentation and current facts.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Be specific, include version numbers or dates if relevant.",
        },
        maxResults: {
          type: "integer",
          description: "Maximum number of results (default 5, max 10)",
        },
        language: {
          type: "string",
          description: "Preferred language (e.g., zh-CN, en-US)",
        },
      },
      required: ["query"],
    },
  },
};

const WEB_FETCH_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "web_fetch",
    description:
      "Fetch a URL and return its main readable text (article/body only). Strips navigation, " +
      "headers, footers, ads, sidebars, scripts and other chrome. For CSR/SPA pages the host " +
      "Electron renderer may be used as a fallback to obtain post-JS content. Use when the user " +
      "provides a specific webpage URL and you need to read the page (docs, articles, API " +
      "references, GitHub pages, etc.). Prefer this over web_search when you already have the exact URL.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full http(s) URL to fetch",
        },
        maxChars: {
          type: "integer",
          description: "Max characters of extracted text to return (default 50000, max 100000)",
        },
      },
      required: ["url"],
    },
  },
};

// ── Semantic Diff Tool ────────────────────────────────────

export const SEMANTIC_DIFF_TOOL_DEF: ToolDef = {
  type: "function",
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

// ── Handoff Tool ──────────────────────────────────────────

/**
 * report_blocker — the explicit "hand back to the user" terminal action.
 *
 * Without this the ReAct loop can only end by finishing the work or by
 * exhausting a budget, so a turn whose remaining work belongs to the user has
 * no compliant way to stop: the model keeps searching for another route and
 * drifts into work nobody asked for. Calling this tool ends the turn cleanly and
 * suppresses every autonomous follow-up stage (verify / auto-fix / task
 * auto-advance) while still presenting whatever was already changed.
 */
export const REPORT_BLOCKER_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "report_blocker",
    description:
      "End the turn and hand control back to the user. This is a SUCCESSFUL ending, not a failure — " +
      "use it whenever the remaining work is not yours to do. " +
      "Call it when: the root cause lies in user-owned runtime state (database rows, .env, credentials, " +
      "deployed config, external service or account settings); the user has forbidden an action and every " +
      "route you can see runs through it; progress needs a decision only the user can make (a tradeoff, a " +
      "scope change, a credential, approval of an irreversible action); the task rests on a premise you " +
      "found to be false; or 2-3 focused attempts at a real obstacle failed and you have no new hypothesis. " +
      "Do NOT look for a workaround to a goal the user just blocked, and do NOT build tooling (admin UI, " +
      "management API, migration script) that would let you perform the forbidden change — report instead. " +
      "After calling this, stop: issue no further tool calls this turn.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          enum: [
            "user_owned_state",
            "user_prohibited",
            "needs_user_decision",
            "false_premise",
            "attempts_exhausted",
          ],
          description:
            "Why you are handing back. 'user_owned_state' = the fix belongs to data/config the user owns; " +
            "'user_prohibited' = the user forbade the only route you can see; " +
            "'needs_user_decision' = a choice, credential, or approval is required; " +
            "'false_premise' = the request assumes something untrue; " +
            "'attempts_exhausted' = repeated focused attempts failed with no new hypothesis.",
        },
        summary: {
          type: "string",
          description:
            "The blocker or root cause, stated concretely. Name the specific thing (file, table, field, " +
            "setting, value) and how you determined it. Do not hedge or generalize.",
        },
        userAction: {
          type: "string",
          description:
            "Exactly what the user must do or decide to unblock this — the precise remediation, including " +
            "current value and intended value where applicable. If the user must choose between options, " +
            "list them with the tradeoff.",
        },
        completed: {
          type: "string",
          description:
            "Optional. What you did finish and verify before stopping, so the user knows the current state.",
        },
      },
      required: ["reason", "summary", "userAction"],
    },
  },
};

// ── User Memory Tools ─────────────────────────────────────

/**
 * ask_user — ask the user a question and wait for an answer.
 *
 * The question may include selectable choices or allow a free-text response.
 * The turn pauses until the user responds.
 */
export const ASK_USER_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "ask_user",
    description:
      "Ask the user one question and wait for their response. " +
      "Use options for selectable choices or allowFreeText=true for an open-ended response. " +
      "Execution pauses until the user responds.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to present to the user.",
        },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short label shown on the choice button." },
              value: { type: "string", description: "Value returned to you when the user picks this option." },
              description: { type: "string", description: "Optional one-line explanation of the option." },
            },
            required: ["label", "value"],
          },
          description:
            "Optional selectable choices. The selected value is returned to you.",
        },
        allowFreeText: {
          type: "boolean",
          description: "If true, the user may type a free-text answer instead of picking an option. Default false.",
        },
        placeholder: {
          type: "string",
          description: "Placeholder hint for the free-text input (only used when allowFreeText is true).",
        },
      },
      required: ["question"],
    },
  },
};

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

export const LIST_SESSION_CHANGES_TOOL_DEF: ToolDef = {
  type: "function",
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
        path: {
          type: "string",
          description: "Single workspace-relative file path from list_session_changes / the Changes bar.",
        },
      },
      required: ["path"],
    },
  },
};


/**
 * Tools that are safe to execute concurrently: pure reads with no workspace
 * side effects. Everything else (writes, bash, memory mutations, MCP tools)
 * runs sequentially to avoid ordering hazards. Shared by `scheduleToolCalls`
 * and the ReAct loop's batch executor.
 */
export const PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "read_symbol",
  "read_outline",
  "list_dir",
  "repo_map",
  "search_symbols",
  "git_status",
  "project_deps",
  "web_search",
  "web_fetch",
  "lsp_go_to_definition",
  "lsp_find_references",
  "lsp_hover",
  "lsp_document_symbols",
  "lsp_workspace_symbols",
  "lsp_diagnostics",
  "lsp_code_actions",
  "semantic_diff",
  "list_memories",
  "list_session_changes",
]);


const writeFileParams = () => ({
  type: "object" as const,
  properties: {
    path: { type: "string", description: "Relative path from workspace root" },
    content: { 
      type: "string", 
      description: 
        "Complete file content. " +
        "WARNING: Content >50KB causes 'path field was lost' error. " +
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
  required: ["path", "content"] as string[],
});

const appendFileParams = () => ({
  type: "object" as const,
  properties: {
    path: { type: "string", description: "Relative path from workspace root" },
    content: { 
      type: "string", 
      description: 
        "Content to append to end of file. Each call adds this text to the file's end. " +
        "Keep each append <50KB to avoid JSON payload issues."
    },
  },
  required: ["path", "content"] as string[],
});
const applyPatchParams = () => ({
  type: "object" as const,
  properties: {
    path: { type: "string", description: "Relative path from workspace root" },
    patch: { 
      type: "string", 
      description: 
        "**FORMAT: Use SEARCH/REPLACE blocks (recommended)**\n\n" +
        "Example:\n" +
        "```\n" +
        "<<<<<<< SEARCH\n" +
        "old text\n" +
        "=======\n" +
        "new text\n" +
        ">>>>>>> REPLACE\n" +
        "```\n\n" +
        "RULES:\n" +
        "- SEARCH must match the text, indentation, and whitespace shown by read_file; LF and CRLF line endings are treated as equivalent\n" +
        "- Replacement line endings follow the target file, preventing mixed LF/CRLF files\n" +
        "- Markers (<<<<<<< =======  >>>>>>>) must be on their own lines\n" +
        "- Can include multiple blocks in one patch\n" +
        "- Alternative: Unified Diff format (git diff style) also supported"
    },
  },
  required: ["path", "patch"] as string[],
});
const savePlanParams = () => ({
  type: "object" as const,
  properties: {
    content: { type: "string", description: "Full plan markdown content. Must be non-empty. Pass the complete plan body verbatim." },
    title: { type: "string", description: "Human-readable plan title (optional)." },
    filename: { type: "string", description: "Filename under .owncoder/plans/ without extension (optional)." },
  },
  required: ["content"] as string[],
});
const bashParams = () => ({
  type: "object" as const,
  properties: {
    command: { type: "string", description: "Shell command to execute. Must be non-empty." },
  },
  required: ["command"] as string[],
});

/** All enhanced tools (includes original tools + new ones) */
export function allEnhancedTools(opts?: {
  mode: AgentMode;
  allowBash?: boolean;
  planBashReadonly?: boolean;
  allowPlanFiles?: boolean;
  enableLsp?: boolean;
  enableWebSearch?: boolean;
  enableVerification?: boolean;
}): ToolDef[] {
  const tools: ToolDef[] = [];

  // Read tools (always available)
  tools.push(
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file under the workspace. Whole-file reads (omit offset and limit) are allowed only when the file is under 10KB. Files 10KB or larger MUST call read_outline first, then read_symbol for one unique symbol or read_file with the line range (offset and limit) from the outline. A large-file read without a range is rejected; never fall back to reading the whole file. For log files and other files that have no useful outline or cannot be read by line range, use a bash command to read them in one shot instead of retrying whole-file read_file. Prefer relative paths. IMPORTANT: If the file is not found, do NOT retry the same path — use grep to locate the actual path first, then read the confirmed path.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path from workspace root" },
            offset: { type: "integer", minimum: 1, description: "1-based start line; required for large files after read_outline" },
            limit: { type: "integer", minimum: 1, description: "Maximum lines to return; required with offset for large files" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_symbol",
        description:
          "Read a bounded current-source window around one unique symbol in a known file. " +
          "The index only locates the symbol; this tool performs a normal fresh read with the same " +
          "workspace boundary, redaction, line-range, and source-evidence semantics as read_file. " +
          "For large files, use it only after read_outline identifies exactly one matching symbol; " +
          "if the symbol is ambiguous or unavailable, use read_file with the outline's offset and limit.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path from workspace root" },
            symbol: { type: "string", description: "Exact unique symbol name in this file" },
            padding: { type: "integer", minimum: 0, maximum: 80, description: "Optional surrounding source lines (default 12)" },
          },
          required: ["path", "symbol"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_outline",
        description:
          "Read a file's symbol outline (skeleton) instead of its full text: one line per symbol with kind, " +
          "line range, and signature. Typically 90%+ fewer tokens than read_file for source files. " +
          "Returns the complete outline. This is the required first step for large files. Then use read_symbol for one uniquely matched symbol, " +
          "or read_file with offset and limit from the returned line range. Non-source files (json/md/yaml) fall back to head lines.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path from workspace root" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files in a directory (non-recursive by default).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory relative path, default ." },
            recursive: { type: "boolean", description: "If true, list recursively (default false)." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description:
          "Search file contents with a regex or plain string. Prefer the most specific available text as the pattern and preserve known names, expressions, and signatures instead of inventing alternatives. Skips dot-directories (.git, .next, .owncoder, …), generated directories (node_modules, dist, out, build, coverage, …), lockfiles, binaries, and files larger than 2MB. For symbol names prefer search_symbols.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex or plain string to search for. Must be non-empty." },
            path: { type: "string", description: "Subdirectory or file to search" },
            maxResults: { type: "integer", description: "Max matches to return (default 50)." },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_symbols",
        description: "Full-text search over indexed symbols using SQLite FTS5. Returns symbol definitions with locations, signatures, and documentation. Use this to find functions, classes, or variables by name when you don't know the exact file location. Prefer grep when searching for exact strings in file content.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Symbol name or keyword to search (fuzzy matching supported)" },
            limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum results (default 20)" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "graph_search",
        description:
          "Graph search over the native symbol index: returns a symbol's definition plus callers (who invokes X) and callees (what X invokes), up to `depth` hops (1-4, default 2). Use when you already know a symbol name and want impact/dependency tracing. To LOCATE an unknown symbol use search_symbols or codemap_search; to match an exact string use grep. Example: query='loginUser' depth=2 shows who calls loginUser and what it calls.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Symbol name (function/class/method)" },
            depth: { type: "integer", description: "Graph hops 1-4 (default 2)" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "codemap_search",
        description:
          "Semantic search over the embedded Codemap to locate symbols/code concepts when you do NOT already know the file or line. Use this FIRST for 'where is X handled / find the Y logic' questions. Returns stable nodeId values — pass one to codemap_impact before editing a shared symbol. Prefer search_symbols for known symbol names or grep when you have an exact string to match.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Symbol name or code-oriented query" },
            limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum results, default 12" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "codemap_impact",
        description:
          "Analyze a Codemap node's callers, callees, likely tests, and change risk before editing a shared/public symbol. nodeId MUST come from codemap_search — never a display name (duplicates are ambiguous). Use graph_search if you only need caller/callee hops without risk scoring. Example: codemap_search returns nodeId='n_42' for processPayment → codemap_impact nodeId='n_42' reveals blast radius + related tests.",
        parameters: {
          type: "object",
          properties: {
            nodeId: { type: "string", description: "Stable nodeId returned by codemap_search" },
            depth: { type: "integer", minimum: 1, maximum: 6, description: "Traversal depth, default 3" },
          },
          required: ["nodeId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "repo_map",
        description: "Budgeted repository symbol map (names + locations, no bodies). Use to grasp architecture or pick an entry point in an unfamiliar codebase; NOT for reading a specific implementation — use read_file or codemap_search for that.",
        parameters: {
          type: "object",
          properties: {
            hint: { type: "string", description: "Optional focus hint" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "recall_history",
        description:
          "Retrieve the most relevant archived history for the current session. " +
          "Use a concise keyword or focused question describing the information needed. " +
          "Returns up to five matches with relevance of at least 60%. " +
          "Each match contains only the user input, task decomposition, LLM report, evidence metadata, and tool-call arguments (no tool results). " +
          "Use this when the current context is insufficient and earlier conversation, findings, or decisions may help.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keyword or focused question describing the history to retrieve",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_status",
        description: "Get git branch, dirty/staged/untracked counts.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "project_deps",
        description:
          "List the project's declared dependencies across ecosystems (npm, cargo, python, go, maven, gradle, nuget, etc.) by parsing root-level manifests. " +
          "Returns a compact Markdown block of dependency names and version ranges. " +
          "If the result is empty (no recognizable manifest found), read the relevant manifest files directly " +
          "(e.g. package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml, build.gradle) to obtain the data you need.",
        parameters: { type: "object", properties: {} },
      },
    },
  );

  // LSP tools
  if (opts?.enableLsp !== false) {
    tools.push(
      LSP_TOOL_DEFS.lsp_go_to_definition!,
      LSP_TOOL_DEFS.lsp_find_references!,
      LSP_TOOL_DEFS.lsp_hover!,
      LSP_TOOL_DEFS.lsp_document_symbols!,
      LSP_TOOL_DEFS.lsp_workspace_symbols!,
      LSP_TOOL_DEFS.lsp_diagnostics!,
      LSP_TOOL_DEFS.lsp_code_actions!,
    );
  }

  // Web search + URL fetch
  if (opts?.enableWebSearch !== false) {
    tools.push(WEB_SEARCH_TOOL_DEF);
    tools.push(WEB_FETCH_TOOL_DEF);
  }

  // Semantic diff
  tools.push(SEMANTIC_DIFF_TOOL_DEF);

  // User memory tools (available in both plan and agent modes)
  tools.push(
    SAVE_MEMORY_TOOL_DEF,
    UPDATE_MEMORY_TOOL_DEF,
    FORGET_MEMORY_TOOL_DEF,
    LIST_MEMORIES_TOOL_DEF,
  );

  // Session pending changes: list is read-only in every mode; undo is agent-only.
  tools.push(LIST_SESSION_CHANGES_TOOL_DEF);

  // Experience harvest (both modes; writes under .owncoder/experiences/)
  tools.push({
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
  });

  // SDD tools (both modes; writes under .owncoder/sdd/<feature>/)
  tools.push(
    {
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
    },
    {
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
    },
    {
      type: "function",
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
    },
  );

  // Bug-fix workflow (agent mode; runs verification to reproduce)
  if (opts?.mode === "agent") {
    tools.push({
      type: "function",
      function: {
        name: "analyze_issue",
        description:
          "Run a proactive bug-fix analysis: parse the issue → reproduce via verification → localize root-cause candidates. Returns a structured plan (symptom, failing checks, likely files, strategy) to guide apply_patch. Use before patching a non-trivial bug.",
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
    });
  }

  // Plan mode tools
  if (opts?.mode === "plan") {
    if (opts?.allowPlanFiles !== false) {
      tools.push(
        {
          type: "function",
          function: {
            name: "save_plan",
            description: "Save an implementation plan markdown file under `.owncoder/plans/`.",
            parameters: savePlanParams(),
          },
        },
        {
          type: "function",
          function: {
            name: "write_file",
            description: "Create new file or replace entire file. For edits use apply_patch. For large files: write_file first part, then append_file rest.",
            parameters: writeFileParams(),
          },
        },
        {
          type: "function",
          function: {
            name: "append_file",
            description: "Append content to end of existing file. Use after write_file to build large files incrementally. File must exist first.",
            parameters: appendFileParams(),
          },
        },
        {
          type: "function",
          function: {
            name: "apply_patch",
            description: "Edit a file using SEARCH/REPLACE blocks. Always prefer this over write_file for partial edits. Multiple blocks supported in one call.",
            parameters: applyPatchParams(),
          },
        },
      );
    }
    if (opts?.planBashReadonly) {
      tools.push({
        type: "function",
        function: {
          name: "bash",
          description: "Run readonly shell commands (ls, dir, cat, type, git status, etc.).",
          parameters: bashParams(),
        },
      });
    }
  }

  // Agent mode tools
  if (opts?.mode === "agent") {
    tools.push(
      {
        type: "function",
        function: {
          name: "apply_patch",
          description: "Edit a file using SEARCH/REPLACE blocks (recommended) or Unified Diff. Always prefer this over write_file for any edits.",
          parameters: applyPatchParams(),
        },
      },
      {
        type: "function",
        function: {
          name: "write_file",
          description: "Create new file or replace entire file. For large files (>50KB): write_file first chunk, then append_file rest.",
          parameters: writeFileParams(),
        },
      },
      {
        type: "function",
        function: {
          name: "append_file",
          description: "Append content to end of existing file. Use after write_file to build large files incrementally. File must exist first.",
          parameters: appendFileParams(),
        },
      },
      REPORT_BLOCKER_TOOL_DEF,
      UNDO_SESSION_CHANGE_TOOL_DEF,
    );

    if (opts?.allowBash !== false) {
      tools.push({
        type: "function",
        function: {
          name: "bash",
          description: "Run a shell command in the workspace.",
          parameters: bashParams(),
        },
      });
    }



    // Verification tools (type_check only; tests via bash when needed)
    if (opts?.enableVerification !== false) {
      tools.push(TYPE_CHECK_TOOL_DEF);
    }
  }

  // ask_user is available in every mode — a decision-blocking question can
  // arise during planning just as during implementation.
  tools.push(ASK_USER_TOOL_DEF);

  return tools;
}
