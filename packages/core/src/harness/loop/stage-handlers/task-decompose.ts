/**
 * Task decomposition stage handler and related utilities.
 *
 * This module handles the task_decompose pipeline node, which analyzes the user's
 * request and breaks it down into structured steps with information needs and stop
 * conditions. The decomposition result guides the subsequent ReAct loop exploration.
 */

import {
  assertLlmAuth,
  chatCompletion,
  writeEventLog,
  type ChatMessage,
  type ToolCall,
} from "@owncoder/llm";
import {
  BUILTIN_TASK_DECOMPOSE_PROMPT,
  type ModelRef,
} from "@owncoder/settings";
import { localeJsonValuesPrompt } from "../../loop.ts";
import { contextBudgets } from "../../budget.ts";
import { normalizeUsage } from "../../observability.ts";
import type { Tracer } from "../../observability.ts";
import {
  generatePlan,
  logReasoningStep,
  type AgentPlan,
  type ReasoningTrace,
} from "../../agent-reasoning.ts";
import { MemoryManager } from "../../memory.ts";
import { withRetry } from "../../model-coordinator.ts";
import { jsonrepair } from "jsonrepair";
import { emitStage, resolveStageModel } from "../stages.ts";
import type { AgentLoopOpts, ChatTurn } from "../types.ts";
import type { TaskItem } from "../../../plans.ts";
import { recallHistoryForTaskDecompose } from "../../tools/history.ts";
import { documentIntentContext } from "../document-workflow.ts";
import { agentIntentContext } from "../agent-intent.ts";
import type { StageHandler } from "./types.ts";
import { clipBlock } from "./constants.ts";
import {
  collectReadEvidenceFromTurns,
  collectToolCallsFromTurns,
  loadRecentRounds,
  persistDecomposeRound,
  type PersistedDecompose,
} from "../../../turn-rounds.ts";

// ── Budget safety factor ───────────────────────────────────────────

/**
 * Char/token estimation safety factor. Used for token→char conversions.
 */
const CHAR_TOKEN_SAFETY = 0.75;

// ── Helper Functions ───────────────────────────────────────────────

/**
 * Compute decomposition context limits from context budget settings.
 * Returns character-based limits derived from the history segment budget
 * (budgets.plan), so that preferences/rules scale with contextWindow / inputRatio.
 * Round history itself is not char-capped here (recent rounds stay complete).
 */
function computeDecomposeLimits(budgets: ReturnType<typeof contextBudgets>): {
  preferenceChars: number;
} {
  // budgets.plan = history segment budget in tokens (~4 chars/token, with safety factor)
  const planChars = budgets.plan * 4 * CHAR_TOKEN_SAFETY;
  // Decompose context gets ~20% of history budget, clamped to safe range
  const budget = Math.max(6_000, Math.min(20_000, Math.floor(planChars * 0.20)));
  const preferenceChars = Math.max(800, Math.floor(budget * 0.30));
  return { preferenceChars };
}

interface StructuredRound {
  userInput: string;
  taskDecompose?: string;
  assistantReport?: string;
  transcript?: string;
}

function stripConversationHistoryTags(content: string): string {
  return content
    .replace(/<conversation_history>\s*/gi, "")
    .replace(/\s*<\/conversation_history>/gi, "")
    .trim();
}

