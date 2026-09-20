/**
 * Advanced Agent Reasoning Engine
 * Implements ReAct (Reasoning + Acting) with Plan-Execute-Reflect closed loop.
 * 
 * Key upgrades from simple tool loop:
 * 1. Structured Thought-Action-Observation cycle (ReAct pattern)
 * 2. Plan generation → Execution → Self-reflection → Replan cycle
 * 3. Branch exploration with backtracking (Tree-of-Thoughts lite)
 * 4. Confidence scoring and self-correction
 * 5. Task decomposition with dependency ordering
 */

import { jsonrepair } from "jsonrepair";

export interface ReasoningStep {
  type: "thought" | "action" | "observation" | "reflection" | "replan";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface AgentPlan {
  goal: string;
  steps: PlanStep[];
  createdAt: number;
  currentStep: number;
}

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  dependsOn: string[];
  toolCalls?: ToolCallPlan[];
  verification?: string;
  result?: string;
  retryCount: number;
  maxRetries: number;
}

interface ToolCallPlan {
  toolName: string;
  args: Record<string, unknown>;
  expectedOutcome: string;
}

export interface ReflectionResult {
  stepCompleted: boolean;
  qualityScore: number; // 0-1
  issues: string[];
  suggestions: string[];
  needsReplan: boolean;
}

export interface ReasoningTrace {
  steps: ReasoningStep[];
  plan: AgentPlan | null;
  confidence: number; // overall 0-1
  tokensUsed: number;
  toolCallsMade: number;
  correctionsMade: number;
}

/**
 * Generate a structured plan from a user request.
 *
 * NOTE: This is a heuristic FALLBACK. The primary planning path is LLM-driven
 * via `runTaskDecompose()` in loop.ts, which uses the model to produce
 * context-aware decomposition. This function exists to provide a rough plan
 * structure when the LLM-based decomposition fails or during fast-mode drafts.
 */
export function generatePlan(userRequest: string, context: string): AgentPlan {
  const goal = extractGoal(userRequest);
  const steps = heuristicDecompose(userRequest, context);
  return {
    goal,
    steps,
    createdAt: Date.now(),
    currentStep: 0,
  };
}

function extractGoal(userRequest: string): string {
  // Extract the core goal from the user request
  const cleaned = userRequest.trim();
  const firstLine = cleaned.split("\n")[0] ?? cleaned;
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
}

function heuristicDecompose(request: string, _context: string): PlanStep[] {
  const steps: PlanStep[] = [];
  const lower = request.toLowerCase();

  // Heuristic task decomposition based on common patterns
  // In production, this would be LLM-driven
  const taskPatterns: Array<{
    pattern: RegExp;
    steps: Array<{ description: string; deps: number[] }>;
  }> = [
    {
      pattern: /fix|debug|repair|解决|修复/,
      steps: [
        { description: "定位问题根源 — 阅读相关代码和日志", deps: [] },
        { description: "分析根因并提出修复方案", deps: [0] },
        { description: "实施修复", deps: [1] },
        { description: "验证修复 — 检查类型、运行测试", deps: [2] },
      ],
    },
    {
      pattern: /add|implement|create|添加|实现|创建/,
      steps: [
        { description: "理解现有代码结构和约定", deps: [] },
        { description: "设计实现方案", deps: [0] },
        { description: "实现核心逻辑", deps: [1] },
        { description: "集成和连线", deps: [2] },
        { description: "验证和测试", deps: [3] },
      ],
    },
    {
      pattern: /refactor|重构/,
      steps: [
        { description: "分析现有代码结构和依赖关系", deps: [] },
        { description: "设计重构方案", deps: [0] },
        { description: "逐步重构（保留行为不变）", deps: [1] },
        { description: "验证重构后功能一致", deps: [2] },
      ],
    },
    {
      pattern: /optimize|优化|performance|性能/,
      steps: [
        { description: "识别性能瓶颈（profile/分析）", deps: [] },
        { description: "提出优化策略", deps: [0] },
        { description: "实施优化", deps: [1] },
        { description: "基准测试验证效果", deps: [2] },
      ],
    },
  ];

  for (const tp of taskPatterns) {
    if (tp.pattern.test(lower)) {
      for (let i = 0; i < tp.steps.length; i++) {
        const s = tp.steps[i]!;
        steps.push({
          id: `step_${i + 1}`,
          description: s.description,
          status: "pending",
          dependsOn: s.deps.map((d) => `step_${d + 1}`),
          retryCount: 0,
          maxRetries: 2,
        });
      }
      return steps;
    }
  }

  // Generic fallback
  steps.push(
    {
      id: "step_1",
      description: "理解需求并分析上下文",
      status: "pending",
      dependsOn: [],
      retryCount: 0,
      maxRetries: 1,
    },
    {
      id: "step_2",
      description: "实施变更",
      status: "pending",
      dependsOn: ["step_1"],
      retryCount: 0,
      maxRetries: 2,
    },
    {
      id: "step_3",
      description: "验证结果",
      status: "pending",
      dependsOn: ["step_2"],
      retryCount: 0,
      maxRetries: 1,
    },
  );

  return steps;
}

