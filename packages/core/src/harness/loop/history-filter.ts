/**
 * Task-aware history filtering for ReAct loops.
 * 
 * Filters recent conversation history to retain only turns relevant to the current task,
 * reducing token usage in multi-iteration ReAct loops while preserving critical context.
 * 
 * Uses LLM-based precision filtering for semantic understanding of task relevance.
 */

import type { ChatTurn } from "./types.ts";
import type { MemoryManager } from "../memory.ts";
import type { AgentPlan } from "../agent-reasoning.ts";
import type { ModelRef } from "@owncoder/settings";
import { chatCompletion, writeEventLog } from "@owncoder/llm";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface HistoryFilterConfig {
  /** Enable filtering (default: true) */
  enabled: boolean;
  
  /** Minimum history size (in estimated chars) to trigger filtering */
  minHistoryChars: number;
  
  /** Model for LLM filtering stage */
  filterModel?: ModelRef;

  /** Temperature for filter LLM (0 for deterministic) */
  filterTemperature: number;
}

export interface FilterResult {
  /** Filtered turns */
  filtered: ChatTurn[];
  
  /** Original turn count */
  originalCount: number;
  
  /** Estimated chars saved */
  charsSaved: number;
  
  /** Time spent filtering (ms) */
  filteringTime: number;
  
  /** Which stages were applied */
  stagesApplied: "llm"[];
  
  /** Effective threshold used (may be reduced for complex tasks) */
  effectiveThreshold?: number;
  
  /** Whether threshold was adjusted for task complexity */
  thresholdAdjusted?: boolean;
}

export interface FilterContext {
  /** Current user task/request */
  currentTask: string;
  
  /** Active plan if available */
  activePlan: AgentPlan | null;
  
  /** Memory manager for context awareness */
  memory: MemoryManager;
}

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<HistoryFilterConfig> = {
  enabled: true,
  minHistoryChars: 3000, // ~750 tokens, ~3 conversation turns
  filterModel: { baseUrl: "https://api.anthropic.com/v1", providerId: "anthropic", model: "claude-3-5-sonnet-20241022" },
  filterTemperature: 0, // Deterministic filtering for consistency
};


// ────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────

/**
 * Filter conversation history to retain only task-relevant turns.
 * 
 * @param history Full conversation history
 * @param context Task and memory context
 * @param config Filtering configuration
 * @returns Filtered history and metadata
 */
export async function filterRecentHistory(
  history: readonly ChatTurn[],
  context: FilterContext,
  config: Partial<HistoryFilterConfig> = {},
  sessionId?: string,
): Promise<FilterResult> {
  const startTime = Date.now();
  
  // Merge configs, filtering out undefined values from user config
  const userConfig = Object.fromEntries(
    Object.entries(config).filter(([_, v]) => v !== undefined)
  );
  const cfg = { ...DEFAULT_CONFIG, ...userConfig } as Required<HistoryFilterConfig>;

  // Dynamic threshold based on task complexity
  // If task has >2 steps (complex task), use lower threshold for earlier filtering
  const activePlan = context.activePlan;
  const isComplexTask = activePlan && activePlan.steps && activePlan.steps.length > 2;
  const effectiveThreshold = isComplexTask 
    ? Math.floor(cfg.minHistoryChars * 0.5)  // 50% of threshold for complex tasks
    : cfg.minHistoryChars;

  // Skip if disabled or history too small
  const estimatedChars = estimateHistoryChars(history);
  if (!cfg.enabled || estimatedChars < effectiveThreshold) {
    return {
      filtered: [...history],
      originalCount: history.length,
      charsSaved: 0,
      filteringTime: 0,
      stagesApplied: [],
      effectiveThreshold,
      thresholdAdjusted: isComplexTask || undefined,
    };
  }

  const stagesApplied: "llm"[] = [];

  // LLM precision filtering
  let filterStatus: "success" | "llm_failed" | "llm_empty";
  let finalFiltered: ChatTurn[];

  try {
    const llmFiltered = await llmPrecisionFilter(
      [...history],
      context,
      cfg,
      sessionId,
    );
    finalFiltered = llmFiltered.turns;
    stagesApplied.push("llm");
    filterStatus = llmFiltered.status; // "success" or "llm_empty"
  } catch (error) {
    // LLM filtering failed, return original history
    filterStatus = "llm_failed";
    const errMsg = `[history-filter] LLM filtering failed, returning original history: ${(error as Error).message ?? error}`;
    console.warn(errMsg);
    writeEventLog({ category: "stage_error", message: errMsg, details: { error: String(error) } });
    finalFiltered = [...history];
  }

  const filteringTime = Date.now() - startTime;
  const charsSaved = estimatedChars - estimateHistoryChars(finalFiltered);

  const statusLabel = filterStatus === "success" ? "成功" :
    filterStatus === "llm_failed" ? "失败(LLM异常)" :
    filterStatus === "llm_empty" ? "失败(LLM返回空)" : filterStatus;
  const filterResultMsg = `filterRecentHistory 历史过滤压缩结果：状态=${statusLabel} 原始轮次=${history.length} 压缩后=${finalFiltered.length} 节省字符=${charsSaved} 耗时=${filteringTime}ms 输入字符=${estimatedChars}`;
  console.log(filterResultMsg);
  writeEventLog({
    category: "other",
    message: filterResultMsg,
    details: { status: filterStatus, originalCount: history.length, filteredCount: finalFiltered.length, charsSaved, filteringTime, inputChars: estimatedChars },
  });

  // Log threshold adjustment for complex tasks
  if (isComplexTask) {
    const thresholdMsg = `[history-filter] 复杂任务检测（${activePlan?.steps.length}步骤），阈值降低: ${cfg.minHistoryChars} → ${effectiveThreshold}`;
    console.log(thresholdMsg);
    writeEventLog({ category: "other", message: thresholdMsg });
  }

  return {
    filtered: finalFiltered,
    originalCount: history.length,
    charsSaved,
    filteringTime,
    stagesApplied,
    effectiveThreshold,
    thresholdAdjusted: isComplexTask || undefined,
  };
}