function messageText(turn: ChatTurn): string {
  if (Array.isArray(turn.parts) && turn.parts.length > 0) {
    const parts = turn.parts
      .map((part) => {
        switch (part.type) {
          case "text":
          case "thinking":
            return part.text.trim();
          case "tool_result":
            return "";
          case "tool_use":
            return `[${part.name}]${Object.keys(part.input).length > 0 ? ` ${JSON.stringify(part.input)}` : ""}`;
          default:
            return "";
        }
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }
  return typeof turn.content === "string" ? turn.content.trim() : "";
}

/**
 * 短句式的“继续改代码”不能被当成讨论请求。任务分解阶段必须把这类
 * 当前输入路由到实现流程，而不是让下游模型自行生成 need_details。
 */
function isExplicitCodeChangeRequest(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return /(改代码|修改代码|修复代码|修一下|修复这个|实现一下|加一下|写代码|直接改|请修改|帮我改|fix\s+(this|it|the)|change\s+(the\s+)?code|implement)/i.test(text);
}

/**
 * 询问「当前代码 / 当前步骤如何处理 X」必须进入定位阅读链路。
 * 模型常把 inquire 映射成 discuss 并清空 steps；运行时在此兜底。
 * Exported for testing.
 */
export function isCurrentCodeBehaviorInquiry(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  const asksCurrentZh =
    /(当前|现在|现有|这段|这个).{0,24}(代码|实现|步骤|这一步|阶段|流水线|处理).{0,40}(如何处理|怎么处理|怎样处理|是怎么|是如何|如何工作|怎么工作)/i.test(text)
    || /(如何处理|怎么处理|怎样处理|是怎么|是如何).{0,24}(当前|现在|现有|这段|这个).{0,24}(代码|实现|步骤|这一步|阶段|流水线)/i.test(text)
    || /(现在|当前).{0,20}(这一步|步骤|阶段).{0,40}(如何处理|怎么处理|怎样处理|是怎么|是如何)/i.test(text);
  const asksCurrentEn =
    /how\s+(?:is|does|do)\s+(?:the\s+)?(?:current|existing|this)\b[\s\S]{0,80}(?:code|implementation|step|stage|pipeline)\b[\s\S]{0,40}(?:handle|process|work)/i.test(text)
    || /how\s+(?:the\s+)?(?:current|existing|this)\b[\s\S]{0,80}(?:code|implementation|step|stage|pipeline)\b[\s\S]{0,40}(?:handle|process|work)/i.test(text);
  return asksCurrentZh || asksCurrentEn;
}

function extractDecomposeJson(content: string): string | undefined {
  if ((!content.includes("intent") && !content.includes("understanding"))
    || (!content.includes("tasks") && !content.includes("steps"))) return undefined;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || content.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return undefined;
  const isDecomposeShape = (parsed: unknown): boolean =>
    typeof parsed === "object" && parsed !== null
    && ("intent" in parsed || "understanding" in parsed)
    && ("tasks" in parsed || "steps" in parsed);
  try {
    const parsed = JSON.parse(candidate);
    return isDecomposeShape(parsed)
      ? JSON.stringify(parsed, null, 2)
      : undefined;
  } catch {
    try {
      const parsed = JSON.parse(jsonrepair(candidate));
      return isDecomposeShape(parsed)
        ? JSON.stringify(parsed, null, 2)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * 从历史中提取结构化的轮次。
 * 每一轮 = 用户输入 + (可选)任务分解 + (可选)LLM报告
 * 
 * @param history - 完整的对话历史
 * @param minRounds - 最少提取的轮次数
 * @param excludeCurrentTurn - 是否排除当前轮（最后一条可能是当前用户输入）
 */
export function extractStructuredHistory(
  history: ChatTurn[],
  minRounds: number,
  excludeCurrentTurn = true,
): StructuredRound[] {
  const rounds: StructuredRound[] = [];
  let current: StructuredRound | null = null;
  const finish = () => {
    if (!current) return;
    current.transcript = current.transcript?.trim();
    rounds.push(current);
    current = null;
  };

  for (const turn of history) {
    const content = messageText(turn);
    if (turn.role === "user") {
      finish();
      current = { userInput: content || "(empty)" };
      continue;
    }
    if (!current || !content || turn.role === "system") continue;

    const label = turn.role === "tool" ? `tool${turn.toolName ? `:${turn.toolName}` : ""}` : turn.role;
    // Tool output is execution detail, not task context. Keep only the tool
    // activity marker in the fallback history path so large read/search results
    // do not get copied into the decomposition prompt.
    const clean = turn.role === "tool"
      ? `[${label}]`
      : stripConversationHistoryTags(content);
    if (!clean) continue;
    const line = turn.role === "tool" ? clean : `[${label}] ${clean}`;
    current.transcript = current.transcript ? `${current.transcript}\n${line}` : line;

    if (turn.role === "assistant") {
      const decompose = extractDecomposeJson(clean);
      if (decompose) current.taskDecompose = decompose;
      else current.assistantReport = current.assistantReport
        ? `${current.assistantReport}\n${clean}`
        : clean;
    }
  }
  finish();

  if (excludeCurrentTurn && history.at(-1)?.role === "user" && rounds.at(-1)?.userInput === messageText(history.at(-1)!)) {
    rounds.pop();
  }
  return rounds.slice(-minRounds);
}

/** 历史工具召回相关度下限：低于此值的历史片段丢弃（60%）。 */
export const RELEVANT_HISTORY_SCORE_THRESHOLD = 0.6;

/** 召回历史片段（含相关度，已按 score 降序且过滤阈值）。 */
export interface RecalledHistoryChunk {
  turnIndex: number;
  role: string;
  content: string;
  /** [0,1] 相关度；越高越相关。 */
  score: number;
}

/** 将历史工具召回的片段格式化为工具结果（整段不截断）。 */
export function formatRecalledHistoryChunks(
  chunks: Array<{ turnIndex: number; role: string; content: string; score?: number }>,
): string {
  return chunks
    .map((chunk, idx) => {
      const scorePart = typeof chunk.score === "number"
        ? ` [score=${(chunk.score * 100).toFixed(0)}%]`
        : "";
      return `## Recalled ${idx + 1} [turnIndex=${chunk.turnIndex}] [${chunk.role}]${scorePart}\n${chunk.content}`;
    })
    .join("\n\n");
}

/**
 * 按相关度降序排列，并丢弃 score < threshold 的命中。
 * 无 score 的项视为 0（不保留），避免未评分噪声进入上下文。
 */
export function rankAndFilterByRelevance<T extends { score?: number }>(
  items: readonly T[],
  threshold = RELEVANT_HISTORY_SCORE_THRESHOLD,
): T[] {
  return items
    .filter((item) => typeof item.score === "number" && Number.isFinite(item.score) && item.score >= threshold)
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}


/**
 * Assemble the context this stage reads before decomposing.
 *
 * The previous version passed `opts.userMessage` alone — no history, no user
 * preferences, no project rules, no plan state. That made a turn like "还是不行"
 * literally undecodable: it was decomposed as if it were a standalone
 * instruction, and the resulting plan `goal` was a 200-character truncation of
 * the raw text. Reading a request correctly needs the conversation it lives in.
 *
 * Limits are now derived from context budget settings (contextWindow / inputRatio /
 * segments.historyRatio) via `budgets` instead of hardcoded constants.
 *
 * 历史拼装口径：仅注入最近 5 轮，整轮不截断。
 */
export async function buildDecomposeContext(
  opts: AgentLoopOpts,
  budgets: ReturnType<typeof contextBudgets>,
): Promise<string> {
  const limits = computeDecomposeLimits(budgets);
  const sections: string[] = [`Mode: ${opts.mode}`];

  const { tagConversationHistory } = await import("../../message-tags.js");
  const { loadRecentRounds, formatRoundsForDecomposeHistory } = await import("../../../turn-rounds.ts");

  // Prefer persisted rounds (has decompose JSON + evidence). Fall back to
  // heuristic extraction from chat history for sessions predating the store.
  const minRounds = 5;
  let roundLines: string[] = [];
  let source: "persisted" | "heuristic" = "heuristic";
  let persisted: Awaited<ReturnType<typeof loadRecentRounds>> = [];

  if (opts.sessionId) {
    persisted = await loadRecentRounds(opts.workspaceRoot, opts.sessionId, minRounds);
    if (persisted.length > 0) {
      source = "persisted";
      // 最近 5 轮完整保留：含用户输入与召回的 evidence/fileChanges，不做每轮截断。
      roundLines = formatRoundsForDecomposeHistory(persisted);
    }
  }

  // 即使结构化轮次来自持久化 rounds，也显式把当前上传图片 URL 放进分解历史；
  // URL 不写入用户正文，避免图片在文本历史路径中丢失。
  const currentAttachmentUrls = (opts.attachments ?? []).map((attachment) => attachment.url).filter(Boolean);
  if (currentAttachmentUrls.length > 0) {
    roundLines.unshift(`## Current uploaded images\n${currentAttachmentUrls.map((url) => `- ${url}`).join("\n")}`);
  }

  if (roundLines.length === 0) {
    // Fallback: heuristic extraction (no decompose JSON, no evidence).
    const structuredHistory = extractStructuredHistory(opts.history, minRounds, true);
    roundLines = structuredHistory.slice().reverse().map((round, idx) => {
      const parts: string[] = [`## Round ${idx + 1}`, `[user] ${stripConversationHistoryTags(round.userInput)}`];
      if (round.taskDecompose) parts.push(`[decompose] ${round.taskDecompose}`);
      if (round.assistantReport) parts.push(`[assistant] ${round.assistantReport}`);
      if (round.transcript) parts.push(`[transcript]\n${round.transcript}`);
      // 与持久化路径一致：每轮完整注入，不做截断。
      return parts.join("\n");
    });
  }


  writeEventLog({
    category: "other",
    message: "任务分解历史提取",
    details: {
      source,
      totalHistoryTurns: opts.history.length,
      roundCount: roundLines.length,
    },
  });

  const historySections: string[] = [];
  if (roundLines.length > 0) {
    historySections.push(
      `### Recent conversation rounds (background)\n${roundLines.join("\n\n")}`,
    );
  }

  if (historySections.length > 0) {
    sections.push(tagConversationHistory(historySections.join("\n\n")));
  }
  const latestRound = persisted.at(-1);
  if (latestRound?.taskDecompose) {
    sections.push(
      `### Resumable task state\n${JSON.stringify(latestRound.taskDecompose, null, 2)}`,
    );
  }

  if (opts.memoriesBlock?.trim()) {
    sections.push(
      `### Saved user preferences\n${clipBlock(opts.memoriesBlock.trim(), limits.preferenceChars)}`,
    );
  }
  if (opts.projectRules?.trim()) {
    sections.push(
      `### Project rules\n${clipBlock(opts.projectRules.trim(), limits.preferenceChars)}`,
    );
  }

  const planState = agentIntentContext(opts.activePlan, opts.activeTasks, opts.currentTaskId);
  if (planState) {
    sections.push(`### Plan state\n${planState}`);
  }
  if (opts.documentWorkflow) {
    sections.push(`### Document workflow\n${documentIntentContext(opts.documentWorkflow)}`);
  }

  return sections.join("\n\n");
}

// ── Decompose Answer Parsing ───────────────────────────────────────

/**
 * Parsed shape of the decomposition answer: the user's intent, the limits the
 * user has set, and the tasks (each with its steps) that follow from both.
 */
interface DecomposeStep {
  id: string;
  description: string;
  dependsOn: string[];
  relevantHistory?: string;
  verificationCriteria?: TaskItem["verificationCriteria"];
  rollbackStrategy?: string;
  estimatedComplexity?: TaskItem["estimatedComplexity"];
}

interface DecomposeTask {
  id: string;
  description: string;
  userConstraints: string[];
  steps: DecomposeStep[];
  relevantHistory: string;
  progressStatus: string;
}

interface DecomposeAnswer {
  /** 用户意图目的（旧格式 understanding 兜底映射）。 */
  intent: string;
  userConstraints: string[];
  tasks: DecomposeTask[];
}

/**
 * 归一化便捷方法：把 tasks[].steps 摊平为单一有序步骤列表，供调度侧
 * （信息任务构建、循环检测、历史注入等）直接使用。
 */
export function flattenSteps<T>(
  source: { tasks: ReadonlyArray<{ steps: ReadonlyArray<T> }> } | null | undefined,
): T[] {
  return (source?.tasks ?? []).flatMap((task) => [...task.steps]);
}

/**
 * 检测同 task 内 steps 是否存在环依赖（dependsOn 仅允许指向同 task 步骤）。
 * Exported for testing.
 */
export function detectCircularDependency(steps: ReadonlyArray<{ id: string; dependsOn: string[] }>): boolean {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const hasCycle = (stepId: string): boolean => {
    if (recursionStack.has(stepId)) return true;
    if (visited.has(stepId)) return false;

    visited.add(stepId);
    recursionStack.add(stepId);

    const step = steps.find((s) => s.id === stepId);
    if (step) {
      for (const dep of step.dependsOn) {
        if (hasCycle(dep)) return true;
      }
    }

    recursionStack.delete(stepId);
    return false;
  };

  for (const step of steps) {
    if (hasCycle(step.id)) return true;
  }
  return false;
}

/**
 * 按 task 分别做环检；若某 task 有环，则清空该 task 内 dependsOn，
 * 并用 `${task.id}_step_${n}` 重编 id，保证跨 task 全局唯一。
 * Exported for testing.
 */
export function resolveCircularDependenciesInTasks<
  TStep extends { id: string; dependsOn: string[] },
  TTask extends { id: string; steps: TStep[] },
>(
  tasks: TTask[],
): { tasks: TTask[]; hadCycle: boolean; cycledTaskIds: string[] } {
  const cycledTaskIds: string[] = [];
  const nextTasks = tasks.map((task) => {
    if (!detectCircularDependency(task.steps)) return task;
    cycledTaskIds.push(task.id);
    return {
      ...task,
      steps: task.steps.map((step, index) => ({
        ...step,
        dependsOn: [] as string[],
        id: `${task.id}_step_${index + 1}`,
      })),
    } as TTask;
  });
  return {
    tasks: nextTasks,
    hadCycle: cycledTaskIds.length > 0,
    cycledTaskIds,
  };
}

function buildInspectCurrentCodeSteps(userMessage: string): DecomposeStep[] {
  return [{
    id: "step_1",
    description: `定位并阅读与用户问题相关的当前实现：${userMessage}`,
    dependsOn: [],
  }];
}

/**
 * 本地兜底分解。
 * - intent：只用用户原话（截断保护），禁止把模型散文整段写入 intent
 * - 若有模型纯文本（解析失败时的 planText）：收成单一 task，避免丢弃有用内容
 * - 无模型纯文本（网络/中止等）：用本地 generatePlan 生成可执行 steps
 * Exported for testing.
 */
export function buildFallbackRawDecompose(userMessage: string, modelPlainText?: string) {
  const seed = userMessage.trim() || "(empty request)";
  // 截断异常长输入，避免把整段粘贴内容当 intent 展示
  const intent = seed.length > 500 ? `${seed.slice(0, 500)}…` : seed;
  const prose = (modelPlainText ?? "").trim();

  if (prose) {
    // 保留模型纯文本作为单一 task；过长时截断，避免 UI/持久化膨胀
    const taskBody = prose.length > 8000 ? `${prose.slice(0, 8000)}…` : prose;
    return {
      intent,
      userConstraints: [] as string[],
      tasks: [{
        id: "task_1",
        description: taskBody,
        userConstraints: [],
        steps: [{
          id: "task_1_step_1",
          description: taskBody,
          dependsOn: [],
        }],
        relevantHistory: "",
        progressStatus: "pending",
      }],
    };
  }

  const plan = generatePlan(intent, "");
  return {
    intent,
    userConstraints: [] as string[],
    tasks: [{
      id: "task_1",
      description: intent,
      userConstraints: [],
      steps: plan.steps.map((step, index) => ({
        id: step.id || `step_${index + 1}`,
        description: step.description,
        dependsOn: [],
      })),
      relevantHistory: "",
      progressStatus: "pending",
    }],
  };
}

/**
 * 模型把改码或查代码请求判成 discuss 并输出空 steps 时，按用户原话补回可执行步骤。
 * Exported for testing.
 */
export function recoverEmptyDecomposeSteps(
  answer: DecomposeAnswer,
  userMessage: string,
): DecomposeAnswer {
  if (flattenSteps(answer).length > 0) return answer;
  if (isExplicitCodeChangeRequest(userMessage)) {
    return {
      ...answer,
      intent: answer.intent || `用户要求直接修改代码：${userMessage}`,
      tasks: [{
        id: "task_1",
        description: `定位并修改与用户请求相关的代码：${userMessage}`,
        userConstraints: answer.userConstraints,
        steps: [{
          id: "step_1",
          description: `定位并修改与用户请求相关的代码：${userMessage}`,
          dependsOn: [],
        }],
        relevantHistory: "",
        progressStatus: "pending",
      }],
    };
  }
  if (isCurrentCodeBehaviorInquiry(userMessage)) {
    return {
      ...answer,
      intent: answer.intent || `用户询问当前代码/当前步骤如何处理：${userMessage}`,
      tasks: [{
        id: "task_1",
        description: `定位并阅读与用户问题相关的当前实现：${userMessage}`,
        userConstraints: answer.userConstraints,
        steps: buildInspectCurrentCodeSteps(userMessage),
        relevantHistory: "",
        progressStatus: "pending",
      }],
    };
  }
  return answer;
}

// Information needs parsing removed - no longer used

function parseVerificationCriteria(value: unknown): TaskItem["verificationCriteria"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.command !== "string" || typeof raw.expectedOutput !== "string") return undefined;
  const command = raw.command.trim();
  const expectedOutput = raw.expectedOutput.trim();
  if (!command || !expectedOutput) return undefined;
  return {
    command,
    expectedOutput,
    exitCode: typeof raw.exitCode === "number" ? raw.exitCode : undefined,
  };
}

function parseEstimatedComplexity(value: unknown): TaskItem["estimatedComplexity"] {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

const MAX_FALLBACK_HISTORY_CHARS = 12_000;

/**
 * 从查询中提取用于相关度匹配的词元：
 * - 拉丁/数字标识符（长度 ≥2）
 * - 连续中文按 2-gram 切分，避免整句中文变成一个超长 token 导致几乎永不命中
 */
function relevanceTerms(query: string): string[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const terms = new Set<string>();
  for (const raw of q.match(/[\p{L}\p{N}_./:-]+/gu) ?? []) {
    const token = raw.trim();
    if (!token) continue;
    if (/[\u4e00-\u9fff]/.test(token)) {
      if (token.length === 1) {
        terms.add(token);
      } else {
        for (let i = 0; i < token.length - 1; i++) {
          terms.add(token.slice(i, i + 2));
        }
        // 短词整段保留，便于「缓存」「登录」等直接命中
        if (token.length <= 4) terms.add(token);
      }
    } else if (token.length >= 2) {
      terms.add(token);
    }
  }
  return [...terms].slice(0, 32);
}

/**
 * 简易文本相关度（0–1）：查询词元在候选文本中的覆盖率。
 * 用于 fallback 打包时对已读文件 / 对话要点排序与 <0.6 过滤。
 */
export function estimateTextRelevance(query: string, text: string): number {
  const q = query.trim().toLocaleLowerCase();
  const t = text.trim().toLocaleLowerCase();
  if (!q || !t) return 0;

  const terms = relevanceTerms(q);
  if (terms.length === 0) {
    return t.includes(q) ? 1 : 0;
  }
  const hits = terms.filter((term) => t.includes(term)).length;
  let score = hits / terms.length;

  // 路径/标识符强命中加权：basename 或关键 token 命中时抬到至少阈值，避免「login.ts」被中文噪声词拖死
  const strong = terms.filter((term) =>
    /^[a-z0-9_./:-]+$/i.test(term) && term.length >= 3 && t.includes(term),
  );
  if (strong.length > 0) {
    score = Math.max(score, Math.min(1, 0.5 + 0.2 * strong.length));
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * 若 LLM 未返回 relevantHistory，从近期历史本地打包成文本（已读文件 + 对话要点等），
 * 按与当前用户输入的相关度降序，并丢弃 < 0.6 的块，供 React 循环直接复用。
 */
export function packFallbackRelevantHistory(
  opts: Pick<AgentLoopOpts, "history" | "userMessage">,
): string | undefined {
  const sections: string[] = [];
  const query = opts.userMessage?.trim() ?? "";
  // 无当前用户输入时无法打分：保留原顺序与上限，不做 <0.6 丢弃。
  const canScore = query.length > 0;

  const collected = collectReadEvidenceFromTurns(
    opts.history.map((turn) => ({
      role: turn.role,
      toolName: turn.toolName,
      content: typeof turn.content === "string" ? turn.content : undefined,
    })),
  );
  type ScoredFile = {
    path: string;
    content: string;
    startLine?: number;
    endLine?: number;
    note?: string;
    score: number;
  };
  const files: ScoredFile[] = [];
  const seen = new Set<string>();
  for (const item of collected) {
    const path = item.path?.trim();
    const content = item.fileEvidence?.content || item.excerpt || "";
    if (!path || !content) continue;
    const key = `${path}:${item.startLine ?? ""}:${item.endLine ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const score = canScore
      ? estimateTextRelevance(query, `${path}\n${content}\n${item.summary ?? ""}`)
      : 1;
    files.push({
      path,
      content,
      startLine: item.startLine,
      endLine: item.endLine,
      note: item.summary || "Already read in recent history; reuse instead of reading again",
      score,
    });
    if (!canScore && files.length >= 8) break;
  }
  const rankedFiles = (canScore
    ? rankAndFilterByRelevance(files, RELEVANT_HISTORY_SCORE_THRESHOLD)
    : files
  ).slice(0, 8);
  const fileText = JSON.stringify({
    files: rankedFiles.map(({ path, content, startLine, endLine, note }) => ({
      path,
      content,
      startLine,
      endLine,
      note,
    })),
  });
  if (fileText) sections.push(fileText);

  type ScoredDialogue = { text: string; score: number };
  const dialogueBlocks: ScoredDialogue[] = [];
  for (const round of extractStructuredHistory(opts.history, 5, true)) {
    const parts: string[] = [];
    if (round.userInput && round.userInput !== "(empty)") {
      parts.push(`user: ${clipBlock(round.userInput, 400)}`);
    }
    if (round.taskDecompose) {
      try {
        const parsed = JSON.parse(round.taskDecompose) as Record<string, unknown>;
        // 新格式 intent；旧持久化数据的理解段兜底映射。
        const intent = typeof parsed.intent === "string" && parsed.intent.trim()
          ? parsed.intent
          : parsed.understanding;
        if (typeof intent === "string" && intent.trim()) {
          parts.push(`intent: ${clipBlock(intent.trim(), 400)}`);
        }
        if (Array.isArray(parsed.userConstraints)) {
          const constraints = parsed.userConstraints
            .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
            .map((c) => c.trim());
          if (constraints.length > 0) {
            parts.push(`constraints: ${clipBlock(constraints.join("; "), 400)}`);
          }
        }
      } catch {
        // 分解 JSON 损坏时跳过，不影响其它历史块
      }
    }
    if (round.assistantReport) {
      parts.push(`assistant: ${clipBlock(round.assistantReport, 600)}`);
    }
    if (parts.length > 0) {
      const text = parts.join("\n");
      dialogueBlocks.push({
        text,
        score: canScore ? estimateTextRelevance(query, text) : 1,
      });
    }
  }
  const rankedDialogue = (canScore
    ? rankAndFilterByRelevance(dialogueBlocks, RELEVANT_HISTORY_SCORE_THRESHOLD)
    : dialogueBlocks
  ).map((block) => block.text);
  if (rankedDialogue.length > 0) {
    sections.push(`## 近期对话要点\n\n${rankedDialogue.join("\n\n")}`);
  }

  const packed = sections.join("\n\n").trim();
  if (!packed) return undefined;
  return packed.length > MAX_FALLBACK_HISTORY_CHARS
    ? `${packed.slice(0, MAX_FALLBACK_HISTORY_CHARS)}…`
    : packed;
}



/**
 * Parse the answer. Tolerant by design — a malformed field degrades to a safe
 * default rather than failing the turn.
 *
 * New shape: top-level `intent` + `tasks[].steps`. Old shapes are normalized:
 * a top-level `steps` array (or bare JSON array) is wrapped into a single
 * `task_1`, and a legacy `understanding` fills `intent`. Removed legacy keys
 * (goal/scope/relation/completedSteps/pendingSteps/findings/checkpoints/
 * sharedEvidence) are ignored without migration.
 *
 * Exported for testing.
 */
export function parseDecomposeAnswer(text: string): DecomposeAnswer | null {
  // 防止无限循环：限制最大任务数与步骤数
  const MAX_TASKS = 20;
  const MAX_STEPS = 20;


  // 先剥 Markdown 围栏，再取 JSON；避免模型「解释 + ```json ... ```」时整段失败
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const normalized = fenced || text;

  const objectMatch = normalized.match(/\{[\s\S]*\}/);
  const arrayMatch = normalized.match(/\[[\s\S]*\]/);
  // Prefer whichever encloses the other: an object wrapping "tasks" starts before
  // the array it contains.
  const source =
    objectMatch && (!arrayMatch || objectMatch.index! < arrayMatch.index!)
      ? objectMatch[0]
      : arrayMatch?.[0];
  if (!source) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(jsonrepair(source));
  } catch {
    return null;
  }

  const obj = (Array.isArray(raw) ? {} : raw ?? {}) as Record<string, unknown>;

  // 新格式 tasks[] 优先；旧格式（顶层 steps / 裸数组）包成单个 task_1。
  const rawTasks: unknown[] = Array.isArray(obj.tasks)
    ? obj.tasks.slice(0, MAX_TASKS)
    : [{
        id: "task_1",
        description: "",
        userConstraints: [],
        steps: (Array.isArray(raw) ? raw : Array.isArray(obj.steps) ? obj.steps : []).slice(0, MAX_STEPS),
        relevantHistory: "",
        progressStatus: "pending",
      }];

  const usedStepIds = new Set<string>();
  const usedTaskIds = new Set<string>();
  const uniqueId = (base: string, used: Set<string>): string => {
    const seed = base || "step";
    if (!used.has(seed)) {
      used.add(seed);
      return seed;
    }
    let suffix = 2;
    while (used.has(`${seed}_${suffix}`)) suffix++;
    const id = `${seed}_${suffix}`;
    used.add(id);
    return id;
  };

  const parseTaskSteps = (rawSteps: unknown[]): DecomposeStep[] => {
    const localStepIds = new Set<string>();
    // 限制步骤数量，防止无限循环
    const limitedRawSteps = rawSteps.slice(0, MAX_STEPS);
  
    // 检测重复步骤：如果连续多个步骤描述完全相同，则只保留一个
    const deduplicatedSteps = [];
    let lastDescription = "";
    let duplicateCount = 0;
  
    for (let i = 0; i < limitedRawSteps.length; i++) {
      const step = (limitedRawSteps[i] ?? {}) as Record<string, unknown>;
      const description = typeof step.description === "string" ? step.description.trim() : "";
    
      if (!description) continue;
    
      // 检测重复模式
      if (description === lastDescription) {
        duplicateCount++;
        // 如果连续3个相同的步骤，说明可能陷入循环，跳过后续重复
        if (duplicateCount >= 2) {
          console.warn(`[task_decompose] 检测到重复步骤，跳过: ${description}`);
          continue;
        }
      } else {
        duplicateCount = 0;
        lastDescription = description;
      }
    
      deduplicatedSteps.push({step, i: deduplicatedSteps.length});
    }

    const steps = deduplicatedSteps
      .map(({step, i}) => {
        const description = typeof step.description === "string" ? step.description.trim() : "";
        if (!description) return null;

        const requestedId = typeof step.id === "string" && step.id.trim() ? step.id.trim() : `step_${i + 1}`;
        const normalizedId = uniqueId(requestedId, usedStepIds);
        localStepIds.add(normalizedId);
        return {
          id: normalizedId,
          description,
          dependsOn: Array.isArray(step.dependsOn)
            ? step.dependsOn.filter((d): d is string => typeof d === "string")
            : [],
          relevantHistory: typeof step.relevantHistory === "string" ? step.relevantHistory.trim() : undefined,
          verificationCriteria: parseVerificationCriteria(step.verificationCriteria),
          rollbackStrategy: typeof step.rollbackStrategy === "string"
            ? step.rollbackStrategy.trim() || undefined
            : undefined,
          estimatedComplexity: parseEstimatedComplexity(step.estimatedComplexity),
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    // dependsOn is task-local: discard unknown and cross-task references during normalization.
    return steps.map((step) => ({
      ...step,
      dependsOn: step.dependsOn
        .filter((dependency): dependency is string => localStepIds.has(dependency)),
    }));
  };

  const tasks: DecomposeTask[] = rawTasks.flatMap((rawTask) => {
    const taskObj = (rawTask ?? {}) as Record<string, unknown>;
    const steps = parseTaskSteps(Array.isArray(taskObj.steps) ? taskObj.steps : []);
    const id = typeof taskObj.id === "string" && taskObj.id.trim() ? taskObj.id.trim() : "";
    const description = typeof taskObj.description === "string" ? taskObj.description.trim() : "";
    // 任务间依赖不在 schema 内：显式丢弃 tasks[].dependsOn，仅保留 steps[].dependsOn。
    if ("dependsOn" in taskObj && taskObj.dependsOn != null) {
      console.warn(
        `[task_decompose] 忽略 tasks[].dependsOn（仅支持同 task 内 steps[].dependsOn）: ${id || "(unnamed)"}`,
      );
    }
    const userConstraints = Array.isArray(taskObj.userConstraints)
      ? taskObj.userConstraints
          .filter((c): c is string => typeof c === "string")
          .map((c) => c.trim())
          .filter(Boolean)
      : [];
    const relevantHistory = typeof taskObj.relevantHistory === "string" ? taskObj.relevantHistory.trim() : "";
    const progressStatus = typeof taskObj.progressStatus === "string" && taskObj.progressStatus.trim()
      ? taskObj.progressStatus.trim()
      : "pending";
    return [{ id: uniqueId(id || `task_${usedTaskIds.size + 1}`, usedTaskIds), description, userConstraints, steps, relevantHistory, progressStatus }];
  });

  // 兼容旧格式：understanding 兜底填充 intent。
  const intent = typeof obj.intent === "string" && obj.intent.trim()
    ? obj.intent.trim()
    : typeof obj.understanding === "string" ? obj.understanding.trim() : "";

  const topLevelConstraints = Array.isArray(obj.userConstraints)
    ? obj.userConstraints.map((c) => (typeof c === "string" ? c.trim() : "")).filter(Boolean)
    : [];
  return {
    intent,
    userConstraints: topLevelConstraints,
    tasks: tasks.map((task, taskIndex) => ({
      ...task,
      id: task.id || `task_${taskIndex + 1}`,
      userConstraints: task.userConstraints.length > 0 ? task.userConstraints : topLevelConstraints,
    })),
  };
}

/**
 * Convert this turn's decomposition into a task with stop criteria.
 * No longer tracks information needs - stop criteria are evaluated directly.
 */
function buildTurnInformationTask(): TaskItem | null {
  return null;
}

/**
 * Replace the `__STOP_READING_START__...__STOP_READING_END__` block in the
 * FORCED_APPEND system prompt with either concrete conditions derived from the
 * task decomposition (when information needs exist) or the generic sufficiency
 * test (when there are no needs). This keeps the stop criterion specific to the
 * current step rather than referring to a separate "Information plan" message.
 */
export function injectStopConditions(
  systemPrompt: string,
): string {
  return systemPrompt;
}

// ── Main Task Decompose Function ───────────────────────────────────

export async function runTaskDecompose(
  opts: AgentLoopOpts,
  model: ModelRef,
  tracer: Tracer,
  memory: MemoryManager,
  reasoningTrace: ReasoningTrace,
  budgets: ReturnType<typeof contextBudgets>,
  prompt?: string,
  messages?: ChatMessage[],
): Promise<{ 
  task: TaskItem | null; 
  decomposeTokens: number;
  rawDecompose?: {
    intent: string;
    userConstraints?: string[];
    progressStatus?: string;
    tasks: Array<{
      id: string;
      description: string;
      userConstraints?: string[];
      relevantHistory?: string;
      progressStatus?: string;
      steps: Array<{
        id: string;
        description: string;
        dependsOn: string[];
        relevantHistory?: string;
        verificationCriteria?: TaskItem["verificationCriteria"];
        rollbackStrategy?: string;
        estimatedComplexity?: TaskItem["estimatedComplexity"];

      }>;
    }>;
    /** 方案A：整单共享上下文（每个 step 也自带一份） */

  };
  fallback?: boolean;
}> {
  assertLlmAuth(model, opts.llmApiKey);
  // Track how many tokens the decomposition pushes into messages so the
  // downstream ReAct loop can deduct them from the dynamic-segment budget.
  let decomposeTokens = 0;

  const planSpanId = tracer.startSpan("task_decomposition", "internal");
  // Runtime always uses the English decompose prompt. When the pipeline node
  // explicitly supplies `prompt`, that override wins.
  const systemPrompt = prompt?.trim() || BUILTIN_TASK_DECOMPOSE_PROMPT;
  try {
    const { tagUserInput } = await import("../../message-tags.js");
    // 分解是 JSON 协议调用：语言指令只作用于 JSON 字符串字段。
    // 不得使用 localeSystemPrompt 的 "Always reply in …"，否则会诱导独立散文。
    const localePrompt = localeJsonValuesPrompt(opts.workflow.harness.locale);
    const sessionAttachments = opts.history
      .flatMap((turn) => turn.attachments ?? [])
      .concat(opts.attachments ?? [])
      .filter((attachment, index, all) => all.findIndex((item) => item.url === attachment.url) === index);
    const decomposeMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "system", content: localePrompt },
      {
        role: "user",
        content: [
          tagUserInput(opts.userMessage),
          sessionAttachments.length > 0
            ? `## Uploaded image URLs (preserve these URLs in this task context)\n${sessionAttachments.map((attachment) => `- ${attachment.url}`).join("\n")}`
            : "",
          `## CONTEXT (background information)\n${await buildDecomposeContext(opts, budgets)}`,
        ].filter(Boolean).join("\n\n"),
        attachments: sessionAttachments,
      },
    ];

    // 任务分解是内部协议调用：走非流式 chatCompletion。这是结构化 JSON
    // 规划，不是实现推理——默认 high 思考会先烧 16k thinking tokens 再吐
    // JSON，体感极慢。固定 low：保留轻量意图判断，不跟主循环抢思考预算。
    // 不注册 onDelta/onThinkingDelta，reasoning 不进入聊天 UI。
    
    // 历史召回工具：前两次任务分解提供，第三次开始不提供（避免循环重分解）
    // opts.historyVector 存在时才提供工具（无向量索引时工具无法执行）
    const recentContextRounds = opts.sessionId
      ? await loadRecentRounds(opts.workspaceRoot, opts.sessionId, 5)
      : [];
    const recentHistoryBoundary = recentContextRounds.length >= 5
      ? recentContextRounds[0]?.index ?? 0
      : 0;
    const historyRecallTool = opts.historyVector && opts.sessionId ? [{
      type: "function" as const,
      function: {
        name: "recall_history_for_task_decompose",
        description:
          "Retrieve relevant archived history strictly before the recent five-round context window for task decomposition. " +
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
          },
          required: ["query"],
        },
      },
    }] : [];
    
    // 工具调用循环：持续调用LLM直到获得最终JSON（无tool_calls）
    const conversationMessages = [...decomposeMessages];
    let planText = "";
    let totalTokens = 0;
    let toolCallCount = 0;
    const maxToolCalls = 5; // 防止无限循环

    while (toolCallCount < maxToolCalls) {
      const planResult = await withRetry(
        () => chatCompletion(model, conversationMessages, {
          signal: opts.signal,
          apiKey: opts.llmApiKey,
          purpose: "task_decompose",
          taskId: opts.sessionId,
          thinking: { effort: "low" },
          tools: historyRecallTool,
        }),
        { maxRetries: 1, baseDelay: 3000, signal: opts.signal },
      );

      // 提取响应中的content和tool_calls
      const choice = (planResult.result as { 
        choices?: Array<{ 
          message?: { 
            content?: string | null; 
            tool_calls?: Array<{ 
              id: string; 
              type: string; 
              function: { name: string; arguments: string };
            }>;
          }; 
          finish_reason?: string;
        }>; 
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } 
      }).choices?.[0];

      if (!choice?.message) break;

      const content = choice.message.content ?? "";
      const toolCalls = choice.message.tool_calls;
      
      // 记录token使用
      const planUsage = normalizeUsage(
        (planResult.result as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage,
        conversationMessages.map((message) => String(message.content ?? "")).join("\n"),
        content,
      );
      tracer.recordTokenUsage(planUsage.promptTokens, planUsage.completionTokens);
      totalTokens += planUsage.promptTokens + planUsage.completionTokens;

      // 如果没有tool_calls，这是最终响应
      if (!toolCalls || toolCalls.length === 0) {
        planText = content;
        break;
      }

      // 有tool_calls：执行工具
      toolCallCount++;
      
      // 添加assistant消息（包含tool_calls）
      conversationMessages.push({
        role: "assistant",
        tool_calls: toolCalls as ToolCall[],
      });

      // 执行所有tool_calls
      for (const toolCall of toolCalls) {
        let toolResult = "";
        
        if (toolCall.function.name === "recall_history_for_task_decompose") {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            const query = typeof args.query === "string" ? args.query : "";
            const historyVector = opts.historyVector;
            if (!historyVector || !opts.sessionId) {
              toolResult = "No searchable session history is available.";
            } else {
              const result = await recallHistoryForTaskDecompose(
                { ...historyVector, sessionId: opts.sessionId },
                query,
                recentHistoryBoundary,
              );
              toolResult = result.output;
            }
          } catch (err) {
            toolResult = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // 添加tool_result消息
        conversationMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult,
        } as ChatMessage);
      }

      // 继续循环以获得下一个响应
    }

    if (toolCallCount >= maxToolCalls) {
      console.warn(`[task_decompose] 达到最大工具调用次数 (${maxToolCalls})，停止循环`);
      writeEventLog({
        category: "stage_error",
        message: `task_decompose 工具调用循环次数过多 (≥${maxToolCalls})，已停止`,
        details: {
          sessionId: opts.sessionId,
          toolCallCount,
        },
      });
    }

    let answer = parseDecomposeAnswer(planText);

    // 明确的改码请求、以及「当前代码/当前步骤如何处理」的询问，都不能因
    // 模型把短句判成 discuss 而留下空 steps。
    if (answer) {
      answer = recoverEmptyDecomposeSteps(answer, opts.userMessage);
      // 兼容旧的自定义 prompt（只输出 understanding，解析层已兜底映射为 intent）；
      // 仍无 intent 时用用户原话兜底。
      if (!answer.intent) answer.intent = opts.userMessage;
    }

    // 循环检测：按 task 分别做环检（dependsOn 仅限同 task）；清依赖时重编全局唯一 step id
    if (answer && flattenSteps(answer).length > 0) {
      const resolved = resolveCircularDependenciesInTasks(answer.tasks);
      if (resolved.hadCycle) {
        console.error(`[task_decompose] 检测到循环依赖，已按 task 清除依赖并重编全局唯一 step id`);
        writeEventLog({
          category: "stage_error",
          message: "task_decompose 检测到循环依赖",
          details: {
            sessionId: opts.sessionId,
            cycledTaskIds: resolved.cycledTaskIds,
            stepIds: flattenSteps({ tasks: resolved.tasks }).map((s) => s.id),
            dependencies: flattenSteps(answer).map((s) => ({ id: s.id, dependsOn: s.dependsOn })),
          },
        });
        answer.tasks = resolved.tasks;
      }

      // 检测重复描述模式（逐任务去重）
      answer.tasks = answer.tasks.map((task) => {
        const descriptions = task.steps.map(s => s.description.toLowerCase().trim());
        const descriptionCounts = new Map<string, number>();
        for (const desc of descriptions) {
          descriptionCounts.set(desc, (descriptionCounts.get(desc) || 0) + 1);
        }

        const maxRepeats = Math.max(0, ...Array.from(descriptionCounts.values()));
        if (maxRepeats > 3) {
          console.warn(`[task_decompose] 检测到重复步骤模式，最大重复次数: ${maxRepeats}`);
          // 去重：只保留第一次出现的步骤
          const seenDescriptions = new Set<string>();
          return {
            ...task,
            steps: task.steps.filter((step) => {
              const desc = step.description.toLowerCase().trim();
              if (seenDescriptions.has(desc)) {
                return false;
              }
              seenDescriptions.add(desc);
              return true;
            }),
          };
        }
        return task;
      });
    }

    if (!answer) {
      tracer.endSpan(planSpanId, "error", { reason: "Parse failure" });
      writeEventLog({
        category: "stage_error",
        message: "task_decompose 解析失败：模型未返回可解析 JSON，已使用本地结构化兜底",
        details: {
          sessionId: opts.sessionId,
          planTextChars: planText.length,
          // 只记前缀便于排查，不把全文当最终回复下发
          planTextPreview: planText.trim().slice(0, 240),
        },
      });
      // Fallback：intent 用用户原话；模型纯文本（planText）收成单一 task，不丢弃。
      const rawDecompose = buildFallbackRawDecompose(opts.userMessage, planText);
      const agentPlan = generatePlan(opts.userMessage, "");
      // 有模型纯文本时，用其作为可展示/可跟进的单一 step，覆盖本地 generic plan
      if (rawDecompose.tasks[0]?.steps?.length) {
        agentPlan.steps = rawDecompose.tasks.flatMap((t) =>
          t.steps.map((s) => ({
            id: s.id,
            description: s.description,
            status: "pending" as const,
            dependsOn: s.dependsOn,
            retryCount: 0,
            maxRetries: 3,
          })),
        );
        agentPlan.goal = rawDecompose.intent || opts.userMessage;
      }
      reasoningTrace.plan = agentPlan;
      memory.setActivePlan({
        id: `plan_${Date.now().toString(36)}`,
        goal: agentPlan.goal,
        steps: agentPlan.steps.map((s) => ({
          id: s.id, description: s.description,
          status: "pending" as const, result: "",
        })),
        currentStep: 0,
        progress: "Starting execution (fallback plan)",
      });
      return {
        task: null,
        decomposeTokens: 0,
        fallback: true,
        rawDecompose,
      };
    }

    tracer.endSpan(planSpanId, "ok");
    
    const task = buildTurnInformationTask();

    // 构建原始任务分解结果
    const rawDecompose = {
      intent: answer.intent,
      userConstraints: answer.userConstraints,
      tasks: answer.tasks.map((t) => ({
        id: t.id,
        description: t.description,
        userConstraints: t.userConstraints,
        relevantHistory: t.relevantHistory,
        progressStatus: t.progressStatus,
        steps: t.steps.map((s) => ({
          id: s.id,
          description: s.description,
          dependsOn: s.dependsOn,
          verificationCriteria: s.verificationCriteria,
          rollbackStrategy: s.rollbackStrategy,
          estimatedComplexity: s.estimatedComplexity,
          relevantHistory: s.relevantHistory,
        })),
      })),
    };

    // Build the agent plan from decomposition
    const agentPlan: AgentPlan = {
      goal: answer.intent || opts.userMessage,
      steps: flattenSteps(answer).map((s) => ({
        id: s.id,
        description: s.description,
        status: "pending" as const,
        dependsOn: s.dependsOn,
        retryCount: 0,
        maxRetries: 3,
      })),
      createdAt: Date.now(),
      currentStep: 0,
    };

    reasoningTrace.plan = agentPlan;
    logReasoningStep(reasoningTrace, {
      type: "thought",
      content: `Plan generated: ${agentPlan.goal}`,
      timestamp: Date.now(),
    });

    // Update memory with the active plan
    memory.setActivePlan({
      id: `plan_${Date.now().toString(36)}`,
      goal: agentPlan.goal,
      steps: agentPlan.steps.map((s) => ({
        id: s.id,
        description: s.description,
        status: "pending" as const,
        result: "",
      })),
      currentStep: 0,
      progress: "Starting execution",
    });

    // Push the decomposition result into messages if provided
    if (messages) {
      const taskBlocks = answer.tasks.map((task, taskIndex) => {
        const heading = `Task ${taskIndex + 1} (${task.id}): ${task.description || "(no description)"}`;
        const taskContext = [
          task.userConstraints.length > 0 ? `  Constraints: ${task.userConstraints.join("; ")}` : "",
          task.relevantHistory ? `  Relevant history: ${task.relevantHistory}` : "",
          `  Progress: ${task.progressStatus}`,
        ].filter(Boolean).join("\n");
        const stepLines = task.steps
          .map((s, i) => `  ${i + 1}. [${s.id}] ${s.description}`)
          .join("\n");
        return [heading, taskContext, stepLines].filter(Boolean).join("\n");
      }).join("\n\n");
      const decomposeBlock = [
        "## Task decomposition",
        `Intent: ${answer.intent}`,
        answer.userConstraints.length > 0 ? `\nConstraints:\n${answer.userConstraints.map((c) => `- ${c}`).join("\n")}` : "",
        taskBlocks ? `\nTasks:\n${taskBlocks}` : "",
      ].filter(Boolean).join("\n");
      messages.push({ role: "system", content: decomposeBlock });
      decomposeTokens = Math.ceil(decomposeBlock.length / 4);
    }

    return { task, decomposeTokens, rawDecompose, fallback: false };
  } catch (e) {
    if (opts.signal?.aborted) {
      tracer.endSpan(planSpanId, "error", { reason: "aborted" });
      return {
        task: null,
        decomposeTokens: 0,
        fallback: true,
        rawDecompose: buildFallbackRawDecompose(opts.userMessage),
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    tracer.endSpan(planSpanId, "error", { reason: msg });
    writeEventLog({
      category: "stage_error",
      message: `runTaskDecompose failed: ${msg}`,
      details: {
        sessionId: opts.sessionId,
        error: msg,
        stack: e instanceof Error ? e.stack : undefined,
      },
    });
    
    // Fallback plan on error
    const agentPlan = generatePlan(opts.userMessage, "");
    reasoningTrace.plan = agentPlan;
    memory.setActivePlan({
      id: `plan_${Date.now().toString(36)}`,
      goal: agentPlan.goal,
      steps: agentPlan.steps.map((s) => ({
        id: s.id, description: s.description,
        status: "pending" as const, result: "",
      })),
      currentStep: 0,
      progress: "Starting execution (error fallback)",
    });
    return {
      task: null,
      decomposeTokens: 0,
      fallback: true,
      rawDecompose: buildFallbackRawDecompose(opts.userMessage),
    };
  }
}

// ── Stage Handler ──────────────────────────────────────────────────

/**
 * task_decompose: analyze the user's request and break it down into structured
 * steps with information needs. The decomposition guides the subsequent ReAct
 * loop exploration phase.
 *
 * 方案A：handler 只做分解并把完整执行上下文写入 rawDecompose / TaskItem.context；
 * 用户消息与上下文注入由 injectHistoryAndUserMessage 负责（history_compact 已短路）。
 */
export const taskDecomposeHandler: StageHandler = {
  async run(ctx) {
    const { opts, tracer, memory, reasoningTrace, node } = ctx;
    emitStage(opts.onEvent, "start", node);
    // 使用分阶段模型配置（如果启用）
    const model = resolveStageModel(opts.workflow, opts.mode, node, "decomposer");
    
    // 初始化任务分解计数器（用于控制历史召回工具提供次数）
    if (ctx.state.decomposeCount === undefined) {
      ctx.state.decomposeCount = 0;
    }
    
    const result = await runTaskDecompose(
      opts, model, tracer, memory, reasoningTrace, ctx.budgets, node.prompt, ctx.messages,
    );
    
    // 递增任务分解计数器
    ctx.state.decomposeCount++;
    
    ctx.state.turnInformationTask = result.task;
    ctx.state.decomposeTokens = result.decomposeTokens;
    ctx.state.rawDecompose = result.rawDecompose;
    if (result.rawDecompose) {
      opts.onEvent?.({
        type: "task_decomposition",
        intent: result.rawDecompose.intent,
        userConstraints: result.rawDecompose.userConstraints ?? [],
        tasks: result.rawDecompose.tasks.map((task) => ({
          id: task.id,
          description: task.description,
          userConstraints: task.userConstraints ?? [],
          relevantHistory: task.relevantHistory ?? "",
          progressStatus: task.progressStatus ?? "pending",
          steps: task.steps.map((step) => ({
            id: step.id,
            description: step.description,
            dependsOn: step.dependsOn,
            relevantHistory: step.relevantHistory ?? "",
          })),
        })),
        fallback: result.fallback === true,
      });
      // 任务分解结果已由 LLM 响应日志中的 [ASSISTANT] 记录；这里只保留状态消息，
      // 避免再将同一份结构化结果写入 DEBUG 日志。
      writeEventLog({
        category: "task_decompose",
        message: result.fallback ? "Task decomposition fallback generated" : "Task decomposition completed",
      });
    }
    if (opts.sessionId && result.rawDecompose) {
      const persisted: PersistedDecompose = {
        intent: result.rawDecompose.intent,
        userConstraints: result.rawDecompose.userConstraints ?? [],
        tasks: result.rawDecompose.tasks.map((task) => ({
          id: task.id,
          description: task.description,
          userConstraints: task.userConstraints ?? [],
          relevantHistory: task.relevantHistory ?? "",
          progressStatus: task.progressStatus ?? "pending",
          steps: task.steps.map((step) => ({
            id: step.id,
            description: step.description,
            dependsOn: step.dependsOn,
            verificationCriteria: step.verificationCriteria,
            rollbackStrategy: step.rollbackStrategy,
            estimatedComplexity: step.estimatedComplexity,
            relevantHistory: step.relevantHistory,
          })),
        })),
      };
      try {
        const record = await persistDecomposeRound(
          opts.workspaceRoot,
          opts.sessionId,
          opts.userMessage,
          persisted,
          collectToolCallsFromTurns(opts.history),
          (opts.attachments ?? []).map((attachment) => attachment.url),
        );
        if (record) ctx.state.roundIndex = record.index;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeEventLog({
          category: "other",
          message: "任务分解轮次写入失败 (best-effort, 已忽略)",
          details: { sessionId: opts.sessionId, error: message },
        });
      }
    }
    // Keep the legacy step-reflection path synchronized with the decomposition.
    ctx.state.currentPlan = reasoningTrace.plan;
    emitStage(opts.onEvent, "done", node);
  },
};
