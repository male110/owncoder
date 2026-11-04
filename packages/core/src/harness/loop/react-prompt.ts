/**
 * ReAct 提示词构造与工具结果历史摘要。
 *
 * 从 react.ts 拆分：当前任务/本轮任务上下文格式化、打包历史、
 * 工具结果的历史摘要、文档交付物检测等纯函数。
 * 本模块为纯函数模块，不依赖 react.ts。
 */
import { type TaskItem } from "../../plans.ts";
import type { ChatTurn } from "./types.ts";
import type { ToolResultMetadata } from "../tools/types.ts";
import { USER_FACING_WRITE_TOOLS } from "./react-steps.ts";

const SPEC_DOC_LABEL: Record<string, string> = {
  save_spec: "Requirements spec",
  save_design: "Technical design",
  save_tasks: "Implementation task list",
};

/**
 * Synthesize a one-line user-visible summary from a file-modifying tool's result.
 * Only generated on success; returns null when no summary is needed (read-only tools or failures).
 */
export function summarizeToolActionForUser(
  name: string,
  result: { ok: boolean; output: string },
): string | null {
  if (!result.ok || !USER_FACING_WRITE_TOOLS.has(name)) return null;
  const out = result.output ?? "";
  if (name === "save_spec" || name === "save_design" || name === "save_tasks") {
    const label = SPEC_DOC_LABEL[name] ?? "Document";
    const p = out.replace(/^(?:Spec|Design|Tasks) saved to\s*/i, "").replace(/\.\n[\s\S]*$/s, "").trim();
    return `${label} saved${p ? `: ${p}` : ""}. Review it in the spec panel — approve to continue to the next phase (or ask for changes).`;
  }
  if (name === "write_file") {
    const p = out.replace(/^Wrote\s*/i, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
    return `File written${p ? `: ${p}` : ""}.`;
  }
  if (name === "apply_patch") {
    const p = out.replace(/^Patched\s*/i, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
    return `File patched${p ? `: ${p}` : ""}.`;
  }
  return null;
}

function formatPackedHistory(task: TaskItem): string {
  const text = task.relevantHistory?.trim() ?? "";
  return text
    ? `### Reusable history (from task decomposition)\n${text}`
    : "";
}

export function formatTaskConstraints(task: TaskItem): string {
  return task.userConstraints?.length
    ? `### Task constraints\n${task.userConstraints.map((constraint) => `- ${constraint}`).join("\n")}`
    : "";
}




export function formatCurrentTaskContext(task: TaskItem): string {
  // Keep this contract short and mechanical. The model needs an explicit stop
  // condition, while detailed exploration prose belongs in the base prompt.
  return [
    "## **Current Task (in progress; prioritize; move to the next only after completion)**",
    "Execution discipline (mandatory):",
    "- If the task names an exact file/range or replacement text, do not search or inspect unrelated files; read only that target, then edit and verify.",
    "- Read only evidence required by this task. Search results and index hits are navigation pointers, not a checklist of files to open.",
    "- Reuse fresh evidence already in context; do not re-read an unchanged file or re-run an equivalent search.",
    "- When the evidence is sufficient, stop exploring immediately and edit, verify, report, or state the blocker.",
    `ID: ${task.id}`,
    `Description: ${task.description}`,
    task.dependsOn.length > 0 ? `Depends on: ${task.dependsOn.join(", ")}` : "",
    task.guidance ? `Guidance: ${task.guidance}` : "",
    task.acceptance ? `Acceptance criteria: ${task.acceptance}` : "",
    task.progressStatus ? `Progress status: ${task.progressStatus}` : "",
    formatTaskConstraints(task),
    formatPackedHistory(task),
    "Use tools to execute this task. Report the result in one sentence when done; do not keep calling tools.",
  ].filter(Boolean).join("\n");
}

function isSourceReadTool(
  call: { name: string },
  result: { ok: boolean; metadata?: ToolResultMetadata },
): boolean {
  return result.ok && (
    result.metadata?.kind === "read_file" ||
    call.name === "read_symbol" ||
    call.name === "read_outline"
  );
}

export function summarizeToolResultForHistory(
  call: { name: string; arguments?: Record<string, unknown> },
  result: { ok: boolean; output: string; metadata?: ToolResultMetadata },
): string {
  const output = result.output;
  if (isSourceReadTool(call, result)) {
    if (result.metadata?.kind === "read_file") {
      const path = result.metadata.path;
      const start = result.metadata.startLine ?? "?";
      const end = result.metadata.endLine ?? "?";
      const total = result.metadata.totalLines ?? "?";
      return `Read ${path} (lines ${start}-${end} of ${total})\n${output}`;
    }
    const path = String(call.arguments?.path ?? "").trim();
    return path ? `${call.name} ${path}\n${output}` : output;
  }
  if (!result.ok) return `${call.name} failed: ${output}`;
  return `${call.name} completed: ${output}`;
}

/** 从 history 末尾找最近一条非空 assistant 文本（用于空响应时回填 lastAssistant）。 */
export function lastAssistantSummaryFromHistory(history: ChatTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.role === "assistant" && h.content.trim()) return h.content;
  }
  return null;
}
