/**
 * Termination Metrics Collector
 * 
 * 收集和分析 React loop 终止指标，用于监控和优化
 */

export interface TerminationMetric {
  timestamp: number;
  sessionId?: string;
  terminationReason: string;
  isAborted: boolean;
  iterations: number;
  totalToolCalls: number;
  consecutiveSimilarOutputs: number;
  consecutiveTextOnlyTurns: number;
  metadata?: Record<string, unknown>;
}

export interface TerminationStats {
  // 终止原因分布
  reasonDistribution: Record<string, number>;
  reasonPercentage: Record<string, string>;
  
  // 迭代次数统计
  iterations: {
    total: number;
    p50: number;
    p95: number;
    p99: number;
    mean: number;
    max: number;
    min: number;
  };
  
  // 工具调用统计
  toolCalls: {
    total: number;
    p50: number;
    p95: number;
    mean: number;
    max: number;
  };
  
  // 输出相似度触发统计
  outputSimilarity: {
    triggeredCount: number;
    triggerRate: string;
    avgSimilarOutputs: number;
  };
  
  // 总体统计
  summary: {
    totalSessions: number;
    abortedCount: number;
    abortedRate: string;
    naturalCompletionCount: number;
    naturalCompletionRate: string;
  };
}

/**
 * Metrics collector class
 */
export class TerminationMetricsCollector {
  private metrics: TerminationMetric[] = [];
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * 记录一次终止事件（仅开发环境）
   */
  record(metric: TerminationMetric): void {
    // 仅在开发环境收集数据
    const isDev = process.env.NODE_ENV === "development" || process.env.OWNCODER_DEV === "true";
    if (!isDev) {
      return;
    }
    
    this.metrics.push(metric);
    
    // 限制内存占用
    if (this.metrics.length > this.maxSize) {
      this.metrics.shift();
    }
  }

  /**
   * 获取统计数据
   */
  getStats(): TerminationStats {
    if (this.metrics.length === 0) {
      return this.emptyStats();
    }

    // 终止原因分布
    const reasonCounts: Record<string, number> = {};
    for (const m of this.metrics) {
      const reason = this.categorizeReason(m.terminationReason);
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }

    const reasonPercentage: Record<string, string> = {};
    for (const [reason, count] of Object.entries(reasonCounts)) {
      reasonPercentage[reason] = `${((count / this.metrics.length) * 100).toFixed(1)}%`;
    }

    // 迭代次数统计
    const iterations = this.metrics.map(m => m.iterations).sort((a, b) => a - b);
    const iterationStats = {
      total: iterations.length,
      p50: this.percentile(iterations, 50),
      p95: this.percentile(iterations, 95),
      p99: this.percentile(iterations, 99),
      mean: this.mean(iterations),
      max: Math.max(...iterations),
      min: Math.min(...iterations),
    };

    // 工具调用统计
    const toolCalls = this.metrics.map(m => m.totalToolCalls).sort((a, b) => a - b);
    const toolCallStats = {
      total: toolCalls.length,
      p50: this.percentile(toolCalls, 50),
      p95: this.percentile(toolCalls, 95),
      mean: this.mean(toolCalls),
      max: Math.max(...toolCalls),
    };

    // 输出相似度触发统计
    const similarityTriggered = this.metrics.filter(m => 
      m.terminationReason.toLowerCase().includes("similar output")
    );
    const similarOutputs = this.metrics
      .filter(m => m.consecutiveSimilarOutputs > 0)
      .map(m => m.consecutiveSimilarOutputs);
    
    const outputSimilarityStats = {
      triggeredCount: similarityTriggered.length,
      triggerRate: `${((similarityTriggered.length / this.metrics.length) * 100).toFixed(1)}%`,
      avgSimilarOutputs: similarOutputs.length > 0 ? this.mean(similarOutputs) : 0,
    };

    // 总体统计
    const abortedCount = this.metrics.filter(m => m.isAborted).length;
    const naturalCompletion = this.metrics.filter(m => 
      m.terminationReason.toLowerCase().includes("natural completion") ||
      m.terminationReason.toLowerCase().includes("finish_reason=stop")
    );

    return {
      reasonDistribution: reasonCounts,
      reasonPercentage,
      iterations: iterationStats,
      toolCalls: toolCallStats,
      outputSimilarity: outputSimilarityStats,
      summary: {
        totalSessions: this.metrics.length,
        abortedCount,
        abortedRate: `${((abortedCount / this.metrics.length) * 100).toFixed(1)}%`,
        naturalCompletionCount: naturalCompletion.length,
        naturalCompletionRate: `${((naturalCompletion.length / this.metrics.length) * 100).toFixed(1)}%`,
      },
    };
  }

