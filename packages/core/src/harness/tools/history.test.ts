import assert from "node:assert/strict";
import { test } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import type { IndexClient } from "@owncoder/index";
import type { HistorySearchHit } from "../loop/history-vector.ts";
import { executeTool } from "../execute.ts";
import { historyRecallQuery, toolRecallHistory } from "./history.ts";
import type { ToolContext } from "./types.ts";

function stubIndex(): IndexClient {
  return {
    async open() {},
    async getTags() {
      return [];
    },
    async buildRepoMap() {
      return "";
    },
    invalidate() {},
    async rebuildAll() {},
    status() {
      return { kind: "ready", fileCount: 0, tagCount: 0 };
    },
  };
}

function makeHit(partial: Partial<HistorySearchHit> & { content: string; score: number }): HistorySearchHit {
  return {
    id: partial.id ?? "id-1",
    turnId: partial.turnId ?? "round:sess-1:1",
    sessionId: partial.sessionId ?? "sess-1",
    role: partial.role ?? "assistant",
    content: partial.content,
    contentHash: partial.contentHash ?? "hash-1",
    createdAt: partial.createdAt ?? new Date().toISOString(),
    turnIndex: partial.turnIndex ?? 1,
    score: partial.score,
  };
}

function makeCtx(hits: HistorySearchHit[]): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    mode: "agent",
    workflow: BUILTIN_WORKFLOW,
    sessionId: "sess-1",
    index: stubIndex(),
    readSet: new Set(),
    maxOutputChars: 24_000,
    bashMaxChars: 10_000,
    historyVector: {
      embedding: {
        async embed() {
          return new Float32Array([0.1, 0.2, 0.3]);
        },
      },
      store: {
        archive() {},
        hasContentHash() {
          return false;
        },
        search() {
          return hits;
        },
        countBySession() {
          return hits.length;
        },
        deleteBySession() {},
      },
    },
  };
}

test("historyRecallQuery reads query or keyword", () => {
  assert.equal(historyRecallQuery({ query: "向量召回" }), "向量召回");
  assert.equal(historyRecallQuery({ keyword: "fallback" }), "fallback");
});

