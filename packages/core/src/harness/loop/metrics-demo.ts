#!/usr/bin/env node
/**
 * Demo script to populate sample metrics data and show reports
 */

import { getGlobalMetricsCollector } from "./termination-metrics.js";

console.log("📊 Demo: React Loop Termination Metrics\n");
console.log("=" .repeat(70) + "\n");

const collector = getGlobalMetricsCollector();

// 1. 模拟各种终止场景
console.log("Step 1: Populating sample data...\n");

const scenarios = [
  // 自然完成（最常见，60%）
  { reason: "Natural Completion (finish_reason=stop)", aborted: false, iterations: 4, toolCalls: 8 },
  { reason: "Natural Completion (finish_reason=stop)", aborted: false, iterations: 3, toolCalls: 6 },
  { reason: "Natural Completion (finish_reason=stop)", aborted: false, iterations: 5, toolCalls: 12 },
  { reason: "Natural Completion (finish_reason=stop)", aborted: false, iterations: 6, toolCalls: 15 },
  { reason: "Natural Completion (finish_reason=stop)", aborted: false, iterations: 2, toolCalls: 4 },
  { reason: "Natural Completion (finish_reason=stop)", aborted: false, iterations: 7, toolCalls: 18 },
  
  // 工具循环（20%）
  { reason: "Tool Loop detected (read_file repeated 3 times)", aborted: true, iterations: 12, toolCalls: 25 },
  { reason: "Tool Loop detected (grep_search repeated 3 times)", aborted: true, iterations: 8, toolCalls: 18 },
  
  // 输出相似（10%）
  { reason: "Detected 2 consecutive similar outputs (>80% Jaccard)", aborted: false, iterations: 7, toolCalls: 14 },
  
  // 达到上限（10%）
  { reason: "Reached maximum iterations (30)", aborted: true, iterations: 30, toolCalls: 95 },
];

for (const [idx, scenario] of scenarios.entries()) {
  collector.record({
    timestamp: Date.now() - (scenarios.length - idx) * 1000 * 60, // 每条记录间隔1分钟
    sessionId: `demo_session_${String(idx + 1).padStart(3, '0')}`,
    terminationReason: scenario.reason,
    isAborted: scenario.aborted,
    iterations: scenario.iterations,
    totalToolCalls: scenario.toolCalls,
    consecutiveSimilarOutputs: scenario.reason.includes("similar") ? 2 : 0,
    consecutiveTextOnlyTurns: scenario.reason.includes("text-only") ? 2 : 0,
  });
}

console.log(`✓ Added ${scenarios.length} sample records\n`);

// 2. 显示统计报告
console.log("Step 2: Generating statistics report...\n");
console.log(collector.formatReport());

// 3. 显示最近记录
console.log("\n" + "=".repeat(70) + "\n");
console.log("Step 3: Recent termination events (last 3):\n");

const recent = collector.getRecent(3);
for (const [idx, metric] of recent.entries()) {
  const time = new Date(metric.timestamp).toLocaleString();
  const status = metric.isAborted ? "⚠️  ABORTED" : "✓  Complete";
  
  console.log(`${idx + 1}. [${time}] ${status}`);
  console.log(`   Reason: ${metric.terminationReason}`);
  console.log(`   Iterations: ${metric.iterations}, Tool Calls: ${metric.totalToolCalls}`);
  console.log(`   Session: ${metric.sessionId}\n`);
}

// 4. 编程 API 演示
console.log("=".repeat(70) + "\n");
console.log("Step 4: Using programmatic API:\n");

const stats = collector.getStats();
console.log(`• Total sessions: ${stats.summary.totalSessions}`);
console.log(`• Natural completion rate: ${stats.summary.naturalCompletionRate}`);
console.log(`• Aborted rate: ${stats.summary.abortedRate}`);
console.log(`• p50 iterations: ${stats.iterations.p50}`);
console.log(`• p95 iterations: ${stats.iterations.p95}`);
console.log(`• p95 tool calls: ${stats.toolCalls.p95}`);
console.log(`• Output similarity trigger rate: ${stats.outputSimilarity.triggerRate}\n`);

// 5. 导出数据演示
console.log("=".repeat(70) + "\n");
console.log("Step 5: Exporting raw data (first 2 records):\n");

const exported = collector.export().slice(0, 2);
console.log(JSON.stringify(exported, null, 2));

console.log("\n" + "=".repeat(70));
console.log("\n✅ Demo complete! Use these commands in real scenarios:");
console.log("   pnpm metrics:show      # View statistics report");
console.log("   pnpm metrics:recent 5  # View last 5 events");
console.log("   pnpm metrics:export    # Export raw JSON data");
console.log("   pnpm metrics:clear     # Clear collected data\n");

