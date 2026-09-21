import assert from "node:assert/strict";
import { test } from "vitest";
import {
  inferTaskIntent,
  planMinimumContext,
  resolveMinimumContextConfig,
  type ContextCandidate,
  type ContextTaskSignal,
} from "./minimum-context.ts";

function task(overrides: Partial<ContextTaskSignal> = {}): ContextTaskSignal {
  return {
    mode: "agent",
    intent: "inspect",
    query: "explain the authentication flow",
    explicitPaths: [],
    activePaths: [],
    ...overrides,
  };
}

function candidate(
  id: string,
  source: ContextCandidate["source"],
  estimatedTokens: number,
  overrides: Partial<ContextCandidate> = {},
): ContextCandidate {
  return {
    id,
    source,
    content: `${id} unique context evidence`,
    estimatedTokens,
    provenance: "test",
    freshness: "current",
    ...overrides,
  };
}

test("uses apply mode by default and accepts an explicit opt-out", () => {
  assert.equal(resolveMinimumContextConfig(undefined, 400).mode, "apply");
  assert.equal(resolveMinimumContextConfig(false, 400).mode, "off");
  assert.deepEqual(resolveMinimumContextConfig({ mode: "observe", maxCandidates: 3 }, 400), {
    mode: "observe",
    tokenBudget: 400,
    maxCandidates: 3,
    emitDecisionTrace: false,
  });
});

test("always retains mandatory context while selecting an explicit indexed path under budget", () => {
  const plan = planMinimumContext({
    task: task({
      intent: "inspect",
      query: "inspect the login check",
      explicitPaths: ["src/auth.ts"],
    }),
    config: resolveMinimumContextConfig({ tokenBudget: 90, maxCandidates: 3 }, 400),
    candidates: [
      candidate("rules", "memory", 30, { mandatory: true }),
      candidate("auth-knowledge", "knowledge", 40, {
        path: "src/auth.ts",
        freshness: "indexed",
      }),
      candidate("dependency-list", "deps", 80),
    ],
  });

  assert.deepEqual(plan.selected.map((item) => item.id), ["rules", "auth-knowledge"]);
  assert.deepEqual(plan.requiresFreshRead, ["src/auth.ts"]);
  assert.equal(plan.omitted.find((item) => item.id === "dependency-list")?.reason, "budget");
});

test("drops a lower-value duplicate by content rather than only by path", () => {
  const plan = planMinimumContext({
    task: task(),
    config: resolveMinimumContextConfig({ tokenBudget: 200, maxCandidates: 4 }, 400),
    candidates: [
      candidate("map", "knowledge", 30, {
        path: "src/map.ts",
        content: "alpha beta gamma delta epsilon",
      }),
      candidate("search", "short-term", 30, {
        path: "src/other.ts",
        content: "alpha beta gamma delta epsilon",
      }),
    ],
  });

  assert.deepEqual(plan.selected.map((item) => item.id), ["map"]);
  assert.equal(plan.omitted.find((item) => item.id === "search")?.reason, "redundant");
});

test("is deterministic and keeps the baseline intact in off mode", () => {
  const candidates = [
    candidate("a", "knowledge", 40),
    candidate("b", "short-term", 30),
    candidate("c", "deps", 20),
  ];
  const input = {
    task: task(),
    candidates,
    config: resolveMinimumContextConfig({ tokenBudget: 70, maxCandidates: 2 }, 400),
  };
  const first = planMinimumContext(input);
  const second = planMinimumContext(input);

  assert.deepEqual(first.selected.map((item) => item.id), second.selected.map((item) => item.id));
  const off = planMinimumContext({
    ...input,
    config: resolveMinimumContextConfig(false, 1),
  });
  assert.deepEqual(off.selected.map((item) => item.id), ["a", "b", "c"]);
});

test("classifies multilingual task hints without making text classification authoritative", () => {
  assert.equal(inferTaskIntent("请修复登录错误", "agent"), "change");
  assert.equal(inferTaskIntent("为什么这个模块报错？", "agent"), "debug");
  assert.equal(inferTaskIntent("认证模块是怎么工作的？", "agent"), "inspect");
  assert.equal(inferTaskIntent("write a plan", "plan"), "plan");
});
