import { readFile, stat } from "node:fs/promises";
import { platform } from "node:os";
import upath from "upath";
import { relative, resolve } from "node:path";
import { assertLlmAuth, chatCompletionStream, writeEventLog, type ChatMessage, type ToolCall } from "@owncoder/llm";
import { defaultReactSteps, type PipelineNode, type ReactStepConfig } from "@owncoder/settings";
import { clampText } from "../budget.ts";
import { isRedactionEnabled, redactSecrets } from "../redact.ts";
import { formatWithLines } from "../tools/shared.ts";
import {
  createLoopState,
  checkTermination,
  updateStateAfterResponse,
  updateStateAfterTools,
  resetOutputTrackingForNewTask,
  createTerminationConfig,
  type LoopState,
  type TerminationConfig,
} from "./termination.ts";
import { getGlobalMetricsCollector } from "./termination-metrics.ts";
import { normalizeUsage, type Tracer } from "../observability.ts";
import { shouldInjectPostToolTextNudge } from "./continuation-intent.ts";

// ── ReactSteps helpers ─────────────────────────────────────────────────────────
/** Look up a single step's config from the node's reactSteps, falling back to defaults. */
function getStepConfig(steps: ReactStepConfig[], id: string): ReactStepConfig {
  return steps.find((s) => s.id === id) ?? defaultReactSteps().find((s: ReactStepConfig) => s.id === id)!;
}

/** Return numeric param from a step, with a module-level fallback value. */
function stepNum(steps: ReactStepConfig[], id: string, key: string, fallback: number): number {
  const step = getStepConfig(steps, id);
  if (!step || step.enabled === false) return fallback;
  const v = step.params[key];
  return typeof v === "number" ? v : fallback;
}

/** Return boolean param from a step, with a fallback. */
function stepBool(steps: ReactStepConfig[], id: string, key: string, fallback: boolean): boolean {
  const step = getStepConfig(steps, id);
  if (!step || step.enabled === false) return fallback;
  const v = step.params[key];
  return typeof v === "boolean" ? v : fallback;
}

/** Is a given step enabled? Defaults to true. */
function stepEnabled(steps: ReactStepConfig[], id: string): boolean {
  const step = steps.find((s) => s.id === id);
  return step?.enabled !== false;
}
import { executeTool } from "../execute.ts";
import { parseToolCallsFromAssistant, normalizeToolName } from "../parser.ts";
import {
  buildCorrectionPrompt,
  logReasoningStep,
  reflectOnStepWithLLM,
  selectNextStep,
  type PlanStep,
} from "../agent-reasoning.ts";
import { withRetry } from "../model-coordinator.ts";
import { emitStage, resolveStageModel } from "./stages.ts";
import type { AgentLoopOpts, ChatTurn, DocumentWorkflowState, ReActLoopArgs, ReactDecisionSummary } from "./types.ts";
import { classifyRecoveryError } from "../recovery.ts";
import { documentStageFromArtifact, inferDocumentType } from "./document-workflow.ts";
import { type FreshnessFollowUp } from "./context-control.ts";
import { autoFixAfterTools, createAutoFixState, getDirtyFiles, FILE_MODIFYING_TOOLS, isAdvisoryVerificationResult } from "../auto-fix.ts";
import { gitAutoSnapshot } from "../checkpoint.ts";
import { PARALLEL_SAFE_TOOLS } from "../enhanced-tools.ts";
import { formatBlockerReport } from "../tools/misc.ts";
import { isReadonlyBash } from "../terminal.ts";
import type { ToolResultMetadata } from "../tools/types.ts";
import {
  applyTaskEvent,
  createTaskRunState,
  finalizeTaskSuccess,
  restoreTaskRunState,
  taskRunMetricsSnapshot,
  taskRunPhaseLabel,
  taskRunTotalDurationMs,
  type TaskRunState,
} from "../../task-run.ts";
import {
  selectNextPendingTask,
  taskProgress,
  classifyPlanKind,
  extractTitle,
  isPlanPath,
  type TaskEvidence,
  type TaskItem,
} from "../../plans.ts";
import { MemoryManager } from "../memory.ts";

/**
 * Find the closest known tool name via simple edit-distance so we can give
 * the model a concrete suggestion instead of dumping the full tool list.
 */