/**
 * LLM-driven self-reflection on step execution outcomes.
 * Uses the model to critically analyze step results, going beyond
 * regex-based sentiment matching to understand semantic correctness.
 *
 * This is the primary reflection path. Falls back to regex-based
 * reflectOnStep when no LLM caller is available.
 */
export async function reflectOnStepWithLLM(
  step: PlanStep,
  toolOutputs: string[],
  assistantText: string,
  callLLM: (prompt: string) => Promise<string>,
): Promise<ReflectionResult> {
  const toolSummary = toolOutputs.length > 0
    ? toolOutputs.map((o) => o.slice(0, 500)).join("\n").slice(0, 2000)
    : "(no tool output)";

  const reflectionPrompt = [
    "You are a strict code-review judge. Decide whether the step below was actually completed,",
    "based ONLY on the evidence in the tool outputs and response — not on claimed success.",
    "",
    "Judge by:",
    "1. Did the described work actually happen (files edited, commands run)?",
    "2. Do any errors, failures, or unresolved issues remain in the evidence?",
    "3. Does the outcome satisfy the step's goal?",
    "",
    "Hard rules:",
    "- Compilation errors, test failures, or tool errors in the evidence → stepCompleted=false.",
    "- Claims of success without supporting tool evidence → lower qualityScore, note it in issues.",
    "- qualityScore reflects verified correctness, not confidence or effort.",
    "- Set needsReplan=true only when the current approach itself is wrong, not for small fixable slips.",
    "",
    "Step description:",
    step.description,
    "",
    "Tool outputs (truncated):",
    toolSummary,
    "",
    "Assistant response:",
    assistantText.slice(0, 3000),
    "",
    "Respond with EXACTLY this JSON format (no other text):",
    '{',
    '  "stepCompleted": true/false,',
    '  "qualityScore": 0.0-1.0,',
    '  "issues": ["issue1", "issue2"],',
    '  "suggestions": ["suggestion1", "suggestion2"],',
    '  "needsReplan": true/false',
    '}',
  ].join("\n");

  try {
    const responseText = await callLLM(reflectionPrompt);
    const parsed = parseReflectionResponse(responseText);
    if (parsed) {
      return parsed;
    }
  } catch {
    // LLM reflection failed — fall through to regex-based fallback
  }

  // Fallback to regex-based reflection
  return reflectOnStep(step, toolOutputs, assistantText);
}

function parseReflectionResponse(text: string): ReflectionResult | null {
  // Try to extract JSON from the response (model may wrap in markdown)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const obj = JSON.parse(jsonrepair(jsonMatch[0]!));
    const stepCompleted = Boolean(obj.stepCompleted);
    const qualityScore = typeof obj.qualityScore === "number"
      ? Math.max(0, Math.min(1, obj.qualityScore))
      : (stepCompleted ? 0.7 : 0.3);
    const issues = Array.isArray(obj.issues)
      ? obj.issues.filter((i: unknown) => typeof i === "string")
      : [];
    const suggestions = Array.isArray(obj.suggestions)
      ? obj.suggestions.filter((s: unknown) => typeof s === "string")
      : [];
    const needsReplan = Boolean(obj.needsReplan);

    return { stepCompleted, qualityScore, issues, suggestions, needsReplan };
  } catch {
    return null;
  }
}

/**
 * Regex-based reflection (fallback).
 * Uses sentiment-aware scoring: strips code blocks, checks negations,
 * and balances positive vs negative signals for fewer false positives.
 *
 * This is kept as a fallback for when LLM reflection is unavailable
 * or fails. Prefer reflectOnStepWithLLM for production use.
 */