test("toolRecallHistory 返回完整 LLM 报告，不按字段截断", async () => {
  const longReport = `${"分析结果。".repeat(900)}UNIQUE_TAIL_MARKER`;
  assert.ok(longReport.length > 4_000);

  const archived = JSON.stringify({
    userInput: "请分析 src/",
    taskDecomposition: { goal: "分析模块结构" },
    llmReport: longReport,
    evidence: [{ summary: "src/ 入口", path: "src/index.ts" }],
    toolCalls: [{ toolName: "read_file", arguments: { path: "src/index.ts" } }],
  });

  const result = await toolRecallHistory(
    makeCtx([makeHit({ content: archived, score: 0.92 })]),
    "分析模块",
  );

  assert.equal(result.ok, true);
  assert.match(result.output, /请分析 src\//);
  assert.match(result.output, /UNIQUE_TAIL_MARKER/);
  assert.equal(result.output.includes(longReport), true);
  assert.equal(result.output.includes("…[truncated]"), false);
});

test("executeTool(recall_history) 出口不再按 maxOutputChars 截断完整报告", async () => {
  const longReport = `${"分析结果。".repeat(5_000)}UNIQUE_TAIL_MARKER`;
  assert.ok(longReport.length > 24_000);

  const archived = JSON.stringify({
    userInput: "请分析 src/",
    taskDecomposition: { goal: "分析模块结构" },
    llmReport: longReport,
    evidence: [],
    toolCalls: [],
  });

  const result = await executeTool(
    makeCtx([makeHit({ content: archived, score: 0.92 })]),
    {
      id: "call-recall-1",
      name: "recall_history",
      arguments: { query: "分析模块" },
      rawArguments: JSON.stringify({ query: "分析模块" }),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.includes(longReport), true);
  assert.equal(result.output.includes("UNIQUE_TAIL_MARKER"), true);
  assert.equal(result.output.includes("…[truncated"), false);
});

test("toolRecallHistory 高相似历史只留最近一轮，低相似都保留且正文不裁", async () => {
  const longReport = `${"分析结果。".repeat(80)}UNIQUE_FULL_REPORT_TAIL`;
  const otherReport = "路径修复完成 PATH_FIX_UNIQUE_TAIL";

  const older = JSON.stringify({
    userInput: "请分析 src/ 模块结构",
    taskDecomposition: { goal: "分析模块结构" },
    llmReport: longReport,
    evidence: [{ summary: "OLDER_ROUND_MARKER" }],
    toolCalls: [],
  });
  const newer = JSON.stringify({
    userInput: "请分析 src/ 模块结构",
    taskDecomposition: { goal: "分析模块结构" },
    llmReport: longReport,
    evidence: [{ summary: "NEWER_ROUND_MARKER" }],
    toolCalls: [],
  });
  const other = JSON.stringify({
    userInput: "改 Windows 路径分隔符",
    taskDecomposition: { goal: "修路径" },
    llmReport: otherReport,
    evidence: [],
    toolCalls: [],
  });

  const result = await toolRecallHistory(
    makeCtx([
      makeHit({ id: "old", turnId: "round:sess-1:2", content: older, score: 0.95, turnIndex: 2 }),
      makeHit({ id: "other", turnId: "round:sess-1:4", content: other, score: 0.88, turnIndex: 4 }),
      makeHit({ id: "new", turnId: "round:sess-1:9", content: newer, score: 0.81, turnIndex: 9 }),
    ]),
    "分析模块",
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.includes(longReport), true);
  assert.equal(result.output.includes("UNIQUE_FULL_REPORT_TAIL"), true);
  assert.equal(result.output.includes("NEWER_ROUND_MARKER"), true);
  assert.equal(result.output.includes(otherReport), true);
  assert.equal(result.output.includes("PATH_FIX_UNIQUE_TAIL"), true);
  assert.equal(result.output.includes("OLDER_ROUND_MARKER"), false);
  assert.equal(result.output.includes("…[truncated]"), false);
  assert.match(result.output, /## Match 1/);
  assert.match(result.output, /## Match 2/);
  assert.equal(result.output.includes("## Match 3"), false);
});

test("toolRecallHistory 先丢相关性 <60%，再对剩余高相似只留最近一轮", async () => {
  const longReport = `${"分析结果。".repeat(80)}UNIQUE_FULL_REPORT_TAIL`;
  const otherReport = "路径修复完成 PATH_FIX_UNIQUE_TAIL";

  const older = JSON.stringify({
    userInput: "请分析 src/ 模块结构",
    taskDecomposition: { goal: "分析模块结构" },
    llmReport: longReport,
    evidence: [{ summary: "OLDER_ROUND_MARKER" }],
    toolCalls: [],
  });
  const newerLowScore = JSON.stringify({
    userInput: "请分析 src/ 模块结构",
    taskDecomposition: { goal: "分析模块结构" },
    llmReport: longReport,
    evidence: [{ summary: "LOW_SCORE_NEAR_DUP_MARKER" }],
    toolCalls: [],
  });
  const newer = JSON.stringify({
    userInput: "请分析 src/ 模块结构",
    taskDecomposition: { goal: "分析模块结构" },
    llmReport: longReport,
    evidence: [{ summary: "NEWER_ROUND_MARKER" }],
    toolCalls: [],
  });
  const other = JSON.stringify({
    userInput: "改 Windows 路径分隔符",
    taskDecomposition: { goal: "修路径" },
    llmReport: otherReport,
    evidence: [],
    toolCalls: [],
  });
  const noise = JSON.stringify({
    userInput: "今天天气怎么样",
    taskDecomposition: { goal: "闲聊" },
    llmReport: "无关闲聊",
    evidence: [{ summary: "NOISE_MARKER" }],
    toolCalls: [],
  });

  const result = await toolRecallHistory(
    makeCtx([
      makeHit({ id: "old", turnId: "round:sess-1:2", content: older, score: 0.95, turnIndex: 2 }),
      makeHit({ id: "noise", turnId: "round:sess-1:3", content: noise, score: 0.41, turnIndex: 3 }),
      makeHit({ id: "other", turnId: "round:sess-1:4", content: other, score: 0.88, turnIndex: 4 }),
      makeHit({ id: "new-low", turnId: "round:sess-1:8", content: newerLowScore, score: 0.4, turnIndex: 8 }),
      makeHit({ id: "new", turnId: "round:sess-1:9", content: newer, score: 0.81, turnIndex: 9 }),
    ]),
    "分析模块",
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.includes(longReport), true);
  assert.equal(result.output.includes("NEWER_ROUND_MARKER"), true);
  assert.equal(result.output.includes(otherReport), true);
  assert.equal(result.output.includes("OLDER_ROUND_MARKER"), false);
  assert.equal(result.output.includes("LOW_SCORE_NEAR_DUP_MARKER"), false);
  assert.equal(result.output.includes("NOISE_MARKER"), false);
  assert.equal(result.output.includes("…[truncated]"), false);
  assert.match(result.output, /## Match 1/);
  assert.match(result.output, /## Match 2/);
  assert.equal(result.output.includes("## Match 3"), false);
});

test("toolRecallHistory 低分近重复先丢掉，不能挤掉高分旧轮", async () => {
  const longReport = `${"分析结果。".repeat(40)}UNIQUE_KEEP_OLD`;
  const older = JSON.stringify({
    userInput: "请分析 src/ 模块结构",
    taskDecomposition: { goal: "分析模块结构" },
    llmReport: longReport,
    evidence: [{ summary: "KEEP_OLD_MARKER" }],
    toolCalls: [],
  });
  const newerLowScore = JSON.stringify({
    userInput: "请分析 src/ 模块结构",
    taskDecomposition: { goal: "分析模块结构" },
    llmReport: longReport,
    evidence: [{ summary: "DROP_LOW_SCORE_MARKER" }],
    toolCalls: [],
  });

  const result = await toolRecallHistory(
    makeCtx([
      makeHit({ id: "old", turnId: "round:sess-1:2", content: older, score: 0.95, turnIndex: 2 }),
      makeHit({ id: "new-low", turnId: "round:sess-1:9", content: newerLowScore, score: 0.4, turnIndex: 9 }),
    ]),
    "分析模块",
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.includes("KEEP_OLD_MARKER"), true);
  assert.equal(result.output.includes(longReport), true);
  assert.equal(result.output.includes("DROP_LOW_SCORE_MARKER"), false);
});

test("toolRecallHistory 无向量索引时给出空结果提示", async () => {
  const ctx = makeCtx([]);
  delete ctx.historyVector;
  const result = await toolRecallHistory(ctx, "任意查询");
  assert.equal(result.ok, true);
  assert.match(result.output, /No searchable session history/);
});