function findClosestToolName(candidate: string, known: Set<string>): string | null {
  let best = null as string | null;
  let bestDist = Infinity;
  const lower = candidate.toLowerCase();
  for (const name of known) {
    // Prefer exact match on known aliases
    if (lower === name.toLowerCase()) return name;
    const dist = levenshtein(lower, name.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  // Only suggest when it's a plausible typo, not a completely different name
  return bestDist <= 3 ? best : null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! : 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

// ── ReAct Loop (Enhanced Tool-Calling Stage) ───────────────

/** Max consecutive iterations with identical tool-call signatures (fed to termination). */
const MAX_REPEAT_TOOL_CALLS = 3;
/** Hard cap on total tool invocations across the entire loop (fed to termination). */
const MAX_TOTAL_TOOL_CALLS = 100;
const MAX_TOOL_HISTORY_CHARS = 4 * 1024;
/** Max consecutive iterations where the model produces ONLY read-only tool calls (no text content).
 *  This catches infinite exploration/browsing loops where the model calls list_dir/read_file
 *  with different paths each time, evading the fingerprint-based repeat detection. */
const MAX_CONSECUTIVE_READONLY_ITERS = 6;
/** Soft transition threshold: when consecutive read-only iterations reach this
 *  count, inject a nudge pushing the model from exploration to implementation.
 *  Set to half the hard cap — gives the model a warning before checkTermination.
 *  This directly addresses the "总中断" bug where the agent keeps exploring
 *  without transitioning to implementation. */
const READONLY_TRANSITION_THRESHOLD = 3;
const CASE_INSENSITIVE_PATHS = platform() === "win32";

/** Read-only tool names that indicate exploration/browsing (not productive output). */
const READONLY_TOOLS = new Set([
  "list_dir", "read_file", "read_symbol", "read_outline", "grep", "search_code", "search_symbols", "repo_map", "web_search", "web_fetch",
  "lsp_go_to_definition", "lsp_find_references", "lsp_hover",
  "lsp_document_symbols", "lsp_workspace_symbols", "lsp_diagnostics",
  "lsp_code_actions", "git_status", "semantic_diff", "project_deps",
]);

/** File-modifying tool names (used to push user-visible action summaries to the conversation stream, solving the silent-execution problem). */
const USER_FACING_WRITE_TOOLS = new Set(["save_plan", "write_file", "apply_patch"]);
const READ_INVALIDATING_TOOLS = new Set(["write_file", "apply_patch", "append_file", "replace_in_file"]);

/**
 * Synthesize a one-line user-visible summary from a file-modifying tool's result.
 * Only generated on success; returns null when no summary is needed (read-only tools or failures).
 */
function summarizeToolActionForUser(
  name: string,
  result: { ok: boolean; output: string },
): string | null {
  if (!result.ok || !USER_FACING_WRITE_TOOLS.has(name)) return null;
  const out = result.output ?? "";
  if (name === "save_plan") {
    const p = out.replace(/^Saved plan:\s*/i, "").trim();
    return `Plan document saved${p ? `: ${p}` : ""}. Review it in the plan panel, then approve to switch to Agent mode for execution.`;
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

function hasVerifiedEvidence(item: TaskEvidence): boolean {
  return Boolean(
    (item.kind ?? "source") === "source" &&
    item.path &&
    item.excerpt &&
    Number.isInteger(item.startLine) && item.startLine! > 0 &&
    Number.isInteger(item.endLine) && item.endLine! >= item.startLine! &&
    Boolean(item.sourceHash),
  );
}

type EvidenceExcerptCapture =
  | { excerpt: string }
  | { error: string };

function formatVerifiedEvidence(items: readonly TaskEvidence[]): string {
  return [
    "Verified source evidence retained:",
    ...items.map((item) => {
      const source = [
        item.path ?? "unknown file",
        item.symbol ? `#${item.symbol}` : "",
        `L${item.startLine ?? "?"}${item.endLine !== item.startLine ? `-${item.endLine ?? "?"}` : ""}`,
      ].filter(Boolean).join(" ");
      return [
        `- [${item.needId}] ${item.summary}`,
        `  Source: ${source}`,
        "```",
        item.excerpt ?? "",
        "```",
      ].join("\n");
    }),
  ].join("\n");
}

async function captureVerifiedEvidenceExcerpt(
  workspaceRoot: string,
  canonicalPath: string,
  startLine: number,
  endLine: number,
  expectedVersion: string,
  workflow: AgentLoopOpts["workflow"],
): Promise<EvidenceExcerptCapture> {
  try {
    const workspace = resolve(workspaceRoot);
    const absolute = resolve(workspace, canonicalPath);
    const workspaceRelative = relative(workspace, absolute);
    if (
      workspaceRelative === "" ||
      workspaceRelative.startsWith("..") ||
      resolve(workspace, workspaceRelative) !== absolute
    ) {
      return { error: "the cited path is outside the workspace" };
    }

    const fileStat = await stat(absolute);
    const currentVersion = `${fileStat.size}:${fileStat.mtimeMs}`;
    if (currentVersion !== expectedVersion) {
      return { error: "the cited file changed after it was read" };
    }
    const text = await readFile(absolute, "utf8");

    const sourceLines = text.split(/\r?\n/);
    if (startLine < 1 || endLine < startLine || endLine > sourceLines.length) {
      return { error: "the cited range is outside the current file" };
    }

    const selectedLines = sourceLines.slice(startLine - 1, endLine);
    let visibleLines = selectedLines;
    if (isRedactionEnabled(workflow)) {
      const redacted = redactSecrets(selectedLines.join("\n"), canonicalPath, {
        sensitiveFiles: workflow.secrets?.sensitiveFiles,
        patterns: workflow.secrets?.patterns,
      });
      visibleLines = redacted.text.split("\n");
      if (visibleLines.length !== selectedLines.length) {
        visibleLines = selectedLines.map((line) => redactSecrets(line, canonicalPath, {
          sensitiveFiles: workflow.secrets?.sensitiveFiles,
          patterns: workflow.secrets?.patterns,
        }).text);
      }
    }

    const excerpt = formatWithLines(visibleLines.join("\n"), startLine);
    console.log(
      `[evidence 保存] ${canonicalPath} L${startLine}-${endLine}, 片段 ${excerpt.length} 字符`,
    );
    return { excerpt };
  } catch {
    return { error: "the cited file could not be read for evidence retention" };
  }
}

function satisfiedInformationNeedIds(task: TaskItem): Set<string> {
  return new Set(task.evidence.filter(hasVerifiedEvidence).map((item) => item.needId));
}

function pendingInformationNeeds(task: TaskItem): string[] {
  const satisfied = satisfiedInformationNeedIds(task);
  return task.informationNeeds.filter((need) => !satisfied.has(need.id)).map((need) => need.id);
}

function informationNeedMatchesPath(question: string, path: string): boolean {
  const q = question.replace(/\\/g, "/").toLowerCase();
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (!p) return false;
  if (q.includes(p)) return true;
  const base = p.split("/").pop() ?? "";
  return base.length >= 3 && q.includes(base);
}

function isExplorationComplete(task: TaskItem): boolean {
  const satisfied = satisfiedInformationNeedIds(task);
  return task.informationNeeds.length > 0 &&
    task.informationNeeds.every((need) => satisfied.has(need.id)) &&
    task.stopReadingWhen.every((criterion) =>
      criterion.requiredEvidenceIds.length > 0 && criterion.requiredEvidenceIds.every((needId) => satisfied.has(needId)),
    );
}

function formatPackedHistory(task: TaskItem): string {
  const text = task.relevantHistory?.trim() ?? "";
  return text
    ? `### Reusable history (from task decomposition — do not re-read this content)\n${text}`
    : "";
}

function formatInformationNeedsList(task: TaskItem): string {
  const pending = new Set(pendingInformationNeeds(task));
  const lines = task.informationNeeds.map((need) => {
    const extras = [
      need.source ? `source=${need.source}` : "",
      need.priority ? `priority=${need.priority}` : "",
      need.fallback ? `fallback=${need.fallback}` : "",
    ].filter(Boolean);
    return `- [${pending.has(need.id) ? "unmet" : "met"}] ${need.id}: ${need.question}${extras.length ? ` (${extras.join(", ")})` : ""}`;
  });
  return `Information needs:\n${lines.join("\n")}`;
}

function formatStopReadingWhen(task: TaskItem): string {
  if (!task.stopReadingWhen.length) return "";
  const satisfied = satisfiedInformationNeedIds(task);
  return `Stop-exploration criteria:\n${task.stopReadingWhen.map((criterion) =>
    `- [${criterion.requiredEvidenceIds.every((id) => satisfied.has(id)) ? "met" : "unmet"}] ${criterion.condition}`
  ).join("\n")}`;
}

function formatConfirmedEvidence(task: TaskItem): string {
  const evidence = task.evidence.filter(hasVerifiedEvidence).map((item) => {
    const source = [
      item.path,
      item.symbol ? `#${item.symbol}` : "",
      `L${item.startLine}${item.endLine !== item.startLine ? `-${item.endLine}` : ""}`,
    ].filter(Boolean).join(" ");
    return [
      `- [${item.needId}] ${item.summary} (${source})`,
      "  Retained excerpt:",
      "  ```",
      item.excerpt ?? "",
      "  ```",
    ].join("\n");
  });
  return evidence.length ? `Confirmed refined evidence:\n${evidence.join("\n")}` : "";
}

function explorationStatusGuidance(task: TaskItem, whenNoNeeds: string): string {
  if (!task.informationNeeds.length) return whenNoNeeds;
  return isExplorationComplete(task)
    ? "All information needs and stop-exploration criteria are satisfied. Do not call read_file, grep, search_symbols, or other exploration tools; only edit, verify, report a blocker, or give the final result."
    : "Call exploration tools only to fill the unmet information needs or stop-exploration criteria above. Whole-file reads are only for files under 10KB. Files 10KB or larger: use read_outline first, then read_symbol or a bounded read_file(offset+limit); never request the complete file. Successful reads stay in this turn's context; continue with an edit, verification, blocker, or final result when the needs are met.";
}

function formatCurrentTaskContext(task: TaskItem): string {
  return [
    "## **Current Task (in progress, prioritize; move to the next only after completion)**",
    "### Execution flow",
    "1. Read the <task> block above. Note ID / Description / Information needs / Stop-exploration criteria / Confirmed refined evidence.",
    "2. Call tools as needed:",
    "   - Exploration tools (read_file / grep / search_symbols / lsp_* / repo_map / read_symbol / read_outline, etc.) — use them only to fill unmet needs. Whole-file read_file is only for files under 10KB. Files 10KB or larger MUST call read_outline first; then use read_symbol only for one unique symbol, or read_file with both offset and limit from the outline's line range. Never retry a rejected large-file read without a range or fall back to reading the whole file. Successful read_file/read_symbol results stay in this turn's context automatically.",
    "   - Implementation tools (apply_patch / write_file / append_file / type_check / bash) — use them only after every informationNeed and every stopReadingWhen.requiredEvidenceId is met.",
    "3. Termination — stop calling tools and produce the final answer only when ALL of the following hold:",
    "   a. The goal is achieved;",
    "   b. Every Information need is met (Confirmed refined evidence covers every need-id);",
    "   c. Every Stop-exploration criteria requiredEvidenceId is met.",
    "   Local hard-validation enforces this (isExplorationComplete) — no second LLM evaluation is required.",
    "4. Tool failure: read the error and correct it first; if the same action fails twice, switch path or switch tool.",
    `ID: ${task.id}`,
    `Description: ${task.description}`,
    task.acceptance ? `Acceptance criteria: ${task.acceptance}` : "",
    formatPackedHistory(task),
    task.informationNeeds.length ? formatInformationNeedsList(task) : "",
    formatStopReadingWhen(task),
    formatConfirmedEvidence(task),
    explorationStatusGuidance(
      task,
      "Use tools to execute this task. Report the result in one sentence when done; do not keep calling tools.",
    ),
  ].filter(Boolean).join("\n");
}

function formatTurnInformationContext(task: TaskItem): string {
  return [
    "## **This Turn's Information Needs (in progress, prioritize; not persisted across user messages)**",
    "These needs come from this turn's task_decompose. Investigate only unmet items; successful read_file/read_symbol results stay in this turn's context automatically.",
    `This turn's goal: ${task.description}`,
    formatPackedHistory(task),
    formatInformationNeedsList(task),
    formatStopReadingWhen(task),
    formatConfirmedEvidence(task),
    explorationStatusGuidance(task, ""),
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

function summarizeToolResultForHistory(
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
  if (!result.ok) return `${call.name} failed: ${output.slice(0, MAX_TOOL_HISTORY_CHARS)}`;
  if (READONLY_TOOLS.has(call.name)) {
    return `${call.name} completed: ${output.slice(0, MAX_TOOL_HISTORY_CHARS)}${output.length > MAX_TOOL_HISTORY_CHARS ? " …[truncated]" : ""}`;
  }
  return `${call.name} completed: ${output.slice(0, MAX_TOOL_HISTORY_CHARS)}${output.length > MAX_TOOL_HISTORY_CHARS ? " …[summary truncated]" : ""}`;
}

/**
 * 从LLM回复中自动提取文件片段引用
 *
 * 解析回复中的行号引用（如 "第10-20行"、"lines 10-20"、"L10-20" 等），
 * 从已读取的文件内容中提取对应片段，自动保存为证据。
 *
 * @param content LLM回复的文本内容
 * @param rawReadToolMessages 本轮已读取的文件工具消息
 * @param workspaceRoot 工作区根目录
 * @returns 提取的证据列表
 */
async function extractExcerptsFromAssistantReply(
  content: string,
  rawReadToolMessages: readonly ChatMessage[],
  workspaceRoot: string,
): Promise<Array<{ path: string; startLine: number; endLine: number; excerpt: string; summary: string }>> {
  const excerpts: Array<{ path: string; startLine: number; endLine: number; excerpt: string; summary: string }> = [];

  // 匹配行号引用的正则表达式模式
  // 支持格式：
  // - "第10-20行"、"第10到20行"、"第10~20行"
  // - "lines 10-20"、"line 10-20"、"L10-20"、"L10~20"
  // - "10-20行"、"10到20行"
  // - "src/file.ts:10-20"、"src/file.ts#L10-20"
  // - 带文件名的引用："file.ts 的第10-20行"、"file.ts lines 10-20"
  const lineRefPatterns = [
    // 带文件名的引用：file.ts:10-20 或 file.ts#L10-20
    /(?:^|[\s`"'])([^\s`"':#]+(?:\.[a-zA-Z]+))[:#]L?(\d+)(?:\s*[-–—~到至]\s*(\d+))?/gim,
    // "file.ts 的第10-20行" 或 "file.ts lines 10-20"
    /([^\s`"':#]+\.[a-zA-Z]+)\s*(?:的)?(?:第|lines?\s*|L\s*)(\d+)(?:\s*[-–—~到至]\s*(\d+))?/gim,
    // 独立的行号引用："第10-20行"、"lines 10-20"、"L10-20"
    /(?:第|lines?\s*|L\s*)(\d+)(?:\s*[-–—~到至]\s*(\d+))?行?/gim,
  ];

  // 从工具消息中解析已读取的文件内容
  const fileContents = new Map<string, { path: string; startLine: number; endLine: number; lines: string[] }>();
  for (const msg of rawReadToolMessages) {
    if (msg.name === "read_file" && msg.content) {
      // 尝试从content中解析文件路径和行号
      const pathMatch = msg.content.match(/^(?:Read|Failed to read)\s+(.+?)\s+\(lines?\s+(\d+)-(\d+)\s+of\s+(\d+)\)/m);
      if (pathMatch) {
        const filePath = pathMatch[1]!;
        const startLine = parseInt(pathMatch[2]!, 10);
        const endLine = parseInt(pathMatch[3]!, 10);
        // 从content中提取实际的文件内容（跳过第一行摘要）
        const contentLines = msg.content.split('\n');
        if (contentLines.length > 1) {
          const fileKey = canonicalReadPath(workspaceRoot, filePath);
          fileContents.set(fileKey, {
            path: filePath,
            startLine,
            endLine,
            lines: contentLines.slice(1), // 跳过第一行摘要
          });
        }
      }
    }
  }

  // 解析所有行号引用
  const extractedRefs = new Set<string>(); // 去重

  for (const pattern of lineRefPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      let filePath: string | undefined;
      let startLine: number;
      let endLine: number;

      if (match.length === 4) {
        // 带文件名的引用
        filePath = match[1];
        startLine = parseInt(match[2]!, 10);
        endLine = match[3] ? parseInt(match[3], 10) : startLine;
      } else if (match.length === 3) {
        // 独立的行号引用
        startLine = parseInt(match[1]!, 10);
        endLine = match[2] ? parseInt(match[2], 10) : startLine;
      } else {
        continue;
      }

      // 验证行号有效性
      if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) {
        continue;
      }

      // 限制提取范围，避免过大
      if (endLine - startLine > 100) {
        endLine = startLine + 100;
      }

      // 查找匹配的文件内容
      let matchedFile: { path: string; startLine: number; endLine: number; lines: string[] } | undefined;

      if (filePath) {
        // 有文件名，尝试匹配
        const canonicalPath = canonicalReadPath(workspaceRoot, filePath);
        matchedFile = fileContents.get(canonicalPath);

        // 如果精确匹配失败，尝试模糊匹配
        if (!matchedFile) {
          const fileEntries = Array.from(fileContents.entries());
          for (const [key, value] of fileEntries) {
            if (key.endsWith(filePath!) || filePath!.endsWith(key.split('/').pop()!)) {
              matchedFile = value;
              break;
            }
          }
        }
      } else {
        // 没有文件名，使用唯一已读取的文件
        if (fileContents.size === 1) {
          const fileValues = Array.from(fileContents.values());
          matchedFile = fileValues[0];
        }
      }

      if (!matchedFile) {
        continue;
      }

      // 检查请求的行范围是否在已读取的范围内
      const requestedStart = startLine;
      const requestedEnd = endLine;
      const fileStart = matchedFile.startLine;
      const fileEnd = matchedFile.endLine;

      // 如果请求的范围完全在已读取范围内
      if (requestedStart >= fileStart && requestedEnd <= fileEnd) {
        const refKey = `${matchedFile.path}:${requestedStart}-${requestedEnd}`;
        if (extractedRefs.has(refKey)) {
          continue; // 去重
        }
        extractedRefs.add(refKey);

        // 计算在lines数组中的索引
        const startIdx = requestedStart - fileStart;
        const endIdx = requestedEnd - fileStart;
        const excerptLines = matchedFile.lines.slice(startIdx, endIdx + 1);

        if (excerptLines.length > 0) {
          excerpts.push({
            path: matchedFile.path,
            startLine: requestedStart,
            endLine: requestedEnd,
            excerpt: excerptLines.join('\n'),
            summary: `Extracted from ${matchedFile.path} lines ${requestedStart}-${requestedEnd}`,
          });
        }
      }
    }
  }

  return excerpts;
}

/**
 * 从LLM回复中自动提取证据并保存到历史记录
 *
 * 当LLM返回纯文本回复（没有工具调用）时，自动解析其中对文件行号的引用，
 * 从已读取的文件内容中提取对应片段，保存为证据到历史记录。
 *
 * @param content LLM回复的文本内容
 * @param rawReadToolMessages 本轮已读取的文件工具消息
 * @param history 历史记录数组
 * @param workspaceRoot 工作区根目录
 * @param memory 内存管理器
 * @returns 是否成功提取并保存了证据
 */
async function autoExtractAndSaveEvidence(
  content: string,
  rawReadToolMessages: readonly ChatMessage[],
  history: ChatTurn[],
  workspaceRoot: string,
  memory: MemoryManager,
): Promise<boolean> {
  // 只处理非空回复
  if (!content.trim()) {
    return false;
  }

  // 检查是否有已读取的文件
  if (rawReadToolMessages.length === 0) {
    return false;
  }

  try {
    // 提取片段
    const excerpts = await extractExcerptsFromAssistantReply(content, rawReadToolMessages, workspaceRoot);

    if (excerpts.length === 0) {
      return false;
    }

    // 格式化为证据格式并保存到历史
    const evidenceItems = excerpts.map((excerpt) => ({
      needId: "auto_extracted",
      summary: excerpt.summary,
      excerpt: excerpt.excerpt,
      path: excerpt.path,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
    }));

    // 保存到历史记录
    history.push({
      role: "tool",
      id: `auto_extract_evidence-${Date.now().toString(36)}`,
      content: formatVerifiedEvidence(evidenceItems),
      toolName: "auto_extract_evidence",
    });

    // 记录到内存
    memory.addToolOutput(
      "auto_extract_evidence",
      `Auto-extracted ${excerpts.length} excerpt(s) from assistant reply: ${excerpts.map((e) => `${e.path}:${e.startLine}-${e.endLine}`).join(", ")}`,
    );

    return true;
  } catch (error) {
    // 自动提取失败不应影响主流程
    console.warn("[auto-extract] Failed to extract excerpts from assistant reply:", error);
    return false;
  }
}

interface DocumentDeliverable {
  name: string;
  path: string;
  content: string;
}

/**
 * Plan 模式下检测工具调用是否写入了文档交付物（PRD/TDD/BRD/HLD/LLD 等）。
 * 普通代码文件或可批准的执行计划不触发。保留相对路径和内容，以便为已识别
 * 的 PRD/TDD 建立可恢复的文档工作流状态。
 */
function detectDocumentDeliverable(
  name: string,
  args?: Record<string, unknown>,
): DocumentDeliverable | null {
  let relPath = "";
  let title = "";
  let content = "";
  if (name === "write_file") {
    relPath = String(args?.path ?? "");
    content = String(args?.content ?? "");
  } else if (name === "save_plan") {
    const fn = String(args?.filename ?? "").trim();
    title = String(args?.title ?? "");
    content = String(args?.content ?? "");
    const base = upath.basename(fn);
    relPath = base ? `.owncoder/plans/${base}` : "";
  } else {
    return null;
  }
  const normalizedPath = upath.normalize(relPath).replace(/^\.\//, "");
  const isRootMarkdown = !normalizedPath.includes("/") && normalizedPath.toLowerCase().endsWith(".md");
  const isDocsMarkdown = normalizedPath.toLowerCase().startsWith("docs/") && normalizedPath.toLowerCase().endsWith(".md");
  if (!normalizedPath || (!isPlanPath(normalizedPath) && !isRootMarkdown && !isDocsMarkdown)) return null;
  const filename = normalizedPath.split("/").pop() ?? normalizedPath;
  const t = title || extractTitle(content, filename);
  return classifyPlanKind(filename, t) === "document"
    ? { name: filename, path: normalizedPath, content }
    : null;
}

/** 从 history 末尾找最近一条非空 assistant 文本（用于空响应时回填 lastAssistant）。 */
function lastAssistantSummaryFromHistory(history: ChatTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.role === "assistant" && h.content.trim()) return h.content;
  }
  return null;
}

function canonicalReadPath(workspaceRoot: string, inputPath: string): string {
  const rel = upath.normalize(relative(workspaceRoot, resolve(workspaceRoot, inputPath || ".")))
    .replace(/^\.\//, "");
  return CASE_INSENSITIVE_PATHS ? rel.toLowerCase() : rel;
}

async function sourceVersion(workspaceRoot: string, canonicalPath: string): Promise<string | null> {
  try {
    const workspace = resolve(workspaceRoot);
    const absolute = resolve(workspace, canonicalPath);
    const rel = relative(workspace, absolute);
    if (rel === "" || rel.startsWith("..") || resolve(workspace, rel) !== absolute) return null;
    const fileStat = await stat(absolute);
    return `${fileStat.size}:${fileStat.mtimeMs}`;
  } catch {
    return null;
  }
}

export async function runReActLoop(args: ReActLoopArgs): Promise<{
  lastAssistant: string;
  aborted: boolean;
  /** A document deliverable was written and requires user confirmation. */
  awaitingUserConfirmation?: boolean;
  /**
   * The model called `report_blocker`: the remaining work belongs to the user.
   * A successful terminal state, distinct from `aborted`. Suppresses every
   * autonomous follow-up (verify / post_verify / auto-fix / task auto-advance)
   * while still allowing changes made before the handoff to be presented.
   */
  handoffRequested?: boolean;
  /** Defined only when this turn changes the persisted document workflow. */
  documentWorkflow?: DocumentWorkflowState | null;
  blocked?: boolean;
  blockedReason?: string;
  correctionCount: number;
  /** 本轮结束时的统一任务运行状态。 */
  taskRunState?: TaskRunState | null;
  /** 成功门禁拒绝时为 true。 */
  successRejected?: boolean;
  decisionSummaries?: ReactDecisionSummary[];
}> {
  const {
    opts, model, messages, history, toolsFinal, toolCtx, maxIter, stageId,
    reasoningTrace, memory, tracer, plan, transientInformationTask, contextControl,
    maxRepeatToolCalls: _mrt,
    maxTotalToolCalls: _mttc,
    maxConsecutiveReadonlyIters: _mcri,
    // Legacy stuck-detect knobs kept on ReActLoopArgs for API compatibility;
    // hard force-stop now lives in checkTermination, so they are unused here.
    maxSameFileReads: _msfr,
    maxPagesPerFile: _mpf,
    maxRedundantRangesPerFile: _mrr,

  } = args;
  void _msfr;
  void _mpf;
  void _mrr;

  // ── Resolve reactSteps config from node params ──────────────────────────────
  const reactSteps: ReactStepConfig[] = args.reactSteps ?? defaultReactSteps();

  // ── Derive loop thresholds from reactSteps (override with legacy args if present) ──
  const maxRepeatToolCalls =
    _mrt ?? stepNum(reactSteps, "stuck_detect", "maxRepeat", MAX_REPEAT_TOOL_CALLS);
  const maxConsecutiveReadonlyIters =
    _mcri ?? stepNum(reactSteps, "stuck_detect", "maxReadonlyIters", MAX_CONSECUTIVE_READONLY_ITERS);
  const maxTotalToolCalls =
    _mttc ?? stepNum(reactSteps, "tool_cap", "maxTotal", MAX_TOTAL_TOOL_CALLS);
  const llmMaxRetries = stepNum(reactSteps, "llm_call", "maxRetries", 2);
  const stuckDetectEnabled = stepEnabled(reactSteps, "stuck_detect");
  const gitSnapshotEnabled = stepEnabled(reactSteps, "git_snapshot");
  let gitSnapshotWarned = false; // warn at most once per turn
  const toolExecParallel = stepBool(reactSteps, "tool_exec", "parallel", true);
  const docDeliverableEnabled = stepEnabled(reactSteps, "doc_deliverable");
  const autoFixEnabled = stepEnabled(reactSteps, "auto_fix");
  const autoFixMaxAttempts = stepNum(reactSteps, "auto_fix", "maxAttempts", 3);
  let lastAssistant = "";
  let correctionCount = args.correctionCount;
  let currentStep: PlanStep | null = plan ? selectNextStep(plan) : null;
  const decisionSummaries: ReactDecisionSummary[] = [];
  const recordDecision = (summary: ReactDecisionSummary): void => {
    decisionSummaries.push(summary);
    opts.onEvent?.({ type: "decision_summary", summary });
  };

  // ── 弱模型容错：工具执行后模型返回纯文本（无新工具调用）时的 nudge 计数 ──
  // 某些模型（如 Gemini Flash 2.5）在工具调用后会输出一段文本总结而不继续调用工具，
  // 导致循环提前终止。此计数器在工具执行后注入一次 nudge 引导继续，超过上限才退出。
  let postToolTextNudgeCount = 0;
  const maxPostToolTextNudges = 2;
  // 上一轮是否执行了工具调用（用于判断本轮是否为"工具执行后的纯文本响应"）
  let prevIterHadToolCalls = false;

  // ── Unified task execution state ──
  let taskRunState: TaskRunState | null = null;
  if (args.opts.mode === "agent") {
    const restored = restoreTaskRunState(args.opts.taskRunState, args.opts.sessionId);
    taskRunState = restored
      ? { ...restored, maxRepairAttempts: autoFixMaxAttempts }
      : createTaskRunState(args.opts.sessionId, autoFixMaxAttempts);
  }
  const emitTaskRunState = (): void => {
    if (!taskRunState) return;
    const metrics = taskRunMetricsSnapshot(taskRunState.metrics);
    opts.onEvent?.({
      type: "task_run_state",
      taskId: taskRunState.taskId,
      phase: taskRunState.phase,
      verificationStatus: taskRunState.verification.status,
      verificationPassed: taskRunState.verification.passed,
      verificationSummary: taskRunState.verification.summary,
      repairAttempts: taskRunState.repairAttempts,
      maxRepairAttempts: taskRunState.maxRepairAttempts,
      label: taskRunPhaseLabel(taskRunState.phase),
      metrics,
      totalDurationMs: taskRunTotalDurationMs(taskRunState.metrics),
    });
  };
  const applyRunEvent = (event: Parameters<typeof applyTaskEvent>[1]): void => {
    if (taskRunState) {
      taskRunState = applyTaskEvent(taskRunState, event);
      emitTaskRunState();
    }
  };
  applyRunEvent({ type: "phase_changed", taskId: args.opts.sessionId, phase: "executing" });
  const autoFixState = createAutoFixState();
  /** 是否在本轮执行过会触发验证的文件改动（用于成功门禁）。 */
  let hadFileModifyingTools = false;

  type ReActReturn = {
    lastAssistant: string;
    aborted: boolean;
    awaitingUserConfirmation?: boolean;
    handoffRequested?: boolean;
    documentWorkflow?: DocumentWorkflowState | null;
    blocked?: boolean;
    blockedReason?: string;
    correctionCount: number;
    taskRunState?: TaskRunState | null;
    successRejected?: boolean;
    decisionSummaries?: ReactDecisionSummary[];
  };

  const withRunState = (result: Omit<ReActReturn, "taskRunState">): ReActReturn => ({
    ...result,
    taskRunState,
    decisionSummaries,
  });

  /** 最终成功路径：必须通过 canReportSuccess / sealTaskRunSuccess 门禁。 */
  const finalizeSuccess = (
    result: Omit<ReActReturn, "taskRunState" | "successRejected" | "blocked" | "blockedReason"> & {
      blocked?: boolean;
      blockedReason?: string;
    },
  ): ReActReturn => {
    const originalAssistant = result.lastAssistant ?? "";
    const finalized = finalizeTaskSuccess({
      taskRunState,
      result,
      requiresVerification: hadFileModifyingTools || autoFixState.hasUnresolvedErrors,
    });
    taskRunState = finalized.taskRunState;
    if (taskRunState) emitTaskRunState();
    const out = finalized.result;
    // 门禁失败：短提示只进 LLM 正文（history + 流式 delta），不发 warning 顶部条。
    if (out.successRejected && out.lastAssistant && out.lastAssistant !== originalAssistant) {
      const last = history[history.length - 1];
      if (last?.role === "assistant") {
        last.content = out.lastAssistant;
      } else {
        history.push({ role: "assistant", content: out.lastAssistant });
      }
      const suffix = originalAssistant && out.lastAssistant.startsWith(originalAssistant)
        ? out.lastAssistant.slice(originalAssistant.length)
        : out.lastAssistant;
      if (suffix.trim()) {
        opts.onEvent?.({ type: "assistant_delta", text: suffix });
      }
    }
    return withRunState(out);
  };

  /** 非成功终止（中止/阻塞/交还）时同步 phase。 */
  const finalizeTerminal = (
    result: Omit<ReActReturn, "taskRunState">,
    phase: "failed" | "blocked" | "interrupted",
  ): ReActReturn => {
    if (taskRunState) {
      const reason =
        result.blockedReason?.trim() ||
        (phase === "interrupted"
          ? "interrupted"
          : phase === "blocked"
            ? "blocked"
            : "failed");
      applyRunEvent({
        type: "phase_changed",
        taskId: args.opts.sessionId,
        phase,
        reason,
      });
    }
    return withRunState(result);
  };

  // ── Task-driven state (需要在 termination config 之前) ──
  const taskDriven = opts.mode === "agent" && Array.isArray(opts.activeTasks) && opts.activeTasks.length > 0;
  let tasks: TaskItem[] = taskDriven ? opts.activeTasks!.map((t) => ({ ...t })) : [];
  let currentTask: TaskItem | null = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // New Termination System (零 nudge, 3 层终止) - 完全集成
  // ═══════════════════════════════════════════════════════════════════════════

  const terminationConfig: TerminationConfig = createTerminationConfig({
    maxIterations: maxIter,
    maxTotalToolCalls: maxTotalToolCalls,
    maxSameToolRepeat: maxRepeatToolCalls,
    enableOutputSimilarityCheck: true,
    maxConsecutiveTextOnly: 2,
    enableBudgetLimits: true,
    enableStuckDetection: stuckDetectEnabled,
    enableTaskValidation: true,
  });

  const loopState: LoopState = createLoopState(currentTask || undefined);

  // Soft exploration→implementation nudge only. Hard stuck/tool-cap stops live
  // in checkTermination; tool errors never force-block the loop here.
  let totalToolCalls = 0;       // total tool invocations across the loop (logging)
  let consecutiveReadonlyIters = 0; // consecutive iterations with ONLY read-only tools
  /** Raw read messages are used for same-turn excerpt extraction only. */
  const rawReadToolMessages: ChatMessage[] = [];

  const emitFreshnessFollowUp = (update: FreshnessFollowUp | null): void => {
    if (!update || !contextControl?.telemetryEnabled) return;
    opts.onEvent?.({
      type: "minimum_context_read_follow_up",
      ...update,
    });
  };

  // ── Plan 模式文档交付物停止状态 ──
  // 写入 PRD/TDD 等文档交付物后置 true，停止后续自动生成，等待用户确认
  let documentDelivered = false;
  let deliveredDocName = "";
  let documentWorkflowUpdate: DocumentWorkflowState | null | undefined;

  // ── 交还用户（handoff）停止状态 ──
  // 模型调用 report_blocker 后置 true：剩余工作不属于 agent，本轮正常结束。
  // 这是成功终止，不是 aborted —— 但必须压制所有"继续推进"机制，否则模型会绕道
  // 去用别的手段达成同一个已被拦下的目标。
  let handoffRequested = false;
  let handoffReport = "";
  // 工具错误（含权限/用户决策类）一律写入 tool result 交回 LLM，不再强制 blocked。

  // ── Hard step-driver state (approved plan tasks in agent mode) ──
  // taskDriven, tasks, currentTask 已在上面定义
  const persistTaskUpdate = async (nextId: string | null): Promise<void> => {
    if (opts.onTaskUpdate) await opts.onTaskUpdate(tasks, nextId);
  };
  const invalidateStaleEvidence = async (task: TaskItem): Promise<boolean> => {
    const retained: TaskEvidence[] = [];
    for (const evidence of task.evidence) {
      if (
        !evidence.path ||
        !evidence.sourceHash ||
        !evidence.excerpt ||
        !Number.isInteger(evidence.startLine) ||
        !Number.isInteger(evidence.endLine)
      ) continue;
      if (await sourceVersion(toolCtx.workspaceRoot, evidence.path) !== evidence.sourceHash) continue;
      const captured = await captureVerifiedEvidenceExcerpt(
        toolCtx.workspaceRoot,
        evidence.path,
        evidence.startLine!,
        evidence.endLine!,
        evidence.sourceHash,
        opts.workflow,
      );
      if ("excerpt" in captured && captured.excerpt === evidence.excerpt) {
        retained.push(evidence);
      }
    }
    if (retained.length === task.evidence.length) return false;
    task.evidence = retained;
    return true;
  };
  if (taskDriven) {
    const startId = opts.currentTaskId ?? tasks[0]?.id ?? null;
    const selected = startId ? tasks.find((t) => t.id === startId) : undefined;
    currentTask = selected && (selected.status === "pending" || selected.status === "in_progress")
      ? selected
      : selectNextPendingTask(tasks);
    if (currentTask) {
      await invalidateStaleEvidence(currentTask);
      currentTask.status = "in_progress";
      await persistTaskUpdate(currentTask.id);
    }
  }

  const turnInformationTask: TaskItem | null = !taskDriven ? (transientInformationTask ?? null) : null;
  const activeInformationTask = (): TaskItem | null => currentTask ?? turnInformationTask;
  const informationTasks = (): TaskItem[] =>
    turnInformationTask ? [...tasks, turnInformationTask] : tasks;
  const syncLoopTask = (): void => {
    loopState.currentTask = activeInformationTask() ?? undefined;
  };

  for (let i = 0; i < maxIter; i++) {
    // ═══════════════════════════════════════════════════════════════════════════
    // New Termination Check (在迭代开始时检查)
    // ═══════════════════════════════════════════════════════════════════════════
    if (i > 0) {
      const terminationResult = checkTermination(loopState, terminationConfig);
      if (terminationResult.shouldTerminate) {
        // Normal convergence (exploration-skip / consecutive similar outputs):
        // must never surface as "出错了 / Task may be incomplete".
        const normalConverged =
          terminationResult.metadata != null &&
          typeof terminationResult.metadata === "object" &&
          terminationResult.metadata.normalCompletion === true;
        const aborted = Boolean(terminationResult.aborted) && !normalConverged;

        writeEventLog({
          category: "react_loop",
          message: `ReAct loop terminated: ${terminationResult.reason}`,
          details: {
            stageId,
            iteration: i,
            reason: terminationResult.reason,
            aborted,
            metadata: terminationResult.metadata,
          },
        });

        logReasoningStep(reasoningTrace, {
          type: "observation",
          content: `Loop terminated: ${terminationResult.reason}`,
          timestamp: Date.now(),
        });

        // ═══════════════════════════════════════════════════════════════════════════
        // Telemetry: 收集终止指标（仅开发环境）
        // ═══════════════════════════════════════════════════════════════════════════
        const isDev = process.env.NODE_ENV === "development" || process.env.OWNCODER_DEV === "true";

        if (isDev) {
          const metricsPayload = {
            type: "loop_termination_metrics" as const,
            terminationReason: terminationResult.reason,
            isAborted: aborted,
            iterations: i,
            totalToolCalls: loopState.totalToolCalls,
            consecutiveSimilarOutputs: loopState.consecutiveSimilarOutputs,
            consecutiveTextOnlyTurns: loopState.consecutiveTextOnlyTurns,
            metadata: terminationResult.metadata,
          };

          // 发送遥测事件
          opts.onEvent?.(metricsPayload);

          // 记录到全局收集器
          getGlobalMetricsCollector().record({
            timestamp: Date.now(),
            sessionId: stageId,
            terminationReason: terminationResult.reason,
            isAborted: aborted,
            iterations: i,
            totalToolCalls: loopState.totalToolCalls,
            consecutiveSimilarOutputs: loopState.consecutiveSimilarOutputs,
            consecutiveTextOnlyTurns: loopState.consecutiveTextOnlyTurns,
            metadata: terminationResult.metadata,
          });
        }

        const finalResponse = terminationResult.lastAssistant || lastAssistant;

        // 根据终止原因设置不同的事件类型
        if (aborted) {
          opts.onEvent?.({
            type: "error",
            message: `Task may be incomplete: ${terminationResult.reason}`,
          });
        } else if (terminationResult.limitReached) {
          // 达到硬限制（迭代/工具调用/token/成本上限）而停止，非异常终止：
          // 任务可能未完成，向用户显示提示而非静默停止。
          opts.onEvent?.({
            type: "warning",
            message: `已达到${terminationResult.reason}，任务可能尚未完成。可在流水线设置中调高对应上限后重试。`,
          });
        }

        // 工具轮次不把模型文本推进 history。终止时若末条还不是这份报告，补写一次。
        // 相似输出终止时末条通常已是上一份近重复报告，不要再叠第二条。
        if (finalResponse.trim()) {
          const lastHist = history[history.length - 1];
          const lastIsSameReport =
            lastHist?.role === "assistant" && lastHist.content === finalResponse;
          const lastIsSimilarReport =
            loopState.consecutiveSimilarOutputs >= 1 &&
            lastHist?.role === "assistant" &&
            Boolean(lastHist.content?.trim());
          if (!lastIsSameReport && !lastIsSimilarReport) {
            history.push({ role: "assistant", content: finalResponse });
          }
        }

        return aborted
          ? finalizeTerminal({
              lastAssistant: finalResponse,
              aborted,
              correctionCount,
              documentWorkflow: documentWorkflowUpdate,
            }, "interrupted")
          : finalizeSuccess({
              lastAssistant: finalResponse,
              aborted,
              correctionCount,
              documentWorkflow: documentWorkflowUpdate,
            });
      }
    }

    if (opts.signal?.aborted) {
      writeEventLog({
        category: "abort",
        message: `ReAct loop 中止 (turn start, iteration ${i}/${maxIter})`,
        details: {
          stageId,
          iteration: i,
          maxIterations: maxIter,
          lastAssistantLen: lastAssistant.length,
        },
      });
      return finalizeTerminal({ lastAssistant, aborted: true, correctionCount }, "interrupted");
    }

    // Update working memory with current plan step
    if (currentStep) {
      currentStep.status = "in_progress";
      memory.working.activePlan!.currentStep = plan!.steps.indexOf(currentStep);
      memory.working.activePlan!.progress = `Executing step: ${currentStep.description}`;
    }

    // Earlier history is compacted before this loop into a separate LLM-generated
    // context message. Do not mutate `history` here: it is the source of truth
    // for the visible and persisted conversation.

    if (currentTask && await invalidateStaleEvidence(currentTask)) {
      await persistTaskUpdate(currentTask.id);
    }

    // ── Public decision summary (bounded; no private chain-of-thought) ──
    recordDecision({
      iteration: i,
      goal: currentTask?.description ?? currentStep?.description ?? opts.userMessage.slice(0, 200),
      action: "llm_decide",
      reasonSummary: currentTask ? "依据当前任务和已收集证据决定下一步" : "依据当前上下文决定下一步",
      expectedObservation: "获得工具结果或可验证的下一步响应",
      timestamp: Date.now(),
    });

    // ── LLM Call (with retry) ──
    const llmSpanId = tracer.startSpan(`llm_call_${i}`, "llm_call", {
      iteration: i,
      model: model.model,
    });

    // Import message tagging utilities for semantic wrapping
    const { tagCurrentTask } = await import("../message-tags.js");

    const informationTask = activeInformationTask();
    const currentTaskMsg: ChatMessage | null = currentTask
      ? { role: "system", content: tagCurrentTask(formatCurrentTaskContext(currentTask)) }
      : informationTask
        ? { role: "system", content: tagCurrentTask(formatTurnInformationContext(informationTask)) }
        : null;
    // Insert currentTaskMsg right after the system prompt (index 0) and before
    // the user's current input, so the order is: system → current task → user
    // input → history (last). History changes every turn and should stay at the
    // tail to preserve prompt-cache hits on the stable prefix.
    const messagesForCall = currentTaskMsg
      ? [messages[0], currentTaskMsg, ...messages.slice(1)]
      : messages;

    let response: Awaited<ReturnType<typeof chatCompletionStream>>;
    let currentTurnAccumulated = "";
    try {
      const { result, retries: llmRetries } = await withRetry(
        () => chatCompletionStream(model, messagesForCall, {
          tools: toolsFinal,
          signal: opts.signal,
          apiKey: opts.llmApiKey,
          purpose: `react_loop#${stageId}#${i}`,
          taskId: opts.sessionId,
          onDelta: (text: string) => { currentTurnAccumulated += text; opts.onEvent?.({ type: "assistant_delta", text }); },
          onThinkingDelta: (text: string) => opts.onEvent?.({ type: "thinking_delta", text }),
        }),
        { maxRetries: llmMaxRetries, baseDelay: 2000, signal: opts.signal },
        (attempt, err, delay) => {
          tracer.addEvent(llmSpanId, "retry", {
            attempt,
            error: err.message,
            delayMs: delay,
          });
        },
      );
      response = result as typeof response;
      tracer.endSpan(llmSpanId, "ok");
      applyRunEvent({
        type: "observability",
        taskId: args.opts.sessionId,
        modelSamples: 1,
        retries: llmRetries > 0 ? llmRetries : 0,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      tracer.recordError(llmSpanId, msg);
      if (opts.signal?.aborted) {
        writeEventLog({
          category: "abort",
          message: `ReAct loop LLM 调用被中止 (iteration ${i})`,
          details: {
            stageId,
            iteration: i,
            accumulatedChars: currentTurnAccumulated.length,
            errorMsg: msg,
          },
        });
        // 保留中断前已生成的 assistant 文本，避免 cancel 丢失用户已看到的回复
        if (currentTurnAccumulated.trim()) {
          history.push({ role: "assistant", content: currentTurnAccumulated });
          lastAssistant = currentTurnAccumulated;
        }
        return finalizeTerminal({ lastAssistant, aborted: true, correctionCount }, "interrupted");
      }
      writeEventLog({
        category: "react_loop",
        message: `ReAct loop LLM 调用失败 (iteration ${i}): ${msg}`,
        details: {
          stageId,
          iteration: i,
          error: msg,
          messagesCount: messages.length,
        },
      });
      opts.onEvent?.({ type: "error", message: msg });
      return finalizeTerminal({ lastAssistant, aborted: true, correctionCount }, "interrupted");
    }

    const choice = response.choices[0]!.message;
    const finishReason = response.choices[0]?.finish_reason ?? null;
    const content = choice.content ?? "";
    const responseUsage = normalizeUsage(
      response.usage,
      messagesForCall.map((message) => String(message.content ?? "")).join("\n"),
      `${content}${choice.tool_calls ? JSON.stringify(choice.tool_calls) : ""}`,
    );
    tracer.recordTokenUsage(responseUsage.promptTokens, responseUsage.completionTokens);
    lastAssistant = content;

// ── Parse tool calls ──
    const parsed = parseToolCallsFromAssistant({
      content,
      toolCalls: choice.tool_calls,
    });

    const known = new Set(toolsFinal.map((t) => t.function.name));

    // Normalize tool names through the alias map so weaker LLMs that output
    // "Read" / "Write" / "Edit" get routed to the correct built-in tools
    // instead of being silently dropped.
    const normalized = parsed.map((c) => ({
      ...c,
      name: normalizeToolName(c.name),
    }));

    // Collect calls whose name, even after normalization, does not match any
    // known tool — surface them as a synthetic tool-result error so the model
    // learns the correct name instead of repeating the mistake.
    const unknownCalls = normalized.filter((c) => !known.has(c.name));
    const calls = normalized.filter((c) => known.has(c.name));

    // If there were unknown tool names, inject their errors as tool results
    // so the model sees the feedback in the same turn.
    if (unknownCalls.length > 0) {
      for (const uc of unknownCalls) {
        const suggestion = findClosestToolName(uc.name, known);
        const msg = suggestion
          ? `Unknown tool "${uc.name}". Did you mean "${suggestion}"? Use the exact tool name as defined.`
          : `Unknown tool "${uc.name}". Available tools: ${[...known].sort().join(", ")}.`;
        messages.push({
          role: "tool",
          tool_call_id: uc.id,
          name: uc.name,
          content: `Error: ${msg}`,
        });
        history.push({ role: "tool", id: uc.id, content: `Error: ${msg}`, toolName: uc.name });
      }
    }

  // ── 弱模型容错状态说明 ──
  // prevIterHadToolCalls 只由两个分支各自维护，不能在这里无条件覆盖（旧代码在此处
  // 赋 `calls.length > 0`，导致进入下方纯文本分支时该值恒为 false，工具执行后的
  // 纯文本 nudge 从未触发过——"总中断"bug 的直接原因）：
  // - 工具执行分支置 true（下一轮若为纯文本响应，nudge 才有依据）；
  // - 纯文本分支开头保留旧值用于判断，随即置 false（"只给一次额外机会"，
  //   模型连续两轮纯文本则尊重其结束意图，避免 nudge→文本→nudge 死循环）。
  // postToolTextNudgeCount 保持单调策略：一旦 nudge 消耗就不回退，
  // 在整个循环生命周期内只增不减，达到上限后不再注入 nudge。
  // ── 文档交付后若模型仍试图调用工具，强制停止等待用户确认 ──
  if (documentDelivered && calls.length > 0) {
    logReasoningStep(reasoningTrace, {
      type: "observation",
      content: "Model attempted tool calls after document delivery, force-stopping to await user confirmation",
      timestamp: Date.now(),
    });
    const fallback = lastAssistant || lastAssistantSummaryFromHistory(history) || `Document ${deliveredDocName} has been generated. Awaiting your confirmation before continuing.`;
    return finalizeSuccess({ lastAssistant: fallback, aborted: false, awaitingUserConfirmation: true, correctionCount });
  }

  // ── No tool calls: text response → reflect and finish ──
  if (calls.length === 0) {
      // 弱模型容错：本轮为纯文本响应。先保留上一轮是否执行过工具的信息供 nudge
      // 判断，随即清除 flag——nudge 只给一次额外机会，连续两轮纯文本则尊重其结束意图。
      const toolsRanLastIter = prevIterHadToolCalls;
      prevIterHadToolCalls = false;
      // 文档已交付 → 直接返回等待用户确认
      if (!content.trim() && documentDelivered) {
        const fallback = lastAssistant || lastAssistantSummaryFromHistory(history) || `Document ${deliveredDocName} has been generated. Awaiting your confirmation before continuing.`;
        return finalizeSuccess({ lastAssistant: fallback, aborted: false, awaitingUserConfirmation: true, correctionCount });
      }

      // ── Codex-style: finish_reason as primary loop control signal ──
      // "length" → response was truncated by token limit; the model may have
      // been mid-generation (possibly mid tool-call). Force continuation so
      // the model can resume from where it left off.
      if (finishReason === "length") {
        logReasoningStep(reasoningTrace, {
          type: "observation",
          content: "Model response truncated (finish_reason=length), continuing loop",
          timestamp: Date.now(),
        });
        if (content.trim()) {
          updateStateAfterResponse(loopState, {
            content,
            toolCalls: [],
            finishReason,
            tokens: responseUsage.totalTokens,
            cost: (responseUsage.promptTokens / 1000) * 0.002 + (responseUsage.completionTokens / 1000) * 0.01,
          });
          history.push({ role: "assistant", content });
        }
        continue;
      }

      // 弱模型：工具执行后只回纯文本时，按意图决定是否 nudge（上限 maxPostToolTextNudges）。
      // 总结性报告不 nudge；行动宣言或探索未完成则 nudge。连续纯文本则尊重结束意图。
      const nudgeInfoTask = activeInformationTask();
      const nudgeExplorationComplete = nudgeInfoTask ? isExplorationComplete(nudgeInfoTask) : false;
      if (
        toolsRanLastIter &&
        content.trim() &&
        !documentDelivered &&
        !handoffRequested &&
        postToolTextNudgeCount < maxPostToolTextNudges &&
        shouldInjectPostToolTextNudge(content, nudgeExplorationComplete)
      ) {
        postToolTextNudgeCount++;
        writeEventLog({
          category: "react_loop",
          message: `ReAct loop: 工具执行后模型返回纯文本，注入 nudge 引导继续 (iteration ${i}, nudge ${postToolTextNudgeCount}/${maxPostToolTextNudges})`,
          details: {
            stageId,
            iteration: i,
            finishReason,
            content: content.slice(0, 200),
            explorationComplete: nudgeExplorationComplete,
            postToolTextNudgeCount,
          },
        });
        logReasoningStep(reasoningTrace, {
          type: "observation",
          content: `Model returned text-only response after tool execution (finish_reason=${finishReason ?? "unknown"}, nudge ${postToolTextNudgeCount}/${maxPostToolTextNudges}), injecting nudge to encourage continuation`,
          timestamp: Date.now(),
        });
        updateStateAfterResponse(loopState, {
          content,
          toolCalls: [],
          finishReason: finishReason ?? "stop",
          tokens: responseUsage.totalTokens,
          cost: (responseUsage.promptTokens / 1000) * 0.002 + (responseUsage.completionTokens / 1000) * 0.01,
        });
        history.push({ role: "assistant", content });
        messages.push({
          role: "system",
          content:
            "You just executed a tool and described the result, but the task is not yet complete. " +
            "Continue the work: call the next tool needed to make progress (e.g. read another file, " +
            "apply an edit, run a check), or if the task is genuinely done, state your final conclusion clearly. " +
            "Do not stop after a single tool call unless the entire task is finished.",
        });
        continue;
      }

      // Information needs: do not treat a text-only reply as completion while
      // unmet. Keep nudging exploration until needs are filled or a hard limit
      // (max iterations / tool cap via checkTermination) fires — never force-block here.
      const unmetInfoTask = activeInformationTask();
      if (
        unmetInfoTask &&
        unmetInfoTask.informationNeeds.length > 0 &&
        !isExplorationComplete(unmetInfoTask) &&
        content.trim() &&
        !documentDelivered &&
        !handoffRequested
      ) {
        updateStateAfterResponse(loopState, {
          content,
          toolCalls: [],
          finishReason: finishReason ?? "stop",
          tokens: responseUsage.totalTokens,
          cost: (responseUsage.promptTokens / 1000) * 0.002 + (responseUsage.completionTokens / 1000) * 0.01,
        });
        history.push({ role: "assistant", content });
        const missingNeeds = pendingInformationNeeds(unmetInfoTask);
        messages.push({
          role: "system",
          content:
            `Information needs are not yet met: ${missingNeeds.join(", ") || "stop-exploration criteria unmet"}. ` +
            "Call exploration tools that can fill these needs before giving a final answer. " +
            "Successful reads stay in this turn's context. Do not conclude while these needs are unmet.",
        });
        logReasoningStep(reasoningTrace, {
          type: "observation",
          content: `Information needs still unmet (${missingNeeds.join(", ") || "stop-exploration criteria unmet"}); continuing exploration instead of ending on a text-only reply.`,
          timestamp: Date.now(),
        });
        continue;
      }

      // ── Hard step-driver: model reported text ⇒ current task done/failed ⇒ advance ──
      if (taskDriven && currentTask && content.trim()) {
        updateStateAfterResponse(loopState, {
          content,
          toolCalls: [],
          finishReason: finishReason ?? "stop",
          tokens: responseUsage.totalTokens,
          cost: (responseUsage.promptTokens / 1000) * 0.002 + (responseUsage.completionTokens / 1000) * 0.01,
        });
        history.push({ role: "assistant", content });
        const failed = /incomplete|failed|unable|cannot|error|failed/i.test(content);
        currentTask.status = failed ? "failed" : "completed";
        currentTask.result = content.slice(0, 200);
        logReasoningStep(reasoningTrace, {
          type: "reflection",
          content: `Task ${currentTask.id} → ${currentTask.status}: ${currentTask.result}`,
          timestamp: Date.now(),
        });
        const justDone = currentTask;
        const next = selectNextPendingTask(tasks);
        currentTask = next;
        syncLoopTask();

        if (next) {
          // Previous task's similar-output / stop / text-only counters must not
          // terminate the next task on the following iteration's checkTermination.
          resetOutputTrackingForNewTask(loopState);
          next.status = "in_progress";
          await persistTaskUpdate(next.id);
          messages.push({
            role: "system",
            content: `Task ${justDone.id} ${justDone.status === "completed" ? "completed" : "failed"}. Now starting task ${next.id}: ${next.description}`,
          });
          continue;
        }
        await persistTaskUpdate(null);
        const { done, total } = taskProgress(tasks);
        history.push({ role: "assistant", content: `All tasks processed (${done}/${total} completed).` });
        writeEventLog({
          category: "react_loop",
          message: `ReAct loop 退出: 全部任务已处理 (${done}/${total})，iteration ${i}`,
          details: {
            stageId,
            iteration: i,
            done,
            total,
            lastTaskId: currentTask?.id ?? justDone.id,
            finishReason,
          },
        });
        return finalizeSuccess({ lastAssistant: content, aborted: false, correctionCount, documentWorkflow: documentWorkflowUpdate });
      }

      if (content.trim()) {
        // 纯文本退出也必须更新 loopState，否则相似度 / 连续纯文本计数
        // 永远停在上一轮工具调用，中文近重复报告无法被第二层抓住。
        updateStateAfterResponse(loopState, {
          content,
          toolCalls: [],
          finishReason: finishReason ?? "stop",
          tokens: responseUsage.totalTokens,
          cost: (responseUsage.promptTokens / 1000) * 0.002 + (responseUsage.completionTokens / 1000) * 0.01,
        });
        // 近重复最终报告：仅当 history 末条已是助手文本时才跳过，
        // 避免「上一轮是工具调用、文本从未入史」时两份都丢。
        const lastHist = history[history.length - 1];
        const lastAlreadyHasReport =
          lastHist?.role === "assistant" && Boolean(lastHist.content?.trim());
        if (!(loopState.consecutiveSimilarOutputs >= 1 && lastAlreadyHasReport)) {
          history.push({ role: "assistant", content });
        }

        // ── 自动提取证据：从LLM回复中提取文件片段引用并保存到历史 ──
        // 当LLM返回纯文本回复时，自动解析其中对文件行号的引用，
        // 从已读取的文件内容中提取对应片段，保存为证据到历史记录。
        if (rawReadToolMessages.length > 0) {
          const extracted = await autoExtractAndSaveEvidence(
            content,
            rawReadToolMessages,
            history,
            toolCtx.workspaceRoot,
            memory,
          );
          if (extracted) {
            logReasoningStep(reasoningTrace, {
              type: "observation",
              content: "Auto-extracted file excerpts from assistant reply and saved to history",
              timestamp: Date.now(),
            });
          }
        }
      }
      logReasoningStep(reasoningTrace, {
        type: "observation",
        content: "Model returned a text response (no tool calls)",
        timestamp: Date.now(),
      });
      // 纯文本退出路径此前完全静默，排查"总中断"时无迹可寻。补一条事件日志，
      // 记录退出时的关键状态（上一轮是否执行了工具、nudge 计数、任务探索状态）。
      writeEventLog({
        category: "react_loop",
        message: `ReAct loop 因模型纯文本响应（无工具调用）退出 (iteration ${i})`,
        details: {
          stageId,
          iteration: i,
          finishReason,
          contentChars: content.length,
          contentPreview: content.slice(0, 200),
          toolsRanPreviousIter: toolsRanLastIter,
          postToolTextNudgeCount,
          taskDriven,
          currentTaskId: currentTask?.id ?? null,
          explorationComplete: (() => {
            const task = activeInformationTask();
            return task ? isExplorationComplete(task) : null;
          })(),
        },
      });

      if (currentStep) {
        // Build an LLM caller for reflection (uses current model)
        const stepId = currentStep.id; // narrowed-const for nested closure
        const reflectionCaller = async (prompt: string): Promise<string> => {
          try {
            const resp = await chatCompletionStream(
              model,
              [{ role: "system", content: prompt }],
              {
                signal: opts.signal,
                apiKey: opts.llmApiKey,
                purpose: `reflection#${stageId}#${stepId}`,
                taskId: opts.sessionId,
                thinking: { effort: opts.workflow.thinking?.defaultEffort },
              },
            );
            return resp.choices[0]!.message.content ?? "";
          } catch {
            return "";
          }
        };

        // Use LLM-based reflection (falls back to regex on failure)
        const reflection = await reflectOnStepWithLLM(
          currentStep, [], content, reflectionCaller,
        );
        logReasoningStep(reasoningTrace, {
          type: "reflection",
          content: reflection.stepCompleted ? "Step completed" : "Step may need correction",
          timestamp: Date.now(),
          metadata: { qualityScore: reflection.qualityScore, issues: reflection.issues },
        });

        if (reflection.stepCompleted) {
          currentStep.status = "completed";
        } else if (reflection.needsReplan && currentStep.retryCount < currentStep.maxRetries) {
          currentStep.retryCount++;
          correctionCount++;
          applyRunEvent({
            type: "observability",
            taskId: args.opts.sessionId,
            retries: 1,
          });
          messages.push({
            role: "system",
            content: clampText(buildCorrectionPrompt(reflection, content), 2000),
          });
          logReasoningStep(reasoningTrace, {
            type: "replan",
            content: `Step needs re-execution (retry ${currentStep.retryCount})`,
            timestamp: Date.now(),
          });
          continue;
        } else {
          currentStep.status = "failed";
        }
        currentStep = selectNextStep(plan!);
      }

      return finalizeSuccess({ lastAssistant: content, aborted: false, correctionCount, documentWorkflow: documentWorkflowUpdate });
    }

    // ── Execute tools ──
    // 本轮执行了工具：若下一轮模型只输出纯文本，nudge 才有依据。
    prevIterHadToolCalls = true;
    const openaiCalls: ToolCall[] = calls.map((c, idx) => ({
      id: c.id || `call_${stageId}_${i}_${idx}`,
      type: "function" as const,
      function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
    }));

    totalToolCalls += calls.length;
    applyRunEvent({
      type: "tool_completed",
      taskId: args.opts.sessionId,
      tool: calls.map((c) => c.name).join(","),
      ok: true,
      count: calls.length,
    });

    // ── Consecutive read-only iterations check ──
    // When the model produces no text and only calls read-only tools (list_dir, read_file, etc.),
    // it may be stuck in an infinite exploration/browsing loop.
    // NOTE: we intentionally do NOT reset the counter when the model produces text alongside
    // read-only tool calls — "let me read this file..." + read_file is still pure exploration
    // and should count toward the readonly-iteration cap.
    const allReadonly = calls.every((c) => READONLY_TOOLS.has(c.name));
    if (allReadonly) {
      consecutiveReadonlyIters++;
    } else {
      // Reset only when the model actually uses a write/production tool (save_plan, write_file, etc.)
      consecutiveReadonlyIters = 0;
    }

    // ── Soft transition nudge: push exploration → implementation ──
    // Before checkTermination's hard caps fire, inject a gentle nudge when
    // the model has spent several consecutive iterations on read-only tools.
    // This directly addresses the "总中断" bug: the agent keeps exploring
    // without transitioning to implementation. The nudge is injected AFTER
    // tool results are recorded (so the model has the facts) but BEFORE the
    // next LLM call, steering it toward producing output.
    if (
      allReadonly &&
      consecutiveReadonlyIters >= READONLY_TRANSITION_THRESHOLD &&
      consecutiveReadonlyIters < maxConsecutiveReadonlyIters
    ) {
      messages.push({
        role: "system",
        content:
          `You have used only exploration tools (read/search/browse) for ${consecutiveReadonlyIters} consecutive iterations without entering the implementation phase. ` +
          `Based on the information already gathered, transition to implementation now: use apply_patch / write_file to edit files, run type_check / bash to verify, or give a final conclusion. ` +
          `If you genuinely lack necessary information, state what is missing and do exactly one targeted read; otherwise stop exploring and start implementing immediately.`,
      });
      logReasoningStep(reasoningTrace, {
        type: "observation",
        content: `${consecutiveReadonlyIters} consecutive read-only exploration iterations, injecting transition nudge (exploration → implementation)`,
        timestamp: Date.now(),
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Termination state: update after model response (before tool execution)
    // Stuck / tool-cap hard stops live in checkTermination — tool errors never
    // force-block here; results (including failures) always return to the model.
    // ═══════════════════════════════════════════════════════════════════════════
    const openaiCallsForTermination: ToolCall[] = calls.map((c, idx) => ({
      id: c.id || `call_${stageId}_${i}_${idx}`,
      type: "function" as const,
      function: {
        name: c.name,
        arguments: JSON.stringify(c.arguments || {}),
      },
    }));

    updateStateAfterResponse(loopState, {
      content: content,
      toolCalls: openaiCallsForTermination,
      finishReason: finishReason,
      tokens: responseUsage.totalTokens,
      cost: (responseUsage.promptTokens / 1000) * 0.002 + (responseUsage.completionTokens / 1000) * 0.01,
    });

    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: openaiCalls,
    });
    history.push({
      role: "assistant",
      content: content || calls.map((c) => `→ ${c.name}`).join("\n"),
    });

    // ── Git Auto-Snapshot: checkpoint before any file-modifying tools execute ──
    // Surface genuine failures: the tools below will happily report success
    // whether or not the safety net actually got created, so a silent failure
    // leaves the user believing they can roll back when they cannot.
    const hasFileModifyingTool = calls.some((c) => FILE_MODIFYING_TOOLS.has(c.name));
    if (gitSnapshotEnabled && hasFileModifyingTool && opts.mode !== "plan") {
      const snapshot = await gitAutoSnapshot(
        toolCtx.workspaceRoot,
        `before-${stageId ?? "execute"}`,
      );
      if (!snapshot.ok && snapshot.reason === "failed" && !gitSnapshotWarned) {
        gitSnapshotWarned = true; // once per turn — don't spam every iteration
        opts.onEvent?.({
          type: "warning",
          message: `Git auto-snapshot creation failed (${snapshot.error ?? "unknown reason"}). This turn's file modifications cannot be rolled back via Git snapshot. Session checkpoints remain available.`,
        });
      }
    }

    // ── Execute tool calls ──
    // Consecutive parallel-safe calls (pure reads: read_file, grep, lsp_*, …)
    // run concurrently; writes / bash / memory mutations / unknown tools run
    // sequentially. Results are always recorded in the original call order so
    // the OpenAI tool-call protocol and history stay deterministic.
    // ask_user is never parallel-safe; still allow at most one real prompt per
    // model tool batch so the UI is not asked twice in the same React iteration.
    let askUserExecutedInBatch = false;
    const runOne = async (ti: number) => {
      const call = calls[ti]!;
      const id = openaiCalls[ti]!.id;
      const toolSpanId = tracer.startSpan(`tool_${call.name}`, "tool_call", {
        toolName: call.name,
        iteration: i,
      });
      opts.onEvent?.({ type: "tool_start", id, name: call.name, args: call.arguments });
      let result: Awaited<ReturnType<typeof executeTool>>;
      if (call.name === "ask_user") {
        if (askUserExecutedInBatch) {
          result = {
            ok: true,
            output:
              "Skipped: only one ask_user is allowed per tool batch; reuse the first answer in this batch and do not re-ask.",
          };
        } else {
          askUserExecutedInBatch = true;
          result = await executeTool(toolCtx, { ...call, id });
        }
      } else {
        result = await executeTool(toolCtx, { ...call, id });
      }
      if (!result.ok) {
        const recovery = classifyRecoveryError(result.output);
        opts.onEvent?.({
          type: "recovery",
          errorType: recovery.type,
          action: recovery.action,
          retryable: recovery.retryable,
          summary: recovery.summary,
        });
        recordDecision({
          iteration: i,
          goal: currentTask?.description ?? currentStep?.description ?? opts.userMessage.slice(0, 200),
          action: recovery.action,
          reasonSummary: recovery.summary,
          expectedObservation: "修复后获得成功结果或模型改换策略",
          actualObservationSummary: result.output.slice(0, 300),
          nextDecision: "retry",
          timestamp: Date.now(),
        });
        // 工具失败（含权限/用户决策类、整文件超限等）已写入 tool result，
        // 一律交回 LLM 自行纠错或改路径，不得因此打断 react 循环。
      }
      tracer.endSpan(toolSpanId, result.ok ? "ok" : "error");
      opts.onEvent?.({
        type: "tool_end",
        id,
        name: call.name,
        ok: result.ok,
        output: result.output,
        metadata: result.metadata,
      });
      return { call, id, result };
    };

    const invalidateEvidenceForPath = async (inputPath: string): Promise<void> => {
      const canonicalPath = canonicalReadPath(toolCtx.workspaceRoot, inputPath);
      let changed = false;
      for (const task of informationTasks()) {
        const retained = task.evidence.filter((evidence) => evidence.path !== canonicalPath);
        if (retained.length !== task.evidence.length) {
          task.evidence = retained;
          changed = true;
        }
      }
      if (changed) {
        // Persist every affected task before a subsequent model call can use a stale lock.
        await persistTaskUpdate(currentTask?.id ?? null);
      }
    };

    const invalidateAllTaskEvidence = async (): Promise<void> => {
      let changed = false;
      for (const task of informationTasks()) {
        if (task.evidence.length > 0) {
          task.evidence = [];
          changed = true;
        }
      }
      if (changed) {
        // Bash does not expose a reliable changed-path set. Clearing the active
        // evidence is conservative: stale evidence must never keep exploration locked.
        await persistTaskUpdate(currentTask?.id ?? null);
      }
    };

    const executedToolResults: Array<{ name: string; arguments: Record<string, unknown>; result: string }> = [];
    const recordResult = async (r: {
      call: typeof calls[number];
      id: string;
      result: Awaited<ReturnType<typeof executeTool>>;
    }) => {
      const toolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: r.id,
        name: r.call.name,
        content: r.result.output,
      };
      messages.push(toolMessage);
      const successfulRead = r.result.ok && r.result.metadata?.kind === "read_file";
      if (successfulRead) {
        rawReadToolMessages.push(toolMessage);
      }

      const historySummary = summarizeToolResultForHistory(r.call, r.result);
      history.push({
        role: "tool",
        id: r.id,
        content: historySummary,
        toolName: r.call.name,
      });
      memory.addToolOutput(r.call.name, historySummary);

      if (r.result.ok && READ_INVALIDATING_TOOLS.has(r.call.name)) {
        const modifiedPath = String(r.call.arguments?.path ?? "");
        if (modifiedPath) {
          emitFreshnessFollowUp(contextControl?.invalidatePath(modifiedPath) ?? null);
          await invalidateEvidenceForPath(modifiedPath);
        }
      }

      if (
        r.result.ok &&
        r.call.name === "bash" &&
        !isReadonlyBash(String(r.call.arguments?.command ?? ""))
      ) {
        emitFreshnessFollowUp(contextControl?.invalidateAll() ?? null);
        await invalidateAllTaskEvidence();
      }

      const resultMetadata = r.result.metadata;
      executedToolResults.push({
        name: r.call.name,
        arguments: r.call.arguments ?? {},
        result: r.result.output,
      });
      if (r.result.ok && resultMetadata?.kind === "file_mutation") {
        for (const modifiedPath of resultMetadata.paths) {
          emitFreshnessFollowUp(contextControl?.invalidatePath(modifiedPath) ?? null);
          await invalidateEvidenceForPath(modifiedPath);
        }
      }

      if (
        r.result.ok &&
        (resultMetadata?.kind === "read_file" || resultMetadata?.kind === "read_outline")
      ) {
        const isBoundedSourceRead = resultMetadata.kind === "read_file";
        if (isBoundedSourceRead) {
          emitFreshnessFollowUp(contextControl?.recordFreshRead(resultMetadata) ?? null);
        }

        const evidenceTask = activeInformationTask();
        // A successful source navigation result can satisfy a matching need.
        // Keep only a compact marker in the task block; the full result remains
        // in this turn's messages and is persisted after the loop.
        if (evidenceTask) {
          const sourceHash = resultMetadata.contentHash ?? `${resultMetadata.size}:${resultMetadata.mtimeMs}`;
          const satisfied = satisfiedInformationNeedIds(evidenceTask);
          const matched = evidenceTask.informationNeeds.filter(
            (need) => !satisfied.has(need.id) && informationNeedMatchesPath(need.question, resultMetadata.path),
          );
          if (matched.length > 0) {
            evidenceTask.evidence = [
              ...evidenceTask.evidence,
              ...matched.map((need): TaskEvidence => ({
                kind: resultMetadata.kind === "read_outline" ? "navigation" : "source",
                needId: need.id,
                summary: `${resultMetadata.kind === "read_outline" ? "Outlined" : "Read"} ${resultMetadata.path} lines ${resultMetadata.startLine}-${resultMetadata.endLine}`,
                excerpt: resultMetadata.kind === "read_outline"
                  ? undefined
                  : `${resultMetadata.kind === "read_file" ? "Read" : "Read"} ${resultMetadata.path} L${resultMetadata.startLine}-${resultMetadata.endLine}\n${r.result.output}`,
                path: resultMetadata.path,
                startLine: resultMetadata.startLine,
                endLine: resultMetadata.endLine,
                sourceHash,
              })),
            ];
            if (currentTask && evidenceTask === currentTask) await persistTaskUpdate(currentTask.id);
          }
        }
      }

      // 文件修改类工具执行后，向对话流推一条 assistant 总结，让用户看到行动反馈（解决静默执行）。
      // 写入 history（UI 可见 + 持久化）；当前轮不进 messages，下一轮作为历史记录可见，不干扰本轮 LLM 决策。
      const userSummary = summarizeToolActionForUser(r.call.name, r.result);
      if (userSummary) {
        history.push({ role: "assistant", content: userSummary });
      }
      // ── Plan 模式文档交付物检测：成功写入 PRD/TDD 后停止本轮并持久化阶段。 ──
      if (docDeliverableEnabled && opts.mode === "plan" && !documentDelivered && r.result.ok) {
        const document = detectDocumentDeliverable(r.call.name, r.call.arguments);
        if (document) {
          documentDelivered = true;
          deliveredDocName = document.name;
          const stage = documentStageFromArtifact(document.path, document.content);
          // 仅在尚未设置工作流状态时才创建新状态，避免后续 TDD 覆盖 PRD 路径
          if (stage && documentWorkflowUpdate === undefined) {
            // 推断文档类型
            const docType = inferDocumentType(document.path, document.content);

            // 保留之前已生成的文档路径列表（向后兼容）
            const previousDocs = [...(opts.documentWorkflow?.allDocuments ?? [])];

            // 兼容旧会话：如果 allDocuments 为空但有 documentPath，补全历史文档
            if (previousDocs.length === 0 && opts.documentWorkflow?.documentPath) {
              previousDocs.push(opts.documentWorkflow.documentPath);
            }

            // 去重：只有当前文档不在列表中时才添加
            const allDocuments = previousDocs.includes(document.path)
              ? previousDocs
              : [...previousDocs, document.path];

            // 构建增强的文档元数据列表
            const existingDocs = opts.documentWorkflow?.documents ?? [];

            // 从旧格式迁移：如果没有 documents 但有 allDocuments，转换过来
            let migratedDocs = existingDocs;
            if (migratedDocs.length === 0 && previousDocs.length > 0) {
              migratedDocs = previousDocs.map(path => ({
                type: inferDocumentType(path, "") as import("./types.ts").DocumentType,
                path,
                createdAt: opts.documentWorkflow?.updatedAt ?? new Date().toISOString(),
                status: "approved" as const,
              }));
            }

            // 查找是否已存在该文档（更新场景）
            const existingIndex = migratedDocs.findIndex(d => d.path === document.path);

            let documents: import("./types.ts").DocumentMetadata[];
            if (existingIndex >= 0) {
              // 更新现有文档
              documents = [...migratedDocs];
              documents[existingIndex] = {
                ...documents[existingIndex]!,
                status: "pending_approval" as const,
              };
            } else {
              // 添加新文档，标记依赖关系
              const basedOn = migratedDocs.filter(d => d.status === "approved").map(d => d.path);
              documents = [
                ...migratedDocs,
                {
                  type: docType,
                  path: document.path,
                  createdAt: new Date().toISOString(),
                  status: "pending_approval" as const,
                  basedOn: basedOn.length > 0 ? basedOn : undefined,
                },
              ];
            }

            documentWorkflowUpdate = {
              stage,
              documentPath: document.path,
              updatedAt: new Date().toISOString(),
              allDocuments,  // 保留向后兼容
              documents,     // 新的增强格式
            };
          }
        }
      }
      // TDD 确认后的实施计划已保存，结束文档工作流状态。
      if (
        opts.mode === "plan" &&
        r.result.ok &&
        r.call.name === "save_plan" &&
        opts.documentWorkflow?.stage === "awaiting_tdd_confirmation"
      ) {
        documentWorkflowUpdate = null;
      }
      // ── 交还用户检测：report_blocker 成功即终止本轮，不再执行后续调用。 ──
      if (!handoffRequested && r.result.ok && r.call.name === "report_blocker") {
        handoffRequested = true;
        handoffReport = formatBlockerReport(
          String(r.call.arguments?.reason ?? ""),
          String(r.call.arguments?.summary ?? ""),
          String(r.call.arguments?.userAction ?? ""),
          String(r.call.arguments?.completed ?? ""),
        );
      }
    };

    const recordSkippedCall = (ti: number) => {
      const call = calls[ti]!;
      const id = openaiCalls[ti]!.id;
      const output = handoffRequested
        ? "Skipped: control was handed back to the user by report_blocker."
        : `Skipped: document ${deliveredDocName} is awaiting user confirmation.`;
      opts.onEvent?.({ type: "tool_start", id, name: call.name, args: call.arguments });
      messages.push({ role: "tool", tool_call_id: id, name: call.name, content: output });
      history.push({ role: "tool", id, content: output, toolName: call.name });
      opts.onEvent?.({ type: "tool_end", id, name: call.name, ok: true, skipped: true, output });
    };

    let skippedExploration = false;
    const recordExplorationSkippedCall = (ti: number) => {
      const call = calls[ti]!;
      const id = openaiCalls[ti]!.id;
      const output = "Skipped: verified information evidence satisfies every exploration stop criterion; proceed with an edit, verification, blocker, or final result.";
      opts.onEvent?.({ type: "tool_start", id, name: call.name, args: call.arguments });
      messages.push({ role: "tool", tool_call_id: id, name: call.name, content: output });
      history.push({ role: "tool", id, content: output, toolName: call.name });
      opts.onEvent?.({ type: "tool_end", id, name: call.name, ok: true, skipped: true, output });
    };

    let ti = 0;
    while (ti < calls.length) {
      if (documentDelivered || handoffRequested) break;
      const informationTask = activeInformationTask();
      if (
        informationTask &&
        informationTask.informationNeeds.length > 0 &&
        isExplorationComplete(informationTask) &&
        READONLY_TOOLS.has(calls[ti]!.name)
      ) {
        recordExplorationSkippedCall(ti);
        skippedExploration = true;
        ti++;
        continue;
      }
      if (toolExecParallel && PARALLEL_SAFE_TOOLS.has(calls[ti]!.name)) {
        // Gather the run of consecutive parallel-safe calls.
        const batch: number[] = [];
        while (ti < calls.length && PARALLEL_SAFE_TOOLS.has(calls[ti]!.name)) {
          batch.push(ti);
          ti++;
        }
        if (batch.length === 1) {
          await recordResult(await runOne(batch[0]!));
        } else {
          const results = await Promise.all(batch.map((idx) => runOne(idx)));
          for (const r of results) await recordResult(r);
        }
      } else {
        await recordResult(await runOne(ti));
        ti++;
      }
    }

    if (skippedExploration) {
      messages.push({
        role: "system",
        content: "Verified information evidence satisfies every exploration stop criterion. Do not explore further; continue with an edit, verification, report_blocker, or final result.",
      });

      // 🔥 NEW: 更新探索跳过计数
      // 探索完成后模型继续尝试探索工具，记录跳过次数
      if (loopState.lastIterationHadExplorationSkip) {
        // 连续两轮都有跳过，递增计数
        loopState.explorationSkipCount++;
      } else {
        // 第一次跳过，重置计数
        loopState.explorationSkipCount = 1;
      }
      loopState.lastIterationHadExplorationSkip = true;
    } else {
      // 本轮没有跳过，重置计数和标记
      loopState.lastIterationHadExplorationSkip = false;
      loopState.explorationSkipCount = 0;  // 🔥 重置计数
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // New Termination: Update state after tools executed
    // ═══════════════════════════════════════════════════════════════════════════
    if (executedToolResults.length > 0) {
      updateStateAfterTools(loopState, executedToolResults);
    }

    if (opts.signal?.aborted) {
      writeEventLog({
        category: "abort",
        message: `ReAct loop 中止 (after tools, iteration ${i})`,
        details: {
          stageId,
          iteration: i,
          totalToolCalls,
          lastAssistantLen: lastAssistant.length,
        },
      });
      return finalizeTerminal({ lastAssistant, aborted: true, correctionCount }, "interrupted");
    }

    // ── 交还用户：report_blocker 已调用，本轮正常结束 ──
    // 放在 auto-fix 之前：auto-fix 会把模型重新拉回自主循环，而 handoff 的整个目的
    // 就是退出自主循环。剩余的类型错误留给下一轮，present_changes 仍会展示改动。
    if (handoffRequested) {
      while (ti < calls.length) {
        recordSkippedCall(ti);
        ti++;
      }
      const summary = handoffReport || lastAssistant || "Control has been handed back to you. Please review the explanation above.";
      logReasoningStep(reasoningTrace, {
        type: "observation",
        content: "Model called report_blocker to hand back control, stopping autonomous progression this turn",
        timestamp: Date.now(),
      });
      history.push({ role: "assistant", content: summary });
      opts.onEvent?.({ type: "assistant_delta", text: summary });
      return finalizeTerminal({
        lastAssistant: summary,
        aborted: false,
        handoffRequested: true,
        documentWorkflow: documentWorkflowUpdate,
        correctionCount,
      }, "blocked");
    }

    // ── Plan 模式文档交付物：写入 PRD/TDD 等后立即停止，等待用户确认 ──
    if (documentDelivered) {
      // The assistant tool-call message already lists every call. Record a
      // non-side-effect result for calls skipped after the document write.
      while (ti < calls.length) {
        recordSkippedCall(ti);
        ti++;
      }
      const deliveredSummary = `Document generated: ${deliveredDocName}. Please confirm the content is correct before proceeding to the next step.`;
      logReasoningStep(reasoningTrace, {
        type: "observation",
        content: `Document deliverable detected (${deliveredDocName}), stopping further generation, awaiting user confirmation`,
        timestamp: Date.now(),
      });
      history.push({ role: "assistant", content: deliveredSummary });
      opts.onEvent?.({ type: "assistant_delta", text: deliveredSummary });
      return finalizeSuccess({
        lastAssistant: deliveredSummary,
        aborted: false,
        awaitingUserConfirmation: true,
        documentWorkflow: documentWorkflowUpdate,
        correctionCount,
      });
    }

    // ── Auto-Fix Verification: auto type-check after file modifications ──
    const dirtyFiles = getDirtyFiles(calls);
    if (dirtyFiles.length > 0) hadFileModifyingTools = true;
    if (autoFixEnabled && dirtyFiles.length > 0 && opts.mode !== "plan" && opts.enableAutoFix !== false) {
      const fixResult = await autoFixAfterTools(
        toolCtx.workspaceRoot,
        dirtyFiles,
        autoFixState,
        {
          maxAttempts: autoFixMaxAttempts,
          autoTypeCheck: true,
          onEvent: (e) => {
            if (e.type === "fix_error") {
              logReasoningStep(reasoningTrace, {
                type: "observation",
                content: e.message,
                timestamp: Date.now(),
              });
            }
          },
        },
      );
      if (fixResult.finalVerification) {
        applyRunEvent({
          type: "verification_completed",
          taskId: args.opts.sessionId,
          result: fixResult.finalVerification,
        });
        applyRunEvent({
          type: "repair_completed",
          taskId: args.opts.sessionId,
          attempt: fixResult.attempts,
          resolved: fixResult.resolved,
        });
      }
      // semantic_diff「移除了导出」等建议性警告：不弹窗、不中断。
      // 硬错误达修复上限：不发 warning（避免顶部弹窗），正文写入原因后终止。
      if (fixResult.exhausted && !isAdvisoryVerificationResult(fixResult.finalVerification)) {
        const blockedReason = `自动修复达到上限（${autoFixMaxAttempts} 次）：${fixResult.summary}`;
        return finalizeTerminal({
          lastAssistant: blockedReason,
          aborted: false,
          blocked: true,
          blockedReason,
          correctionCount,
        }, "failed");
      }
      // Inject verification error messages into the conversation for the next LLM turn
      for (const msg of fixResult.injectedMessages) {
        messages.push(msg);
        history.push({ role: "user", content: msg.content ?? "" });
      }
      if (fixResult.resolved) {
        // Reset fix state on clean verification
        autoFixState.dirtyFiles = [];
        autoFixState.fixAttempts = 0;
        autoFixState.hasUnresolvedErrors = false;
      }
    }

    logReasoningStep(reasoningTrace, {
      type: "action",
      content: `Executed ${calls.length} tool calls: ${calls.map((c: typeof calls[0]) => c.name).join(", ")}`,
      timestamp: Date.now(),
    });
  }

  const finalFallback = lastAssistant || lastAssistantSummaryFromHistory(history) || "(max iterations reached)";
  writeEventLog({
    category: "react_loop",
    message: `ReAct loop 退出: 达到最大迭代限制 (${maxIter})`,
    details: {
      stageId,
      maxIter,
      totalToolCalls,
      postToolTextNudgeCount,
      lastAssistantChars: lastAssistant.length,
    },
  });
  opts.onEvent?.({
    type: "warning",
    message: `已达到最大迭代限制（${maxIter} 次），任务可能尚未完成。可在流水线设置中调高"Max model/tool iterations"后重试。`,
  });
  // 达迭代上限不是成功：标记 blocked，避免绕过成功门禁。
  return finalizeTerminal({
    lastAssistant: finalFallback,
    aborted: false,
    blocked: true,
    blockedReason: `已达到最大迭代限制（${maxIter} 次）`,
    correctionCount,
  }, "failed");
}

// ── Verify Stage ───────────────────────────────────────────
//
// The Verify report is a SINGLE LLM call emitted at the end of the turn (after
// every verify node in the pipeline has finished), not per verify node. Multiple
// verify nodes in the same pipeline used to each trigger one `chatCompletionStream`
// call; the user-visible output was merged/displayed once but each one cost a
// full LLM call + token bill. Now: the verify stage records a single "report
// target" node for the endpoint to use, and the endpoint runs one LLM call,
// appending the `### Verification` paragraph to the final assistantText.
export const DEFAULT_VERIFY_PROMPT =
  "Audit the completed work against the user request using only the conversation, tool results, and recorded checks. " +
  "Do not call tools or redo work. Return a concise verdict: Verified, Partially verified, or Not verified; then list requirement evidence " +
  "and any gap or next action. Never claim a check passed unless its result is present in context.";

export async function runVerifyReport(
  opts: AgentLoopOpts,
  verifyNode: PipelineNode,
  messages: ChatMessage[],
  assistantText: string,
  tracer?: Tracer,
): Promise<string> {
  const verifyModel = resolveStageModel(opts.workflow, opts.mode, verifyNode);
  assertLlmAuth(verifyModel, opts.llmApiKey);
  const verifyPrompt = verifyNode.prompt?.trim() || DEFAULT_VERIFY_PROMPT;

  const maxVerifyOutputChars = 6_000;
  const omittedMiddleMarker = "\n\n[... middle of the final response omitted for verification context ...]\n\n";
  const verifyOutput = assistantText.length <= maxVerifyOutputChars
    ? assistantText
    : (() => {
        const availableChars = maxVerifyOutputChars - omittedMiddleMarker.length;
        const openingChars = Math.ceil(availableChars * 0.6);
        const closingChars = availableChars - openingChars;
        return `${assistantText.slice(0, openingChars)}${omittedMiddleMarker}${assistantText.slice(-closingChars)}`;
      })();

  const verifyMessages: ChatMessage[] = [
    ...messages,
    { role: "system", content: `## Verify stage\n${verifyPrompt}` },
    {
      role: "user",
      content: `Verify the work so far. Last assistant output:\n\n${verifyOutput}`,
    },
  ];
  const response = await chatCompletionStream(verifyModel, verifyMessages, {
    signal: opts.signal,
    apiKey: opts.llmApiKey,
    purpose: `verify_report#${verifyNode.id}`,
    taskId: opts.sessionId,
    onDelta: (text: string) => opts.onEvent?.({ type: "assistant_delta", text }),
    thinking: { effort: "none" },
  });
  const content = response.choices[0]!.message.content ?? "";
  if (tracer) {
    const usage = normalizeUsage(
      response.usage,
      verifyMessages.map((message) => String(message.content ?? "")).join("\n"),
      content,
    );
    tracer.recordTokenUsage(usage.promptTokens, usage.completionTokens);
  }
  return content;
}

/**
 * Merge a verification paragraph into the final assistantText and reflect it
 * back into history so persistence keeps the merged version. Used by the
 * single endpoint after all stages have run.
 */
export function mergeVerificationIntoAssistant(
  assistantText: string,
  verifyText: string,
  history: ChatTurn[],
): string {
  if (!verifyText.trim()) return assistantText;
  const combined = `${assistantText.trim()}\n\n---\n### Verification\n${verifyText.trim()}`;
  const last = history[history.length - 1];
  if (last?.role === "assistant") {
    last.content = combined;
  } else {
    history.push({ role: "assistant", content: combined });
  }
  return combined;
}

/**
 * @deprecated Per-verify-node report generation has been replaced by a single
 * endpoint call (`runVerifyReport` from `loop.ts`). Kept only so any external
 * import does not fail to type-check; it now emits the start/done stage markers
 * and returns the input unchanged.
 */
export async function maybeVerify(
  _opts: AgentLoopOpts,
  verifyNode: PipelineNode,
  _messages: ChatMessage[],
  _history: ChatTurn[],
  assistantText: string,
): Promise<string> {
  emitStage(_opts.onEvent, "start", verifyNode);
  emitStage(_opts.onEvent, "done", verifyNode);
  return assistantText;
}
