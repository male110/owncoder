import assert from "node:assert/strict";
import { test } from "vitest";
import {
  comparableHistoryText,
  dedupeSimilarHistoryHits,
  finalizeRecalledHistoryHits,
  HISTORY_MIN_RELEVANCE_SCORE,
  HISTORY_NEAR_DUPLICATE_THRESHOLD,
  historyTextSimilarity,
} from "../history-vector.ts";

function archivedRound(partial: {
  userInput: string;
  llmReport?: string;
  taskDecomposition?: unknown;
}): string {
  return JSON.stringify({
    userInput: partial.userInput,
    taskDecomposition: partial.taskDecomposition ?? { goal: "分析模块结构" },
    llmReport: partial.llmReport ?? "完整报告正文 UNIQUE_TAIL",
    evidence: [{ summary: "src/ 入口", path: "src/index.ts" }],
    toolCalls: [{ toolName: "read_file", arguments: { path: "src/index.ts" } }],
  });
}

test("comparableHistoryText 优先用 userInput/报告/分解，忽略 JSON 键名", () => {
  const content = archivedRound({
    userInput: "请分析 src/",
    llmReport: "报告尾 UNIQUE_TAIL",
    taskDecomposition: { goal: "分析模块" },
  });
  const text = comparableHistoryText(content);
  assert.match(text, /请分析 src\//);
  assert.match(text, /UNIQUE_TAIL/);
  assert.match(text, /分析模块/);
  assert.equal(text.includes("userInput"), false);
});

test("historyTextSimilarity：近重复高、主题不同低", () => {
  const shared = "请分析 src 目录 模块 结构 入口 文件 依赖 关系 导出 符号 调用 链";
  const a = shared;
  const b = `${shared} 补充`;
  const c = "改成 修复 Windows 路径 分隔符 不要 动 历史 召回";
  assert.ok(historyTextSimilarity(a, b) >= HISTORY_NEAR_DUPLICATE_THRESHOLD);
  assert.ok(historyTextSimilarity(a, c) < HISTORY_NEAR_DUPLICATE_THRESHOLD);
});

test("高相似只留最近一轮，保留项维持查询相关度顺序且正文不裁", () => {
  const longReport = `${"分析结果。".repeat(40)}UNIQUE_FULL_REPORT_TAIL`;
  const older = archivedRound({
    userInput: "请分析 src/ 模块结构",
    llmReport: longReport,
  });
  const newer = archivedRound({
    userInput: "请分析 src/ 模块结构",
    llmReport: longReport,
  });
  const unrelated = archivedRound({
    userInput: "改 Windows 路径分隔符",
    llmReport: "路径修复报告 PATH_FIX_TAIL",
    taskDecomposition: { goal: "修路径" },
  });

  const kept = dedupeSimilarHistoryHits([
    { content: older, turnIndex: 2, score: 0.95, turnId: "round:s:2", id: "old" },
    { content: unrelated, turnIndex: 4, score: 0.8, turnId: "round:s:4", id: "other" },
    { content: newer, turnIndex: 9, score: 0.72, turnId: "round:s:9", id: "new" },
  ]);

  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((hit) => hit.id), ["other", "new"]);
  assert.equal(kept[1].turnIndex, 9);
  assert.equal(kept[1].content, newer);
  assert.equal(kept[1].content.includes(longReport), true);
  assert.equal(kept[1].content.includes("UNIQUE_FULL_REPORT_TAIL"), true);
  assert.equal(kept.some((hit) => hit.id === "old"), false);
  assert.equal(kept[1].content.includes("…[truncated]"), false);
});

test("低相似的不同轮次全部保留", () => {
  const kept = dedupeSimilarHistoryHits([
    { content: "向量召回接线讨论", turnIndex: 2 },
    { content: "Windows 路径分隔符修复", turnIndex: 9 },
  ]);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((hit) => hit.turnIndex), [2, 9]);
});

test("finalizeRecalledHistoryHits：先丢 <60%，再对剩余高相似只留最近一轮", () => {
  const longReport = `${"分析结果。".repeat(40)}UNIQUE_FULL_REPORT_TAIL`;
  const older = archivedRound({
    userInput: "请分析 src/ 模块结构",
    llmReport: longReport,
  });
  const newerLowScore = archivedRound({
    userInput: "请分析 src/ 模块结构",
    llmReport: longReport,
  });
  const newerHighScore = archivedRound({
    userInput: "请分析 src/ 模块结构",
    llmReport: longReport,
  });
  const unrelated = archivedRound({
    userInput: "改 Windows 路径分隔符",
    llmReport: "路径修复报告 PATH_FIX_TAIL",
    taskDecomposition: { goal: "修路径" },
  });
  const noise = archivedRound({
    userInput: "今天天气怎么样",
    llmReport: "无关闲聊",
  });

  const kept = finalizeRecalledHistoryHits([
    { content: older, turnIndex: 2, score: 0.95, id: "old-high" },
    { content: noise, turnIndex: 3, score: 0.41, id: "noise" },
    { content: unrelated, turnIndex: 4, score: 0.88, id: "other" },
    { content: newerLowScore, turnIndex: 8, score: 0.4, id: "new-low" },
    { content: newerHighScore, turnIndex: 9, score: 0.81, id: "new-high" },
  ]);

  assert.equal(HISTORY_MIN_RELEVANCE_SCORE, 0.6);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((hit) => hit.id), ["other", "new-high"]);
  assert.equal(kept[1].content, newerHighScore);
  assert.equal(kept[1].content.includes(longReport), true);
  assert.equal(kept.some((hit) => hit.id === "old-high"), false);
  assert.equal(kept.some((hit) => hit.id === "new-low" || hit.id === "noise"), false);
});

test("finalizeRecalledHistoryHits：低分近重复先丢掉，不能挤掉高分旧轮", () => {
  const shared = archivedRound({
    userInput: "请分析 src/ 模块结构",
    llmReport: `${"分析结果。".repeat(20)}UNIQUE_KEEP_OLD`,
  });
  const kept = finalizeRecalledHistoryHits([
    { content: shared, turnIndex: 2, score: 0.95, id: "old-relevant" },
    { content: shared, turnIndex: 9, score: 0.4, id: "new-irrelevant" },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "old-relevant");
  assert.equal(kept[0].content.includes("UNIQUE_KEEP_OLD"), true);
});

test("turnIndex 相同时用 createdAt 保留更新的一轮", () => {
  const text = "请分析 src 目录 模块 结构 入口 文件 依赖 关系 导出 符号";
  const kept = dedupeSimilarHistoryHits([
    {
      content: text,
      turnIndex: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "old",
    },
    {
      content: `${text} 补充`,
      turnIndex: 3,
      createdAt: "2026-02-01T00:00:00.000Z",
      id: "new",
    },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "new");
});
