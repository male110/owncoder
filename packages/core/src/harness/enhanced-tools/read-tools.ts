import type { ToolDef } from "@owncoder/llm";

// ── Read tools (always available) ─────────────────────────
// grep/glob are controlled workspace searches. They apply .gitignore and
// generated/binary exclusions, so models do not need to construct shell search
// commands or guess Windows/MSYS path syntax.

export const READ_TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    readOnly: true,
    function: {
      name: "glob",
      description:
        "Find workspace-relative files by a glob pattern. The search path is relative to the active workspace (default '.'); do not use /workspace or /e/... container/MSYS paths. Automatically skips .gitignore paths, dot directories, generated/vendor directories, and returns at most max_results paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob such as '**/*.java', 'src/**/*.ts', '*.json', or '*.{js,ts}'." },
          file_path: { type: "string", description: "Workspace-relative directory to search; omitted, empty, or whitespace-only means '.'." },
          max_results: { type: "integer", minimum: 1, maximum: 500, description: "Maximum matching paths (default 100)." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    readOnly: true,
    function: {
      name: "grep",
      description:
        "Search workspace file contents with a regex or literal string. file_path is workspace-relative; do not use /workspace or /e/... paths. Automatically skips .gitignore paths, dot/generated/vendor directories, lockfiles, binaries, and files over 2MB. Use output_mode 'files_with_matches' to locate files, or glob when you only know a filename pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex or literal text to search for." },
          file_path: { type: "string", description: "Workspace-relative directory or file; omitted, empty, or whitespace-only means '.'" },
          output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Result shape; defaults to 'content'." },
          glob: { type: "string", description: "Optional include pattern such as '**/*.java' or '*.ts'." },
          type: { type: "string", description: "Optional file type such as 'java', 'ts', or 'py'." },
          max_results: { type: "integer", minimum: 1, maximum: 500, description: "Maximum result entries (default 40)." },
          head_limit: { type: "integer", minimum: 0, description: "Optional result limit; 0 means unlimited." },
          offset: { type: "integer", minimum: 0, description: "Skip this many result entries." },
          ignore_case: { type: "boolean", description: "Ignore case (default true)." },
          multiline: { type: "boolean", description: "Allow matches to span lines." },
          before_context: { type: "integer", minimum: 0, description: "Context lines before a match." },
          after_context: { type: "integer", minimum: 0, description: "Context lines after a match." },
          context: { type: "integer", minimum: 0, description: "Context lines on both sides when before/after are omitted." },
          show_line_numbers: { type: "boolean", description: "Show line numbers (default true)." },
          only_matching: { type: "boolean", description: "Print only the matching text in content mode." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    readOnly: true,
    function: {
      name: "read_file",
      description: "Read a text file at a known path and return its full content with line numbers, or a specified line range. offset is the starting line number (1-based) and limit is the number of lines to read (not the ending line number); a line range requires both, otherwise the entire file is read. Returns an error when the file does not exist or the path is inaccessible.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Relative path from workspace root" },
          offset: { type: "integer", minimum: 1, description: "Starting line number (1-based); must be passed with limit when specifying a line range" },
          limit: { type: "integer", minimum: 1, description: "Number of lines to read (not the ending line number); must be passed with offset when specifying a line range" },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    readOnly: true,
    function: {
      name: "read_symbol",
      description:
        "Read a bounded source window around one unique symbol in a known file. " +
        "The index locates the symbol; this tool performs a normal fresh read with the same " +
        "workspace boundary, redaction, and line-range semantics as read_file. " +
        "padding controls the number of surrounding source lines included (default 12).",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Relative path from workspace root" },
          symbol: { type: "string", description: "Exact unique symbol name in this file" },
          padding: { type: "integer", minimum: 0, maximum: 80, description: "Optional surrounding source lines (default 12)" },
        },
        required: ["file_path", "symbol"],
      },
    },
  },
  {
    type: "function",
    readOnly: true,
    function: {
      name: "read_outline",
      description:
        "Get a file outline: every symbol's type, start/end line numbers, and signature — usually over 90% fewer tokens than reading the source. " +
        "Non-source files (json/md/yaml) return the file header for navigation. " +
        "The start/end line numbers from the outline can be used directly with read_file's offset/limit or to locate a symbol for read_symbol.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Relative path from workspace root" },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    readOnly: true,
    function: {
      name: "search_symbols",
      description:
        "Hybrid search over the code index: exact symbol names via full-text search plus semantic vector recall. Returns symbol definitions with locations, signatures, and documentation.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Symbol name, keyword, or natural-language query of what you are looking for" },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum results (default 20)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    readOnly: true,
    function: {
      name: "graph_search",
      description:
        "Graph search over the native symbol index: returns a symbol's definition plus callers (who invokes X) and callees (what X invokes), up to `depth` hops (1-4, default 2). " +
        "When a symbol is missing from the index, falls back to semantic Codemap lookup (including change risk and likely tests), then to a workspace file search over the exact symbol name.",
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
    readOnly: true,
    function: {
      name: "repo_map",
      description: "Budgeted repository symbol map (names + locations, no bodies). Returns symbol names and their locations across the repository.",
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
    readOnly: true,
    function: {
      name: "recall_history",
      description:
        "Retrieve the most relevant archived history for the current session. " +
        "Use a concise keyword or focused question describing the information needed. " +
        "Returns up to five matches with relevance of at least 60%. " +
        "Each match contains the full stored user input, task decomposition, LLM report, evidence metadata, and tool-call arguments (no tool results; fields are not truncated). " +
        "Use this when the current context is insufficient and earlier conversation, findings, or decisions may help.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword or focused question describing the history to retrieve",
          },
          before_turn_index: {
            type: "integer",
            minimum: 0,
            description:
              "Optional: only return archived chunks with turnIndex less than this value. " +
              "Use to search older history without repeating recently injected rounds.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    readOnly: true,
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
];
