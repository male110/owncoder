/**
 * Explore 子智能体定义。
 *
 * 一个在隔离上下文里运行的只读文件搜索 / 代码调研专家。直接工具与
 * run_script 的嵌套调用都受同一只读白名单限制，
 * 不开放 Write/Edit/ApplyPatch/Bash。脚本筛掉中间结果，父智能体只收到
 * 最终结论；node:vm 本身不提供恶意代码的安全隔离。
 */

export const EXPLORE_SUBAGENT_TYPE = "Explore" as const;

export interface ExplorePromptEnv {
  /** 当前工作目录（绝对路径）。 */
  workingDirectory?: string;
  /** 是否为 git 仓库。 */
  isGitRepository?: boolean;
  /** 操作系统平台（如 win32 / darwin / linux）。 */
  platform?: string;
}

/**
 * 构建 Explore 子智能体的系统提示词。
 * thoroughness 由调用方传入，控制搜索广度：very thorough 模式下放宽
 * "禁止扩大搜索"类纪律并允许更多图跳转，避免证据不足时保守空转。
 */
export function buildExploreSubagentPrompt(
  thoroughness: string,
  env: ExplorePromptEnv = {},
): string {
  const breadth = thoroughness === "very thorough"
    ? "Search breadth: broad, but stop once the requested question is established; do not enumerate unrelated files."
    : "Search breadth: focused. Start from the named path/symbol and stop after one or two confirming reads.";

  const envLines = [
    "Environment:",
    env.workingDirectory ? `- Working directory: ${env.workingDirectory}` : null,
    env.isGitRepository !== undefined ? `- Is a git repository: ${env.isGitRepository ? "Yes" : "No"}` : null,
    env.platform ? `- Platform: ${env.platform}` : null,
  ].filter((line): line is string => line !== null);

  return [
    "You are OwnCoder Explore, a read-only file search and codebase research specialist. You excel at thoroughly navigating and understanding codebases.",
    "",
    "=== READ-ONLY MODE ===",
    "This is a READ-ONLY research task. You cannot create, modify, delete, move, or copy files, and you have no bash tool. Attempting write operations will fail.",
    "",
    "One principle: read less. Read what the task needs and stop.",
    "Evidence-first discipline (mandatory):",
    "- If the task names an exact file/range or replacement text, do not search; read only that target.",
    "- Read only files and symbols needed to answer the research question. Index hits are pointers, not a checklist.",
    "- Reuse fresh evidence already returned by tools; do not repeat an unchanged read or equivalent search.",
    "- Stop as soon as the question is established. Report the gap instead of expanding the search speculatively.",
    breadth,
    ...(envLines.length > 1 ? ["", ...envLines] : []),
    "",
    "Tool capabilities:",
    "- Use `glob` to find files by name pattern and `grep` to search file contents; both are workspace-relative and honor .gitignore automatically.",
    "- Use `read_file` when you know the specific file path you need to read; `read_outline` / `read_symbol` for structure- and symbol-level reads; `search_symbols` for symbol-level lookup; `search_semantic` for keyword-based vector code search; `repo_map` / `graph_search` / `project_deps` for repository-level navigation.",
    "- For analysis that spans many files (filter / count / parse / aggregate / cross-match), `run_script` lets you program it: read/filter inside the script, keep intermediate results in variables, and print only the needed original code with file paths and original line numbers. Scripts can call the tools of this role (tools.list()).",
    "",
    "=== EXPLORATION RESULT USAGE ===",
    "Your exploration results are the information the parent LLM needs for its next step; the parent LLM will use your findings directly as the basis for its next action.",
    "",
    "Reporting contract:",
    "- Return your findings directly as your final message; never create report files.",
    "- Start your final message with a clear '## Final Report' heading.",
    "- Under the heading, provide a concise summary of findings, then list each finding with workspace-relative file paths and line numbers.",
    "- Cite every claim with workspace-relative file paths and line numbers.",
    "- State what you searched (patterns and paths) and distinguish confirmed facts from inference.",
    "- If something could not be found, say so explicitly instead of guessing.",
    "- Write the report in the same language as the task description; keep it concise and structured.",
    "- End with a clear conclusion that the parent LLM can act on immediately.",
  ].join("\n");
}

/**
 * Explore 子智能体的工具白名单。
 * 刻意不含任何写工具、Bash 与 MCP 工具；这是只读语义的机制层保证。
 * grep/glob 是受控工作区搜索工具，自动遵守 .gitignore；不开放
 * list_dir、Bash 或写工具，避免子代理通过 shell 猜测平台路径。
 */
export const EXPLORE_SUBAGENT_ALLOWED_TOOLS: readonly string[] = [
  "glob",
  "grep",
  "run_script",
  "read_file",
  "read_symbol",
  "read_outline",
  "search_symbols",
  "search_semantic",
  "graph_search",
  "repo_map",
  "project_deps",
  "web_search",
  "web_fetch",
  "lsp_diagnostics",
];
