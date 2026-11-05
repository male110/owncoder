/**
 * Enhanced Tool System
 * Adds LSP integration, Web search, semantic diff, and smart tool scheduling.
 *
 * Schemas live in ./enhanced-tools/* by domain (LSP, web, analysis, interaction,
 * memory, session changes, read tools, edit tools, experience, SDD). This module
 * assembles the mode/feature-gated tool list and owns the parallel-safety policy
 * shared by `scheduleToolCalls` and the ReAct loop's batch executor.
 */

import type { ToolDef } from "@owncoder/llm";
import type { AgentMode } from "@owncoder/shared";
import { LSP_TOOL_DEFS } from "./enhanced-tools/lsp.ts";
import { WEB_SEARCH_TOOL_DEF, WEB_FETCH_TOOL_DEF } from "./enhanced-tools/web.ts";
import {
  SEMANTIC_DIFF_TOOL_DEF,
  TYPE_CHECK_TOOL_DEF,
  ANALYZE_ISSUE_TOOL_DEF,
} from "./enhanced-tools/analysis.ts";
import { REPORT_BLOCKER_TOOL_DEF, ASK_USER_TOOL_DEF } from "./enhanced-tools/interaction.ts";
import {
  SAVE_MEMORY_TOOL_DEF,
  UPDATE_MEMORY_TOOL_DEF,
  FORGET_MEMORY_TOOL_DEF,
  LIST_MEMORIES_TOOL_DEF,
} from "./enhanced-tools/memory.ts";
import {
  LIST_SESSION_CHANGES_TOOL_DEF,
  UNDO_SESSION_CHANGE_TOOL_DEF,
} from "./enhanced-tools/session-changes.ts";
import { READ_TOOL_DEFS } from "./enhanced-tools/read-tools.ts";
import {
  PLAN_WRITE_FILE_TOOL_DEF,
  PLAN_APPEND_FILE_TOOL_DEF,
  PLAN_APPLY_PATCH_TOOL_DEF,
  PLAN_BASH_TOOL_DEF,
  AGENT_APPLY_PATCH_TOOL_DEF,
  AGENT_WRITE_FILE_TOOL_DEF,
  AGENT_APPEND_FILE_TOOL_DEF,
  AGENT_BASH_TOOL_DEF,
} from "./enhanced-tools/edit-tools.ts";
import { SAVE_EXPERIENCE_TOOL_DEF } from "./enhanced-tools/experience.ts";
import {
  SAVE_SPEC_TOOL_DEF,
  SAVE_DESIGN_TOOL_DEF,
  SAVE_TASKS_TOOL_DEF,
  LIST_SPECS_TOOL_DEF,
} from "./enhanced-tools/specs.ts";
import { DISPATCH_AGENT_TOOL_DEF } from "./enhanced-tools/subagent.ts";
import { ADD_TASKS_TOOL_DEF, UPDATE_TASKS_TOOL_DEF } from "./enhanced-tools/task-list.ts";
import { LIST_SDD_TOOL_DEF } from "./enhanced-tools/sdd.ts";
import { USE_SKILL_TOOL_DEF } from "./enhanced-tools/skills.ts";
import { RUN_SCRIPT_TOOL_DEF } from "./enhanced-tools/sandbox.ts";

export {
  SEMANTIC_DIFF_TOOL_DEF,
  TYPE_CHECK_TOOL_DEF,
} from "./enhanced-tools/analysis.ts";
export {
  REPORT_BLOCKER_TOOL_DEF,
  ASK_USER_TOOL_DEF,
} from "./enhanced-tools/interaction.ts";
export {
  SAVE_MEMORY_TOOL_DEF,
  UPDATE_MEMORY_TOOL_DEF,
  FORGET_MEMORY_TOOL_DEF,
  LIST_MEMORIES_TOOL_DEF,
} from "./enhanced-tools/memory.ts";
export {
  LIST_SESSION_CHANGES_TOOL_DEF,
  UNDO_SESSION_CHANGE_TOOL_DEF,
} from "./enhanced-tools/session-changes.ts";

// ── Parallel-safety policy ────────────────────────────────

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
  "glob",
  "repo_map",
  "search_symbols",
  "search_semantic",
  "project_deps",
  "web_search",
  "web_fetch",
  "lsp_diagnostics",
  "semantic_diff",
  "list_memories",
  "list_session_changes",
  "use_skill",
]);

/**
 * Names of every built-in read-only tool, derived from the tool definitions'
 * `readOnly` flag so the set cannot drift from the manifest. The ReAct loop
 * uses this to detect pure-exploration iterations (see loop/react-tool-exec.ts).
 * The previous hand-written list held a dead `search_code` alias and missed
 * list_specs / list_sdd / list_memories / list_session_changes — any call to
 * one of those reset the loop's read-only counter and hid stuck exploration.
 */
export const READONLY_TOOLS: ReadonlySet<string> = new Set(
  [
    ...READ_TOOL_DEFS,
    ...LSP_TOOL_DEFS,
    WEB_SEARCH_TOOL_DEF,
    WEB_FETCH_TOOL_DEF,
    SEMANTIC_DIFF_TOOL_DEF,
    LIST_MEMORIES_TOOL_DEF,
    LIST_SESSION_CHANGES_TOOL_DEF,
    LIST_SPECS_TOOL_DEF,
    LIST_SDD_TOOL_DEF,
    DISPATCH_AGENT_TOOL_DEF,
  ]
    .filter((def) => def.readOnly)
    .map((def) => def.function.name),
);

// ── Tool-list ordering ───────────────────────────────────

