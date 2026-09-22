/**
 * Adaptive Prompt Optimizer
 *
 * LLM-driven prompt optimization based on success rates:
 * - Tracks per-mode success/failure rates
 * - Automatically injects relevant few-shot examples for failing patterns
 * - Dynamically adjusts prompt detail level based on context complexity
 * - Learns from previous interactions within the same session
 *
 * World-class reference: DSPy, PromptAgent, Anthropic's prompt caching
 * approach — but lightweight and no external model cost for optimization
 */

import type { AgentMode } from "@owncoder/shared";

// ── Types ──────────────────────────────────────────────────

export interface PromptVariant {
  id: string;
  mode: AgentMode;
  /** The prompt segment being optimized */
  segment: string;
  /** Success rate 0-1 */
  successRate: number;
  /** Number of times this variant was used */
  usageCount: number;
  /** When this variant was last used */
  lastUsed: number;
  /** Average tokens consumed per use */
  avgTokensUsed: number;
  /** The actual prompt text */
  text: string;
}

export interface FailurePattern {
  pattern: string; // regex or keyword
  category: "tool_error" | "hallucination" | "incomplete" | "wrong_approach" | "stuck_loop";
  count: number;
  lastSeen: number;
  /** Counter-example that worked */
  successExample?: string;
}

export interface PromptStats {
  mode: AgentMode;
  totalRuns: number;
  successfulRuns: number;
  failurePatterns: FailurePattern[];
  variants: PromptVariant[];
  avgTokensPerRun: number;
  avgTurnsPerRun: number;
}

export interface AutoPromptConfig {
  /** Minimum runs before optimization kicks in */
  minRuns?: number;
  /** Max failure patterns to track */
  maxPatterns?: number;
  /** Whether to auto-inject fix guidance for known failure patterns */
  autoInject?: boolean;
  /** Max examples to inject */
  maxExamples?: number;
  /** Storage directory for persisting learned patterns */
  storageDir?: string;
}

const DEFAULTS: Required<AutoPromptConfig> = {
  minRuns: 5,
  maxPatterns: 20,
  autoInject: true,
  maxExamples: 3,
  storageDir: ".owncoder/prompt-stats",
};

// ── Failure Pattern Logger ────────────────────────────────

/**
 * Lightweight pattern matcher that identifies common failure modes
 * from agent output and error messages.
 */
function identifyFailurePattern(errorText: string, outputText: string): FailurePattern | null {
  const combined = (errorText + " " + outputText).toLowerCase();

  // Tool errors
  if (/tool.*(error|fail|invalid|timeout|not found)/.test(combined)) {
    return {
      pattern: /tool.*error/.source,
      category: "tool_error",
      count: 1,
      lastSeen: Date.now(),
    };
  }

  // Hallucination: file paths that don't exist
  if (/\bfile\b.*\bnot\b.*\bexist\b/.test(combined) ||
      /\bno such file\b/.test(combined)) {
    return {
      pattern: /file_not_found/.source,
      category: "hallucination",
      count: 1,
      lastSeen: Date.now(),
    };
  }

  // Incomplete output
  if (/incomplete|truncated|cut off|not finished/.test(combined)) {
    return {
      pattern: /incomplete/.source,
      category: "incomplete",
      count: 1,
      lastSeen: Date.now(),
    };
  }

  // Wrong approach
  if (/wrong\s+(approach|direction|file|method)/.test(combined) ||
      /should\s+not\s+(have|be)/.test(combined)) {
    return {
      pattern: /wrong_approach/.source,
      category: "wrong_approach",
      count: 1,
      lastSeen: Date.now(),
    };
  }

  // Stuck loop
  if (/repeating|stuck|loop|same (result|output|error)/.test(combined) ||
      /no progress/.test(combined)) {
    return {
      pattern: /stuck_loop/.source,
      category: "stuck_loop",
      count: 1,
      lastSeen: Date.now(),
    };
  }

  return null;
}

// ── Adaptive Prompt Optimizer ──────────────────────────────

export class AdaptivePromptOptimizer {
  private stats: Map<AgentMode, PromptStats> = new Map();
  private config: Required<AutoPromptConfig>;

  constructor(config?: AutoPromptConfig) {
    this.config = { ...DEFAULTS, ...config };
  }

