#!/usr/bin/env node
/**
 * CLI tool to view termination metrics
 * 
 * Usage:
 *   pnpm metrics:show              - 显示统计报告
 *   pnpm metrics:show --recent 5   - 显示最近5条记录
 *   pnpm metrics:show --clear      - 清空统计
 *   pnpm metrics:show --export     - 导出原始数据(JSON)
 */

import { getGlobalMetricsCollector } from "./termination-metrics.ts";

function main() {
  const args = process.argv.slice(2);
  const collector = getGlobalMetricsCollector();

  // --clear: 清空统计
  if (args.includes("--clear")) {
    collector.clear();
    console.log("✓ Metrics cleared");
    return;
  }

  // --export: 导出原始数据
  if (args.includes("--export")) {
    const data = collector.export();
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // --recent N: 显示最近N条记录
  const recentIdx = args.indexOf("--recent");
  if (recentIdx !== -1) {
    const count = parseInt(args[recentIdx + 1] || "10", 10);
    const recent = collector.getRecent(count);
    
    console.log(`\n📋 Last ${count} Termination Events\n`);
    
    if (recent.length === 0) {
      console.log("  No data collected yet.\n");
      return;
    }

    for (const [idx, metric] of recent.entries()) {
      const time = new Date(metric.timestamp).toLocaleString();
      const status = metric.isAborted ? "⚠️ ABORTED" : "✓ Complete";
      
      console.log(`${idx + 1}. [${time}] ${status}`);
      console.log(`   Reason: ${metric.terminationReason}`);
      console.log(`   Iterations: ${metric.iterations}, Tools: ${metric.totalToolCalls}`);
      console.log(`   Similar Outputs: ${metric.consecutiveSimilarOutputs}, Text-only: ${metric.consecutiveTextOnlyTurns}`);
      if (metric.sessionId) {
        console.log(`   Session: ${metric.sessionId}`);
      }
      console.log();
    }
    return;
  }

  // 默认：显示统计报告
  const report = collector.formatReport();
  console.log(report);
}

main();