/**
 * 工具列表顺序会影响模型选择：受控搜索工具放在脚本之前，避免模型
 * 为简单的文件定位任务生成 shell 命令；run_script 主要负责跨文件聚合和
 * 二次处理。所有搜索路径均为当前 workspace-relative 路径。
 */
const READ_TOOL_BY_NAME = new Map(
  READ_TOOL_DEFS.map((def) => [def.function.name, def] as const),
);

/** All enhanced tools (includes original tools + new ones) */
export function allEnhancedTools(opts?: {
  mode: AgentMode;
  allowBash?: boolean;
  planBashReadonly?: boolean;
  allowSpecFiles?: boolean;
  enableLsp?: boolean;
  enableWebSearch?: boolean;
  enableVerification?: boolean;
}): ToolDef[] {
  const agent = opts?.mode === "agent";
  const spec = opts?.mode === "spec";
  const agentBash = agent && opts?.allowBash !== false;
  const planBash = spec && opts?.planBashReadonly === true;
  const specFiles = spec && opts?.allowSpecFiles !== false;

  const tools: ToolDef[] = [];
  const registeredNames = new Set<string>();
  const push = (...defs: (ToolDef | undefined)[]) => {
    for (const def of defs) {
      if (!def || registeredNames.has(def.function.name)) continue;
      registeredNames.add(def.function.name);
      tools.push(def);
    }
  };
  // 频率顺序里点名取单个读工具；名字敲错会在当场抛错，不留静默缺口。
  const read = (name: string): ToolDef => {
    const def = READ_TOOL_BY_NAME.get(name);
    if (!def) throw new Error(`allEnhancedTools: unknown read tool "${name}"`);
    return def;
  };

  // 1) Controlled search first: no shell syntax or platform path guessing.
  push(read("glob"), read("grep"), read("search_semantic"), read("search_symbols"));

  // 2) Script orchestration and known-path reads.
  push(RUN_SCRIPT_TOOL_DEF, read("read_file"));

  // 3) 执行与编辑：bash / apply_patch / write_file / append_file。
  //    write_file 1.0% / append_file 0.04%（agent 模式用原生版，spec 模式用 plan_* 版）
  push(
    agentBash ? AGENT_BASH_TOOL_DEF : planBash ? PLAN_BASH_TOOL_DEF : undefined,
    agent ? AGENT_APPLY_PATCH_TOOL_DEF : specFiles ? PLAN_APPLY_PATCH_TOOL_DEF : undefined,
  );

  // 4) 次高频读：read_outline / read_symbol。
  push(read("read_outline"), read("read_symbol"));

  // 5) 写文件 1.0%
  push(agent ? AGENT_WRITE_FILE_TOOL_DEF : specFiles ? PLAN_WRITE_FILE_TOOL_DEF : undefined);

  // 6) 验证：type_check 1.0%（agent 专属）
  if (agent && opts?.enableVerification !== false) {
    push(TYPE_CHECK_TOOL_DEF);
  }

  // 7) 检索与导航：web_search 0.6% / recall_history 0.4% / repo_map 0.3% /
  //    semantic_diff 0.3% / graph_search 0.14% / web_fetch 0.14%
  if (opts?.enableWebSearch !== false) {
    push(WEB_SEARCH_TOOL_DEF);
  }
  push(read("recall_history"), read("repo_map"), SEMANTIC_DIFF_TOOL_DEF, read("graph_search"));
  if (opts?.enableWebSearch !== false) {
    push(WEB_FETCH_TOOL_DEF);
  }

  // 8) 交互与变更台账：ask_user 0.14% / list_session_changes 0.1% /
  //    project_deps 0.1%
  push(ASK_USER_TOOL_DEF, LIST_SESSION_CHANGES_TOOL_DEF, read("project_deps"));

  // 9) LSP 诊断（合计约 0.4%）
  if (opts?.enableLsp !== false) {
    push(...LSP_TOOL_DEFS);
  }

  // 10) agent 专属排障：analyze_issue 0.07% / undo_session_change 0.07% /
  //     report_blocker 0.04%
  if (agent) {
    push(ANALYZE_ISSUE_TOOL_DEF, UNDO_SESSION_CHANGE_TOOL_DEF, REPORT_BLOCKER_TOOL_DEF);
  }

  // 11) 追加写：append_file 0.04%
  push(agent ? AGENT_APPEND_FILE_TOOL_DEF : specFiles ? PLAN_APPEND_FILE_TOOL_DEF : undefined);

  // 12) 长尾工作流工具（观测各 ≤0.04% 或未见调用）：spec 文档链、用户记忆、
  //     experience 归档、子智能体派发、skills、SDD 清单
  push(SAVE_SPEC_TOOL_DEF, SAVE_DESIGN_TOOL_DEF, SAVE_TASKS_TOOL_DEF, LIST_SPECS_TOOL_DEF);
  push(
    SAVE_MEMORY_TOOL_DEF,
    UPDATE_MEMORY_TOOL_DEF,
    FORGET_MEMORY_TOOL_DEF,
    LIST_MEMORIES_TOOL_DEF,
  );
  push(SAVE_EXPERIENCE_TOOL_DEF, DISPATCH_AGENT_TOOL_DEF, USE_SKILL_TOOL_DEF);
  // 动态任务清单（TodoWrite 式活清单）：任务图路径下与调度器共享数组，
  // 更新对新任务立即可见并经 readyTasks 自然派发。
  push(ADD_TASKS_TOOL_DEF, UPDATE_TASKS_TOOL_DEF);
  push(LIST_SDD_TOOL_DEF);

  return tools;
}
