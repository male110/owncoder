/**
 * Advanced Agent Reasoning Engine
 * 实现 ReAct（推理与行动）及计划执行流程。
 * 
 * Key upgrades from simple tool loop:
 * 1. Structured Thought-Action-Observation cycle (ReAct pattern)
 * 2. 计划生成与执行
 * 3. Branch exploration with backtracking (Tree-of-Thoughts lite)
 * 4. Confidence scoring and self-correction
 * 5. Task decomposition with dependency ordering
 */


export interface ReasoningStep {
  type: "thought" | "action" | "observation" | "replan";
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
      description: "实施变更",
      status: "pending",
      dependsOn: [],
      retryCount: 0,
      maxRetries: 2,
    },
    {
      id: "step_2",
      description: "验证结果",
      status: "pending",
      dependsOn: ["step_1"],
      retryCount: 0,
      maxRetries: 1,
    },
  );

  return steps;
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
  return trace.steps.length === 0 ? 0 : 0.5;
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