function reflectOnStep(
  step: PlanStep,
  toolOutputs: string[],
  assistantText: string,
): ReflectionResult {
  // Strip code fences and inline code from tool outputs — error keywords
  // inside displayed code snippets are diagnostic, not failures.
  const stripCode = (s: string) =>
    s.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]+`/g, " ");

  const toolCleaned = toolOutputs.map(stripCode).join("\n").toLowerCase();
  const textCleaned = assistantText.toLowerCase();
  const combined = toolCleaned + "\n" + textCleaned;
  const issues: string[] = [];
  const suggestions: string[] = [];

  // ── Positive signals ────────────────────────────────────────
  const positivePatterns: Array<{ pattern: RegExp; weight: number }> = [
    { pattern: /\b(no\s+)?error\s*[−-]\s*free\b/i, weight: 2 },     // "error-free"
    { pattern: /\bno errors?\b/i, weight: 2 },                       // "no errors"
    { pattern: /\bwithout (any )?errors?\b/i, weight: 2 },           // "without errors"
    { pattern: /\bnot failing\b/i, weight: 1.5 },
    { pattern: /\b(all|everything)\s+(?:passed|succeeded|works?)\b/i, weight: 2 },
    { pattern: /\b(successfully|success)\b/i, weight: 1.5 },
    { pattern: /\b(completed|done|finished)\b/i, weight: 1 },
    { pattern: /✅|\bpassed\b|\bverified\b|\bcorrect\b/i, weight: 1 },
    { pattern: /\b(looks good|working (now|correctly|as expected))\b/i, weight: 1.5 },
  ];

  // ── Negative signals (context-aware) ────────────────────────
  const errorPatterns: Array<{ pattern: RegExp; issue: string; weight: number }> = [
    { pattern: /\berror[: ]/i, issue: "检测到错误输出", weight: 2 },
    { pattern: /\b(?:compile|compilation)\s+(?:error|failed)\b/i, issue: "编译错误", weight: 3 },
    { pattern: /\bfailed\b(?!.*\bno\b)/i, issue: "执行失败", weight: 2 },
    { pattern: /\bfailure\b/i, issue: "执行失败", weight: 2 },
    { pattern: /\b(not found|doesn'?t exist|no such file)\b/i, issue: "目标资源未找到", weight: 2 },
    { pattern: /\bpermission denied\b/i, issue: "权限不足", weight: 2 },
    { pattern: /\btime[ -]?out\b/i, issue: "操作超时", weight: 1 },
    { pattern: /\bundefined\b(?!\s+is)/i, issue: "可能产生未定义值", weight: 1 },
    { pattern: /\bnull pointer\b/i, issue: "空指针", weight: 2 },
    { pattern: /\bcannot\b(?!\s*(?:be|find|see|help|assist))/i, issue: "操作无法完成", weight: 1 },
    { pattern: /\bunable to\b/i, issue: "操作无法完成", weight: 1 },
    { pattern: /\bstack trace\b/i, issue: "异常堆栈", weight: 2 },
    { pattern: /\bpanic\b/i, issue: "程序panic", weight: 3 },
    { pattern: /\bexited with (non-zero|code [1-9])\b/i, issue: "非零退出码", weight: 2 },
  ];

  // ── Score computation ────────────────────────────────────────
  let netScore = 0; // positive - negative

  // Count positive matches
  for (const pp of positivePatterns) {
    const matches = (textCleaned.match(new RegExp(pp.pattern.source, "gi")) || []).length;
    netScore += matches * pp.weight;
  }

  // Count negative matches
  for (const ep of errorPatterns) {
    if (ep.pattern.test(combined)) {
      issues.push(ep.issue);
      netScore -= ep.weight;
    }
  }

  // ── Quality heuristics ───────────────────────────────────────
  let qualityScore = 1.0;
  // Net sentiment: each -1 weight ≈ -0.1 quality
  if (netScore < 0) qualityScore += netScore * 0.1;
  // Negative issues above 3 are almost certainly a real problem
  if (issues.length >= 3) qualityScore -= 0.3;
  // No tool output and no text → silence
  if (!assistantText.trim()) qualityScore -= 0.3;
  // No tool output at all
  if (toolOutputs.length === 0) qualityScore -= 0.1;
  // But strong positive net score can override
  if (netScore >= 4) qualityScore = Math.max(qualityScore, 0.85);
  qualityScore = Math.max(0, Math.min(1, qualityScore));

  const stepCompleted = qualityScore >= 0.5 && issues.length <= 2;
  const needsReplan = qualityScore < 0.3 || issues.length >= 4;

  if (!stepCompleted && step.retryCount < step.maxRetries) {
    suggestions.push(
      `建议重试步骤 "${step.description}"，尝试不同的方法`,
    );
  }

  if (needsReplan) {
    suggestions.push("当前方案可能不合适，建议重新规划");
  }

  if (stepCompleted && issues.length > 0) {
    suggestions.push("步骤基本完成，但存在一些需要注意的问题");
  }

  return {
    stepCompleted,
    qualityScore,
    issues,
    suggestions,
    needsReplan,
  };
}

/**
 * Create a reasoning trace entry for observability.
 */
export function createReasoningTrace(): ReasoningTrace {
  return {
    steps: [],
    plan: null,
    confidence: 0,
    tokensUsed: 0,
    toolCallsMade: 0,
    correctionsMade: 0,
  };
}

/**
 * Log a reasoning step to the trace.
 */
export function logReasoningStep(
  trace: ReasoningTrace,
  step: ReasoningStep,
): void {
  trace.steps.push(step);
}

/**
 * Update the trace with execution statistics.
 */
export function updateTraceStats(
  trace: ReasoningTrace,
  tokens: number,
  toolCalls: number,
  corrections: number,
): void {
  trace.tokensUsed += tokens;
  trace.toolCallsMade += toolCalls;
  trace.correctionsMade += corrections;
  trace.confidence = calculateOverallConfidence(trace);
}

function calculateOverallConfidence(trace: ReasoningTrace): number {
  if (trace.steps.length === 0) return 0;
  const reflectionSteps = trace.steps.filter((s) => s.type === "reflection");
  if (reflectionSteps.length === 0) return 0.5;
  
  const avgQuality = reflectionSteps.reduce((sum, s) => {
    return sum + ((s.metadata?.qualityScore as number) ?? 0.5);
  }, 0) / reflectionSteps.length;
  
  return avgQuality;
}

/**
 * Format the reasoning trace for display in the UI.
 */
export function formatReasoningTrace(trace: ReasoningTrace): string {
  const lines: string[] = [];
  lines.push(`## Agent Reasoning Trace`);
  lines.push(`Confidence: ${(trace.confidence * 100).toFixed(0)}%`);
  lines.push(`Tool calls: ${trace.toolCallsMade} | Corrections: ${trace.correctionsMade} | Tokens: ~${trace.tokensUsed}`);
  lines.push("");

  if (trace.plan) {
    lines.push(`### Plan: ${trace.plan.goal}`);
    for (const step of trace.plan.steps) {
      const icon = {
        pending: "⬜",
        in_progress: "🔄",
        completed: "✅",
        failed: "❌",
        skipped: "⏭️",
      }[step.status];
      lines.push(`  ${icon} ${step.id}: ${step.description}`);
      if (step.status === "failed" && step.retryCount > 0) {
        lines.push(`     ↳ 已重试 ${step.retryCount} 次`);
      }
    }
    lines.push("");
  }

  lines.push("### Detailed Steps");
  for (const step of trace.steps) {
    const ts = new Date(step.timestamp).toISOString().slice(11, 19);
    lines.push(`[${ts}] ${step.type.toUpperCase()}: ${step.content.slice(0, 200)}`);
  }

  return lines.join("\n");
}