  /**
   * 获取最近 N 条记录
   */
  getRecent(count: number = 10): TerminationMetric[] {
    return this.metrics.slice(-count);
  }

  /**
   * 清空统计数据
   */
  clear(): void {
    this.metrics = [];
  }

  /**
   * 导出原始数据（用于外部分析）
   */
  export(): TerminationMetric[] {
    return [...this.metrics];
  }

  /**
   * 格式化输出统计报告
   */
  formatReport(): string {
    const stats = this.getStats();
    
    return `
╔════════════════════════════════════════════════════════════════╗
║              Termination Metrics Report                        ║
╚════════════════════════════════════════════════════════════════╝

📊 Summary
  Total Sessions:        ${stats.summary.totalSessions}
  Aborted:              ${stats.summary.abortedCount} (${stats.summary.abortedRate})
  Natural Completion:   ${stats.summary.naturalCompletionCount} (${stats.summary.naturalCompletionRate})

📈 Iterations
  p50:  ${stats.iterations.p50}
  p95:  ${stats.iterations.p95}
  p99:  ${stats.iterations.p99}
  mean: ${stats.iterations.mean.toFixed(1)}
  max:  ${stats.iterations.max}
  min:  ${stats.iterations.min}

🔧 Tool Calls
  p50:  ${stats.toolCalls.p50}
  p95:  ${stats.toolCalls.p95}
  mean: ${stats.toolCalls.mean.toFixed(1)}
  max:  ${stats.toolCalls.max}

🔄 Output Similarity
  Triggered:     ${stats.outputSimilarity.triggeredCount}
  Trigger Rate:  ${stats.outputSimilarity.triggerRate}
  Avg Similar:   ${stats.outputSimilarity.avgSimilarOutputs.toFixed(1)}

🎯 Termination Reasons
${Object.entries(stats.reasonPercentage)
  .sort((a, b) => parseFloat(b[1]) - parseFloat(a[1]))
  .map(([reason, pct]) => `  ${reason.padEnd(25)} ${pct.padStart(6)} (${stats.reasonDistribution[reason]})`)
  .join('\n')}
`;
  }

  // ── 辅助函数 ──

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((sorted.length * p) / 100) - 1;
    return sorted[Math.max(0, index)] || 0;
  }

  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  private categorizeReason(reason: string): string {
    const lower = reason.toLowerCase();
    
    if (lower.includes("natural completion") || lower.includes("finish_reason=stop")) {
      return "Natural Completion";
    }
    if (lower.includes("tool loop") || lower.includes("same tool")) {
      return "Tool Loop";
    }
    if (lower.includes("similar output")) {
      return "Output Similarity";
    }
    if (lower.includes("text-only")) {
      return "Text-only";
    }
    if (lower.includes("maximum iterations")) {
      return "Max Iterations";
    }
    if (lower.includes("maximum tool calls")) {
      return "Max Tool Calls";
    }
    if (lower.includes("token budget")) {
      return "Token Budget";
    }
    if (lower.includes("cost budget")) {
      return "Cost Budget";
    }
    
    return "Other";
  }

  private emptyStats(): TerminationStats {
    return {
      reasonDistribution: {},
      reasonPercentage: {},
      iterations: {
        total: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        mean: 0,
        max: 0,
        min: 0,
      },
      toolCalls: {
        total: 0,
        p50: 0,
        p95: 0,
        mean: 0,
        max: 0,
      },
      outputSimilarity: {
        triggeredCount: 0,
        triggerRate: "0.0%",
        avgSimilarOutputs: 0,
      },
      summary: {
        totalSessions: 0,
        abortedCount: 0,
        abortedRate: "0.0%",
        naturalCompletionCount: 0,
        naturalCompletionRate: "0.0%",
      },
    };
  }
}

// ── 全局收集器实例 ──
let globalCollector: TerminationMetricsCollector | null = null;

/**
 * 获取全局指标收集器
 */
export function getGlobalMetricsCollector(): TerminationMetricsCollector {
  if (!globalCollector) {
    globalCollector = new TerminationMetricsCollector(1000);
  }
  return globalCollector;
}

/**
 * 重置全局收集器（用于测试）
 */
export function resetGlobalMetricsCollector(): void {
  globalCollector = new TerminationMetricsCollector(1000);
}
