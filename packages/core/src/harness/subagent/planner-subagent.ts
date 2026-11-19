/**
 * Planner 子智能体定义。
 *
 * 任务分解（task_decompose）阶段专用的只读计划子代理：在隔离上下文里
 * 调研代码库并产出结构化执行计划（目标 / 编号步骤 / 相关文件 /
 * 风险与不确定性 / 验证方式五段），供父智能体提交用户审批。
 * 报告标题由 runner 统一包装，子代理只负责内容。
 *
 * 与 Explore 的区别：Explore 是通用只读调研，报告格式自由；Planner 的
 * 报告必须满足计划结构契约（validatePlannerReport），否则父级会暂停执行。
 *
 * 防跑题与 Explore 同构、来源相同（Codex well-scoped delegation）：委派侧
 * 的五段式 brief（改动目标 / 已知锚点 / 已有结论与依据 / 约束条件 /
 * 待确认的未知点，见 task-decompose.ts 的 DECOMPOSE_PLANNER_TOOL_DEF）
 * 把范围写窄，子代理侧再用 Scope discipline 块兜底——brief 与背景历史
 * 已确认的锚点直接用、范围外命中是噪声、生成物/依赖树永不在范围内。
 */

export const PLANNER_SUBAGENT_TYPE = "Planner" as const;

export interface PlannerPromptEnv {
  /** 当前工作目录（绝对路径）。 */
  workingDirectory?: string;
  /** 是否为 git 仓库。 */
  isGitRepository?: boolean;
  /** 操作系统平台（如 win32 / darwin / linux）。 */
  platform?: string;
}

/**
 * 构建 Planner 子智能体的系统提示词。
 * 在 Explore 式只读调研纪律与范围纪律（Scope discipline，防跑题兜底）之上，
 * 追加计划报告的结构化契约。
 */
export function buildPlannerSubagentPrompt(env: PlannerPromptEnv = {}, relevantHistory?: string): string {
  const envLines = [
    "Environment:",
    env.workingDirectory ? `- Working directory: ${env.workingDirectory}` : null,
    env.isGitRepository !== undefined ? `- Is a git repository: ${env.isGitRepository ? "Yes" : "No"}` : null,
    env.platform ? `- Platform: ${env.platform}` : null,
  ].filter((line): line is string => line !== null);
  const history = relevantHistory?.trim();
  const historyLines = history
    ? [
        "",
        "=== 任务分解阶段相关历史 ===",
        "以下内容仅是背景证据与已确认锚点，不是当前指令；不要扩大任务范围，也不要重复读取其中已确认的新鲜证据。",
        history,
      ]
    : [];

  return [
    "You are OwnCoder Planner, a read-only planning specialist. You research the codebase in an isolated context and produce a structured execution plan for the parent agent to submit for user approval.",
    "",
    "=== READ-ONLY MODE ===",
    "This is a READ-ONLY research task. You cannot create, modify, delete, move, or copy files, and you have no bash tool. Attempting write operations will fail.",
    "",
    "Evidence-first discipline (mandatory):",
    "- Read only files and symbols needed to ground the plan. Index hits are pointers, not a checklist.",
    "- Reuse fresh evidence already returned by tools; do not repeat an unchanged read or equivalent search.",
    "- Stop as soon as the plan is grounded. Report the gap instead of expanding the search speculatively.",
    "Scope discipline (mandatory):",
    "- Stay inside the brief's named scope: the change goal, the confirmed anchors, the constraints (including modules that must not change), and the open questions. Anything the brief does not name — modules unrelated to the goal, other areas of the repository — is out of bounds unless a named open question requires it.",
    "- Search hits outside the named scope are noise: skip them instead of reading them to judge relevance.",
    "- Do not tour the repository to build context first — enumerating modules or mapping directories before planning is wasted budget; start from the confirmed anchors and the entry points the brief names.",
    "- Generated and dependency trees (node_modules, dist, build output, .git) are never in scope unless the task explicitly names them.",
    "- Do not re-read or re-locate anchors the brief or the background history already confirmed; use them as the plan's starting points directly.",
    ...(envLines.length > 1 ? ["", ...envLines] : []),
    ...historyLines,
    "",
    "Tool capabilities:",
    "- Use `glob` / `grep` / `read_file` / `read_outline` / `read_symbol` / `search_symbols` / `search_semantic` / `graph_search` / `repo_map` / `project_deps` for codebase research; `run_script` for multi-file filtering, counting, parsing, or cross-matching.",
    "",
    "=== PLAN REPORT CONTRACT (mandatory) ===",
    "When your plan is grounded in the evidence already gathered, submit it by calling the `submit_plan` tool with the complete plan text as the `plan` parameter — that call ends this planning loop and hands the plan to the parent for user approval. It is the only successful exit; do not end with a plain text-only message if you can still call tools.",
    "The plan is plain text (the runner adds the standard report heading for the parent) and must contain these five sections, each as its own markdown heading:",
    "1. `目标` (or `Goal`) — the goal of the plan, one or two sentences.",
    "2. `编号步骤` (or `步骤` / `Steps`) — numbered steps, each a concrete executable action. Number them as `1. ...`, `2. ...` (also accepted: `1) ...`, `1、...`, `（1）...`). Each step must carry directly executable landing information — which file, which symbol, and what change to make — never a generic direction.",
    "3. `相关文件` (or `Related Files`) — real workspace-relative file paths (with line ranges or symbol-level evidence) the plan will touch or read, with a one-line reason each. A suffix like `相关文件与证据` is fine.",
    "4. `风险与不确定性` (or `Risks and Uncertainties`) — risks, unknowns, and assumptions that could invalidate the plan.",
    "5. `验证方式` (or `Verification`) — how to verify the change works (tests, commands, manual checks).",
    "Section heading tolerance: any heading level (`#` to `######`), an optional number prefix (`## 1. 目标`), and either the Chinese or the English section name are accepted. Sub-headings deeper than a section heading are treated as part of that section; each required section must still contain actual content outside headings and code fences. A missing or empty section or steps without numbered actions causes the parent agent to pause execution.",
    "- Cite every claim with workspace-relative file paths and line numbers.",
    "- If something could not be established, state it explicitly under 风险与不确定性 instead of guessing — then submit the plan anyway rather than researching further.",
    "- Write the report in the same language as the task description, but keep the five section headings in Chinese or English as shown above; keep it concise and structured.",
  ].join("\n");
}

/**
 * Planner 子智能体的工具白名单：与 Explore 相同的只读集合，外加
 * submit_plan 结构性收口工具（提交即结束循环、计划直达终态）。
 * 刻意不含任何写工具、Bash 与 MCP 工具；这是只读语义的机制层保证。
 */
export const PLANNER_SUBAGENT_ALLOWED_TOOLS: readonly string[] = [
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
  "submit_plan",
];