// ────────────────────────────────────────────────────────────
// LLM Precision Filtering
// ────────────────────────────────────────────────────────────

/**
 * Use LLM to extract relevant content from pre-filtered history.
 * 
 * The LLM analyzes each turn and extracts only the content directly relevant 
 * to completing the current task, achieving fine-grained content-level filtering.
 * 
 * @throws Error if LLM call fails or times out
 */
async function llmPrecisionFilter(
  preFiltered: readonly ChatTurn[],
  context: FilterContext,
  config: Required<HistoryFilterConfig>,
  sessionId?: string,
): Promise<{ turns: ChatTurn[]; status: "success" | "llm_empty" }> {
  const { currentTask, activePlan, memory } = context;

  // Validate that we have a model
  if (!config.filterModel) {
    throw new Error("filterModel is required for LLM precision filtering");
  }

  // Build indexed transcript for LLM with FULL content (not previews)
  // LLM needs full content to extract relevant portions
  // Reverse order: most recent turns first (user's latest input at the top)
  const indexedTurns = preFiltered.slice().reverse().map((turn, reversedIndex) => {
    const originalIndex = preFiltered.length - 1 - reversedIndex;
    const role = turn.role === "tool" && turn.toolName 
      ? `tool[${turn.toolName}]` 
      : turn.role;
    // Include full content, but mark very long turns
    const content = turn.content.length > 5000 
      ? `${turn.content.slice(0, 5000)}\n... [truncated, ${turn.content.length} chars total]`
      : turn.content;
    return `[${originalIndex}] ${role}:\n${content}`;
  }).join("\n\n");

  // Build context description
  const recentFiles = Array.from(memory.working.recentReads.keys()).slice(0, 5);
  const keySymbols = Array.from(memory.working.recentReads.values())
    .flatMap(f => f.keySymbols)
    .slice(0, 10);

  const contextDescription = [
    `Recent files: ${recentFiles.join(", ") || "none"}`,
    `Key symbols: ${keySymbols.join(", ") || "none"}`,
    activePlan ? `Active plan: ${activePlan.goal}` : "",
  ].filter(Boolean).join("\n");

  // Call LLM with extraction prompt — no output token limit, let model produce full extraction
  const response = await chatCompletion(
    config.filterModel,
    [
      {
        role: "system",
        content: FILTER_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildFilterPrompt(currentTask, contextDescription, indexedTurns, preFiltered.length),
      },
    ],
    {
      temperature: config.filterTemperature,
      // 不限制输出token数量，让模型按需生成完整的提取结果
      // 过滤是确定性的快速压缩步骤：关闭思考，避免推理消耗输出预算与时间
      thinking: { effort: "none" },
      taskId: sessionId,
      purpose: "history_filter",
    },
  );

  // Parse LLM response - ChatResponse.choices[0].message.content
  // New format: LLM returns a single plain text block (not JSON array)
  const extractedText = (response.choices?.[0]?.message?.content ?? "").trim();

  // Debug: 输出 LLM 原始返回
  console.log(`filterRecentHistory 历史过滤压缩结果（LLM原始返回）：\n${extractedText}`);

  // Handle fallback: if extraction returned nothing, use pre-filtered turns
  if (extractedText.length === 0) {
    const emptyMsg = "[history-filter] LLM extraction returned empty text, falling back to original history";
    console.warn(emptyMsg);
    writeEventLog({ category: "stage_error", message: emptyMsg });
    return {
      turns: [...preFiltered],
      status: "llm_empty",
    };
  }

  // Build a single merged turn from the extracted text.
  // The LLM merges all relevant content into one plain text block,
  // so we represent it as a single assistant turn.
  const mergedTurn: ChatTurn = {
    role: "assistant",
    content: extractedText,
  };

  return {
    turns: [mergedTurn],
    status: "success",
  };
}