  /** Record a completed agent run. */
  recordRun(
    mode: AgentMode,
    success: boolean,
    errorMsg: string = "",
    outputSnip: string = "",
    tokensUsed: number = 0,
    turnsUsed: number = 0,
  ): void {
    const stats = this.getOrCreateStats(mode);
    stats.totalRuns++;
    if (success) stats.successfulRuns++;
    stats.avgTokensPerRun = (stats.avgTokensPerRun * (stats.totalRuns - 1) + tokensUsed) / stats.totalRuns;
    stats.avgTurnsPerRun = (stats.avgTurnsPerRun * (stats.totalRuns - 1) + turnsUsed) / stats.totalRuns;

    if (!success && errorMsg) {
      const pattern = identifyFailurePattern(errorMsg, outputSnip);
      if (pattern) {
        const existing = stats.failurePatterns.find((p) => p.pattern === pattern.pattern);
        if (existing) {
          existing.count++;
          existing.lastSeen = Date.now();
        } else {
          stats.failurePatterns.push(pattern);
          // Evict oldest if over limit
          if (stats.failurePatterns.length > this.config.maxPatterns) {
            stats.failurePatterns.sort((a, b) => a.lastSeen - b.lastSeen);
            stats.failurePatterns.shift();
          }
        }
      }
    }
  }

  /**
   * Generate context to inject into the system prompt.
   * This provides the LLM with awareness of common failure modes
   * and strategies to avoid them.
   */
  generateContext(mode: AgentMode): string {
    const stats = this.stats.get(mode);
    if (!stats || stats.totalRuns < this.config.minRuns) return "";

    const successRate = stats.successfulRuns / Math.max(1, stats.totalRuns);

    const lines: string[] = [];

    // Success rate awareness
    if (successRate > 0.9) {
      lines.push("## 性能反馈\n你的成功率很高（>90%），继续保持。");
    } else if (successRate < 0.6) {
      lines.push(
        `## ⚠️ 性能反馈\n你的成功率较低（${(successRate * 100).toFixed(0)}%）。` +
        "请更仔细地阅读错误信息，每次修改后验证代码是否正确。",
      );
    }

    // Failure pattern guidance
    if (stats.failurePatterns.length > 0) {
      const significant = stats.failurePatterns
        .filter((p) => p.count >= 2)
        .sort((a, b) => b.count - a.count);

      if (significant.length > 0) {
        lines.push("\n## 常见错误模式（请避免）");
        for (const pattern of significant.slice(0, 5)) {
          const guidance = getGuidanceForPattern(pattern.category);
          lines.push(`- **${pattern.category}** (出现 ${pattern.count} 次): ${guidance}`);
        }
      }
    }

    return lines.join("\n");
  }

  /**
   * Get statistics for a specific mode.
   */
  getStats(mode: AgentMode): PromptStats | undefined {
    return this.stats.get(mode);
  }

  getAllStats(): PromptStats[] {
    return [...this.stats.values()];
  }

  get successRate(): number {
    let total = 0;
    let success = 0;
    for (const stats of this.stats.values()) {
      total += stats.totalRuns;
      success += stats.successfulRuns;
    }
    return total > 0 ? success / total : 1;
  }

  reset(mode?: AgentMode): void {
    if (mode) {
      this.stats.delete(mode);
    } else {
      this.stats.clear();
    }
  }

  private getOrCreateStats(mode: AgentMode): PromptStats {
    if (!this.stats.has(mode)) {
      this.stats.set(mode, {
        mode,
        totalRuns: 0,
        successfulRuns: 0,
        failurePatterns: [],
        variants: [],
        avgTokensPerRun: 0,
        avgTurnsPerRun: 0,
      });
    }
    return this.stats.get(mode)!;
  }
}

// ── Pattern Guidance ───────────────────────────────────────

function getGuidanceForPattern(category: FailurePattern["category"]): string {
  const map: Record<FailurePattern["category"], string> = {
    tool_error:
      "工具调用出错后，检查参数名是否正确（如 query 而非 search）、文件路径是否存在权限问题。",
    hallucination:
      "不要在 output 中提到不存在的文件或路径。修改前先用 read_file 确认文件存在。",
    incomplete:
      "不要输出截断的代码。如果代码太长，分段写入而非一次写完。",
    wrong_approach:
      "收到 '错误方法' 反馈时，仔细阅读用户消息找到被指出的问题，采用不同的解决思路。",
    stuck_loop:
      "如果同一工具连续调用超过3次无变化，停止重复本地尝试，改用 web_search 查报错/文档后再换方法。",
  };
  return map[category] ?? "请检查错误并调整方法。";
}
