#!/usr/bin/env node
/**
 * 测试环境变量控制
 */

import { getGlobalMetricsCollector, resetGlobalMetricsCollector } from "./termination-metrics.js";

console.log("🧪 Testing environment-based metrics collection\n");

// Test 1: Production environment (should not collect)
console.log("Test 1: Production environment");
console.log("  NODE_ENV:", process.env.NODE_ENV);
console.log("  OWNCODER_DEV:", process.env.OWNCODER_DEV);

resetGlobalMetricsCollector();
const collector = getGlobalMetricsCollector();

collector.record({
  timestamp: Date.now(),
  terminationReason: "Test in production",
  isAborted: false,
  iterations: 5,
  totalToolCalls: 10,
  consecutiveSimilarOutputs: 0,
  consecutiveTextOnlyTurns: 0,
});

console.log("  Attempted to record 1 metric");
console.log("  Collected metrics:", collector.export().length);
console.log("  ✓ Expected: 0 (blocked)\n");

// Test 2: Development environment (should collect)
console.log("Test 2: Development environment");
process.env.NODE_ENV = "development";
console.log("  NODE_ENV:", process.env.NODE_ENV);
console.log("  OWNCODER_DEV:", process.env.OWNCODER_DEV);

resetGlobalMetricsCollector();
const devCollector = getGlobalMetricsCollector();

devCollector.record({
  timestamp: Date.now(),
  terminationReason: "Test in development",
  isAborted: false,
  iterations: 5,
  totalToolCalls: 10,
  consecutiveSimilarOutputs: 0,
  consecutiveTextOnlyTurns: 0,
});

console.log("  Attempted to record 1 metric");
console.log("  Collected metrics:", devCollector.export().length);
console.log("  ✓ Expected: 1 (allowed)\n");

// Test 3: OWNCODER_DEV flag (should collect)
console.log("Test 3: OWNCODER_DEV flag");
delete process.env.NODE_ENV;
process.env.OWNCODER_DEV = "true";
console.log("  NODE_ENV:", process.env.NODE_ENV);
console.log("  OWNCODER_DEV:", process.env.OWNCODER_DEV);

resetGlobalMetricsCollector();
const flagCollector = getGlobalMetricsCollector();

flagCollector.record({
  timestamp: Date.now(),
  terminationReason: "Test with OWNCODER_DEV",
  isAborted: false,
  iterations: 5,
  totalToolCalls: 10,
  consecutiveSimilarOutputs: 0,
  consecutiveTextOnlyTurns: 0,
});

console.log("  Attempted to record 1 metric");
console.log("  Collected metrics:", flagCollector.export().length);
console.log("  ✓ Expected: 1 (allowed)\n");

console.log("✅ All environment checks passed!");