/**
 * Self-correction prompt template.
 * Injects the reflection result to guide the next iteration.
 */
export function buildCorrectionPrompt(
  reflection: ReflectionResult,
  previousOutput: string,
): string {
  const parts: string[] = [];
  
  parts.push("## Self-Correction Guidance");
  parts.push(`Quality Score: ${(reflection.qualityScore * 100).toFixed(0)}%`);
  
  if (reflection.issues.length > 0) {
    parts.push("\n### Issues Found:");
    for (const issue of reflection.issues) {
      parts.push(`- ${issue}`);
    }
  }
  
  if (reflection.suggestions.length > 0) {
    parts.push("\n### Suggestions:");
    for (const suggestion of reflection.suggestions) {
      parts.push(`- ${suggestion}`);
    }
  }

  if (reflection.needsReplan) {
    parts.push("\n### Replan Required");
    parts.push("The current approach is not working. Please reconsider the strategy and try a different approach.");
  }

  parts.push(`\nPrevious output:\n${previousOutput.slice(0, 2000)}`);
  
  return parts.join("\n");
}

/**
 * Select the next step to execute based on dependency resolution.
 */
export function selectNextStep(plan: AgentPlan): PlanStep | null {
  for (const step of plan.steps) {
    if (step.status !== "pending") continue;
    
    // Check if all dependencies are completed
    const depsReady = step.dependsOn.every((depId) => {
      const dep = plan.steps.find((s) => s.id === depId);
      return dep && (dep.status === "completed" || dep.status === "skipped");
    });
    
    if (depsReady) {
      return step;
    }
  }
  
  return null; // All done or blocked
}