// ────────────────────────────────────────────────────────────
// Filter Prompt (LLM Stage)
// ────────────────────────────────────────────────────────────

const FILTER_SYSTEM_PROMPT = `You are an information extractor. Your sole task: extract information useful for the current task from conversation history, output as plain text.

Your output should look like this (example):
──────────────────────────────────
Implemented JWT refresh mechanism in the project's src/auth/ module.

Modified files: AuthController.java, TokenService.java

Implementation: Store refresh tokens in Redis with 7-day expiration. Access token validity is 15 minutes.

Issue encountered: Redis connection pool exhausted under high concurrency, resolved by increasing maxTotal.

User requested token blacklist support using Redis SET to store revoked tokens.
──────────────────────────────────

Note the example above: no titles, numbering, or structural markers. Just continuous useful information paragraphs separated by blank lines.

Iron rules (violating any = failure):
1. Do NOT output any form of heading (#, ##, ###, **bold**, --- dividers)
2. Do NOT output structural markers like "Current Task", "Context", "Conversation History", "Summary"
3. Do NOT output index markers like [0], [1], [35] or "Turn 1:", "Segment 3:"
4. Do NOT output preamble like "Here is...", "The following...", "Based on..."
5. Do NOT echo any formatting or structure from the input
6. Do NOT output JSON, arrays, or list markers (-, *, 1.)
7. Output ONLY the raw useful information extracted from history

What to extract (only when relevant to the current task):
- File paths, function names, module references
- Error messages, stack traces
- Key architectural or implementation decisions
- User requirements, constraints, clarifications
- Important state: variable values, configuration, test results
- Business rules and workflows
- Code patterns or snippets

What to skip:
- The current task description itself (caller already knows it)
- Conversation metadata and context information
- Completed or irrelevant discussions
- General project setup information
- Duplicate content
- Verbose tool output (keep only key excerpts)

Extraction rules:
- Only part of a conversation is relevant → extract only the relevant part
- Entire segment is relevant → preserve completely
- Entire segment is irrelevant → skip
- Error messages and stack traces: preserve completely, do not truncate
- When uncertain → keep it (missing information is worse than extra information)

Output volume: extract 20-40% of the original conversation content. Concise but complete.`;

function buildFilterPrompt(
  currentTask: string,
  contextDescription: string,
  indexedTurns: string,
  turnCount: number,
): string {
  return `以下是需要你处理的信息。请阅读后提取有用内容，按上述规则输出。

--- 需求背景 ---
${currentTask}

--- 环境信息 ---
${contextDescription}

--- 对话记录（共 ${turnCount} 段，最新的在前） ---
${indexedTurns}

--- 请提取有用信息（纯文本，无标题，无结构标记） ---`;
}

// ────────────────────────────────────────────────────────────
// Helper Functions
// ────────────────────────────────────────────────────────────

/**
 * Estimate character count of history.
 * Adds 32 bytes overhead per turn for metadata.
 */
function estimateHistoryChars(history: readonly ChatTurn[]): number {
  return history.reduce((sum, turn) => {
    const contentLen = typeof turn.content === "string" ? turn.content.length : 0;
    return sum + contentLen + 32;
  }, 0);
}


