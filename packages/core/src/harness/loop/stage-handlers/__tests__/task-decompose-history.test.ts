import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadRecentRounds,
  persistDecomposeRound,
  persistRoundReport,
  persistRoundEvidence,
  persistRoundFileChanges,
  persistRoundToolCalls,
  formatRoundBlock,
  formatRoundsForDecomposeHistory,
  collectReadEvidenceFromTurns,
  collectToolCallsFromTurns,
  formatRecentFileHints,
  type PersistedEvidence,
  type PersistedFileChange,
} from "../../../../turn-rounds.ts";
import type { AgentLoopOpts, ChatTurn } from "../../types.ts";
import type { HistoryChunk } from "../../history-vector.ts";

// extractStructuredHistory 已从 task-decompose.ts 导出
import {
  extractStructuredHistory,
  parseDecomposeAnswer,
  packFallbackRelevantHistory,
  isCurrentCodeBehaviorInquiry,
  recoverEmptyDecomposeSteps,
  formatRecalledHistoryChunks,
  recallHistoryByUserInput,
  buildDecomposeContext,
  rankAndFilterByRelevance,
  estimateTextRelevance,
  RELEVANT_HISTORY_SCORE_THRESHOLD,
} from "../task-decompose.ts";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import { contextBudgets } from "../../../budget.ts";

// ── 临时目录 ──
let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), "rounds-test-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── 基础轮次 ──
describe("extractStructuredHistory (旧格式 fallback)", () => {
  const mkTurn = (role: ChatTurn["role"], content: string, extra?: Partial<ChatTurn>): ChatTurn => ({
    role,
    content,
    ...extra,
  });

  it("正序提取 user→assistant 归属正确", () => {
    const history: ChatTurn[] = [
      mkTurn("user", "你好"),
      mkTurn("assistant", "你好！有什么可以帮你？"),
      mkTurn("user", "帮我分析代码"),
      mkTurn("assistant", "分析完成，结果是 X"),
    ];
    const rounds = extractStructuredHistory(history, 5, false);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].userInput).toBe("你好");
    expect(rounds[0].assistantReport).toBe("你好！有什么可以帮你？");
    expect(rounds[1].userInput).toBe("帮我分析代码");
    expect(rounds[1].assistantReport).toBe("分析完成，结果是 X");
  });

  it("多条 assistant 全部保留，不只取第一条", () => {
    const history: ChatTurn[] = [
      mkTurn("user", "任务"),
      mkTurn("assistant", "第一步"),
      mkTurn("assistant", "第二步"),
      mkTurn("assistant", "最终结果"),
    ];
    const rounds = extractStructuredHistory(history, 5, false);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].assistantReport).toContain("第一步");
    expect(rounds[0].assistantReport).toContain("第二步");
    expect(rounds[0].assistantReport).toContain("最终结果");
  });

  it("tool/toolName 和 assistant 都保留在 transcript", () => {
    const history: ChatTurn[] = [
      mkTurn("user", "查找问题"),
      mkTurn("tool", "文件内容 ABC", { toolName: "read_file" }),
      mkTurn("assistant", "找到问题：ABC"),
    ];
    const rounds = extractStructuredHistory(history, 5, false);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].transcript).toContain("[tool:read_file] 文件内容 ABC");
    expect(rounds[0].transcript).toContain("[assistant] 找到问题：ABC");
  });

  it("保留工具调用的名称及完整参数，不保存返回结果", () => {
    const calls = collectToolCallsFromTurns([
      {
        parts: [
          { type: "tool_use", id: "call-1", name: "bash", input: { command: "git status", timeout: 1200, nested: { enabled: true } } },
          { type: "tool_result", tool_use_id: "call-1", content: "clean" },
        ],
      },
    ]);
    expect(calls).toEqual([{
      id: "call-1",
      toolName: "bash",
      arguments: { command: "git status", timeout: 1200, nested: { enabled: true } },
    }]);
  });

  it("parts 中 text/tool_result/tool_use 提取时不注入工具结果", () => {
    const history: ChatTurn[] = [
      mkTurn("user", "操作"),
      {
        role: "tool",
        content: "",
        toolName: "read_file",
        parts: [{ type: "tool_result", tool_use_id: "1", content: "文件结果" }],
      } as ChatTurn,
      {
        role: "assistant",
        content: "",
        parts: [
          { type: "text", text: "从文件中发现" },
          { type: "tool_use", id: "2", name: "grep", input: { query: "TODO" } },
        ],
      } as ChatTurn,
    ];
    const rounds = extractStructuredHistory(history, 5, false);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].transcript).not.toContain("文件结果");
    expect(rounds[0].transcript).toContain("[assistant] 从文件中发现");
    expect(rounds[0].transcript).toContain('[grep] {"query":"TODO"}');
  });

  it("excludeCurrentTurn=true 排除最后一条 user", () => {
    const history: ChatTurn[] = [
      mkTurn("user", "第一轮"),
      mkTurn("assistant", "回复"),
      mkTurn("user", "当前轮"),
    ];
    const rounds = extractStructuredHistory(history, 5, true);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].userInput).toBe("第一轮");
  });

  it("decompose JSON 保留完整结构，不只是 understanding", () => {
    const decomposeObj = {
      understanding: "理解用户需求",
      userConstraints: ["不能修改配置"],
      steps: [{ id: "s1", description: "步骤1", dependsOn: [], informationNeeds: [], stopReadingWhen: [] }],
    };
    const history: ChatTurn[] = [
      mkTurn("user", "分析需求"),
      mkTurn("assistant", JSON.stringify(decomposeObj)),
    ];
    const rounds = extractStructuredHistory(history, 5, false);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].taskDecompose).toBeDefined();
    const parsed = JSON.parse(rounds[0].taskDecompose!);
    expect(parsed.understanding).toBe("理解用户需求");
    expect(parsed.userConstraints).toEqual(["不能修改配置"]);
    expect(parsed.steps).toHaveLength(1);
  });

  it("fenced JSON 也可识别为 decompose", () => {
    const decomposeObj = {
      understanding: "fenced 解析",
      steps: [{ id: "s1", description: "步骤", dependsOn: [], informationNeeds: [], stopReadingWhen: [] }],
    };
    const history: ChatTurn[] = [
      mkTurn("user", "请求"),
      mkTurn("assistant", `结果：\n\`\`\`json\n${JSON.stringify(decomposeObj)}\n\`\`\``),
    ];
    const rounds = extractStructuredHistory(history, 5, false);
    expect(rounds).toHaveLength(1);
    const parsed = JSON.parse(rounds[0].taskDecompose!);
    expect(parsed.understanding).toBe("fenced 解析");
  });

  it("旧消息中已有的 <conversation_history> 标签被剥离", () => {
    const history: ChatTurn[] = [
      mkTurn("user", "原始请求"),
      mkTurn("assistant", "<conversation_history>\n旧历史\n</conversation_history>\n\n实际报告"),
    ];
    const rounds = extractStructuredHistory(history, 5, false);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].transcript).not.toContain("<conversation_history>");
    expect(rounds[0].transcript).toContain("旧历史");
    expect(rounds[0].transcript).toContain("实际报告");
  });

  it("jsonrepair 可修复的 JSON 仍然识别为 decompose", () => {
    const history: ChatTurn[] = [
      mkTurn("user", "任务"),
      mkTurn("assistant", '{"understanding": "broken", "steps": [}]'),
    ];
    const rounds = extractStructuredHistory(history, 5, false);
    expect(rounds).toHaveLength(1);
    // jsonrepair 将 [}] 修复为 []，所以仍被识别为 decompose
    expect(rounds[0].taskDecompose).toBeDefined();
    const parsed = JSON.parse(rounds[0].taskDecompose!);
    expect(parsed.understanding).toBe("broken");
  });

  it("完全无法解析的内容不崩溃，保留原文", () => {
    const history: ChatTurn[] = [
      mkTurn("user", "任务"),
      mkTurn("assistant", '这不是 JSON，只是一段普通文本'),
    ];
    const rounds = extractStructuredHistory(history, 5, false);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].taskDecompose).toBeUndefined();
    expect(rounds[0].transcript).toContain("普通文本");
  });

  it("连续 tool 和 assistant 正确归属同一轮", () => {
    const history: ChatTurn[] = [
      mkTurn("user", "查找"),
      mkTurn("tool", "结果1", { toolName: "grep" }),
      mkTurn("tool", "结果2", { toolName: "read_file" }),
      mkTurn("assistant", "中间思考"),
      mkTurn("tool", "结果3", { toolName: "search_code" }),
      mkTurn("assistant", "最终报告"),
    ];
    const rounds = extractStructuredHistory(history, 5, false);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].transcript).toContain("[tool:grep]");
    expect(rounds[0].transcript).toContain("[tool:read_file]");
    expect(rounds[0].transcript).toContain("[tool:search_code]");
    expect(rounds[0].transcript).toContain("[assistant] 中间思考");
    expect(rounds[0].transcript).toContain("[assistant] 最终报告");
  });
});

// ── 同轮 decompose→report/evidence 持久化链路 ──
describe("decompose→report/evidence 同轮持久化", () => {
  const SESSION_ID = "test-session-001";
  const USER_INPUT = "帮我分析代码库结构";

  const decompose = {
    understanding: "用户需要了解代码库结构",
    userConstraints: ["只看 TypeScript 文件"],
    steps: [
      {
        id: "s1",
        description: "扫描目录结构",
        dependsOn: [],
        informationNeeds: [{ id: "n1", question: "有哪些子目录？" }],
        stopReadingWhen: [{ condition: "知道所有顶层目录", requiredEvidenceIds: [] }],
      },
    ],
  };

  it("decompose 持久化后 report 更新同一轮，不新建", async () => {
    const record = await persistDecomposeRound(tmpDir, SESSION_ID, USER_INPUT, decompose);
    expect(record).not.toBeNull();
    expect(record!.taskDecompose?.understanding).toBe("用户需要了解代码库结构");
    expect(record!.taskDecompose?.userConstraints).toEqual(["只看 TypeScript 文件"]);
    expect(record!.taskDecompose?.steps).toHaveLength(1);

    const reportRecord = await persistRoundReport(
      tmpDir, SESSION_ID, USER_INPUT, "分析结果：src/ 包含 5 个模块", record!.index,
    );
    expect(reportRecord).not.toBeNull();
    expect(reportRecord!.index).toBe(record!.index);
    expect(reportRecord!.taskDecompose?.understanding).toBe("用户需要了解代码库结构");
    expect(reportRecord!.assistantReport).toBe("分析结果：src/ 包含 5 个模块");

    // 再次读取确认只有一个 round
    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].taskDecompose?.understanding).toBe("用户需要了解代码库结构");
    expect(rounds[0].assistantReport).toBe("分析结果：src/ 包含 5 个模块");
  });

  it("evidence 写入同一轮", async () => {
    const record = await persistDecomposeRound(tmpDir, SESSION_ID, USER_INPUT, decompose);
    const evidence: PersistedEvidence[] = [
      {
        needId: "n1",
        summary: "发现 5 个子目录",
        path: "src/",
        symbol: undefined,
        startLine: 1,
        endLine: 10,
        excerpt: "src/a\nsrc/b\nsrc/c",
      },
    ];
    await persistRoundEvidence(tmpDir, SESSION_ID, USER_INPUT, record!.index, evidence);

    await persistRoundReport(tmpDir, SESSION_ID, USER_INPUT, "报告", record!.index);

    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].evidence).toHaveLength(1);
    expect(rounds[0].evidence![0].summary).toBe("发现 5 个子目录");
    expect(rounds[0].taskDecompose?.understanding).toBe("用户需要了解代码库结构");
  });

  it("读文件 evidence 保存完整原文，不截断 30 行", async () => {
    const record = await persistDecomposeRound(tmpDir, SESSION_ID, USER_INPUT, decompose);
    const excerpt = [
      "Read src/full.ts (lines 1-40 of 40)",
      "[lines 1-40 of 40]",
      ...Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(4, " ")}|line ${i + 1}`),
    ].join("\n");
    await persistRoundEvidence(tmpDir, SESSION_ID, USER_INPUT, record!.index, [
      {
        needId: "",
        summary: "Read src/full.ts lines 1-40",
        path: "src/full.ts",
        startLine: 1,
        endLine: 40,
        excerpt,
      },
    ]);
    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    expect(rounds[0].evidence![0].excerpt).toBe(excerpt);
    expect(rounds[0].evidence![0].excerpt).toContain("line 40");
  });

  it("collectReadEvidenceFromTurns 从历史还原完整读文件内容", () => {
    const excerptBody = [
      "[lines 1-8 of 8]",
      "   1|export function add(a: number, b: number) {",
      "   2|  return a + b;",
      "   3|}",
    ].join("\n");
    const content = `Read src/math.ts (lines 1-8 of 8)\n${excerptBody}`;
    const items = collectReadEvidenceFromTurns([
      { role: "tool", toolName: "read_file", content },
      { role: "tool", toolName: "write_file", content: "Wrote src/math.ts (3 lines)." },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].path).toBe("src/math.ts");
    expect(items[0].startLine).toBe(1);
    expect(items[0].endLine).toBe(8);
    expect(items[0].excerpt).toBe(content);
  });

  it("collectReadEvidenceFromTurns 跳过失败的读", () => {
    const items = collectReadEvidenceFromTurns([
      { role: "tool", toolName: "read_file", content: "read_file failed: Error: File not found: \"src/missing.ts\"" },
      { role: "tool", toolName: "read_file", content: "Error: Cannot read file \"src/x.ts\": EACCES" },
      { role: "tool", toolName: "read_file", content: "Read src/ok.ts (lines 1-2 of 2)\n[lines 1-2 of 2]\n   1|ok" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].path).toBe("src/ok.ts");
  });

  it("formatRecentFileHints 带上最近两轮读写路径，不含原文", async () => {
    const r1 = await persistDecomposeRound(tmpDir, SESSION_ID, "第1轮", {
      ...decompose,
      understanding: "第1轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第1轮", r1!.index, [
      { needId: "", summary: "读了旧文件", path: "src/old.ts", startLine: 1, endLine: 4, excerpt: "secret body" },
    ]);
    await persistRoundReport(tmpDir, SESSION_ID, "第1轮", "第1轮报告", r1!.index);

    const r2 = await persistDecomposeRound(tmpDir, SESSION_ID, "第2轮", {
      ...decompose,
      understanding: "第2轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第2轮", r2!.index, [
      { needId: "", summary: "读了新文件", path: "src/new.ts", startLine: 10, endLine: 20, excerpt: "full source" },
    ]);
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第2轮", r2!.index, [
      { toolName: "write_file", path: "src/new.ts", summary: "Wrote src/new.ts (1 lines)." },
    ]);
    await persistRoundReport(tmpDir, SESSION_ID, "第2轮", "第2轮报告", r2!.index);

    const hint = formatRecentFileHints(await loadRecentRounds(tmpDir, SESSION_ID, 10));
    expect(hint).toContain("src/new.ts");
    expect(hint).toContain("L10-20");
    expect(hint).toContain("src/old.ts");
    expect(hint).not.toContain("secret body");
    expect(hint).not.toContain("full source");
  });

  it("同一轮超过 30 条不同路径的读都会保留", async () => {
    const record = await persistDecomposeRound(tmpDir, SESSION_ID, USER_INPUT, decompose);
    const items: PersistedEvidence[] = Array.from({ length: 35 }, (_, i) => ({
      needId: "",
      summary: `Read src/f${i}.ts lines 1-2`,
      path: `src/f${i}.ts`,
      startLine: 1,
      endLine: 2,
      excerpt: `Read src/f${i}.ts (lines 1-2 of 2)\nbody ${i}`,
    }));
    await persistRoundEvidence(tmpDir, SESSION_ID, USER_INPUT, record!.index, items);
    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    expect(rounds[0].evidence).toHaveLength(35);
  });

  it("文件写入摘要写入同一轮并在格式化历史中展示", async () => {
    const record = await persistDecomposeRound(tmpDir, SESSION_ID, USER_INPUT, decompose);
    const changes: PersistedFileChange[] = [
      { toolName: "write_file", path: "src/app.ts", summary: "Wrote src/app.ts (42 lines)." },
      { toolName: "apply_patch", path: "src/index.ts", summary: "Patched src/index.ts (2 replacements)." },
    ];
    await persistRoundFileChanges(tmpDir, SESSION_ID, USER_INPUT, record!.index, changes);
    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    expect(rounds[0].fileChanges).toEqual(changes);
    const block = formatRoundBlock(rounds[0], 1);
    expect(block).toContain("[file changes]");
    expect(block).toContain("write_file src/app.ts");
    expect(block).toContain("apply_patch src/index.ts");
  });
  it("任务分解历史保留工具参数，但不注入工具执行结果", async () => {
    const record = await persistDecomposeRound(tmpDir, SESSION_ID, USER_INPUT, decompose);
    await persistRoundToolCalls(tmpDir, SESSION_ID, USER_INPUT, record!.index, [
      {
        toolName: "read_file",
        arguments: { path: "src/very-large-file.ts", offset: 400, limit: 100 },
        result: "a very large tool result that must not enter the decomposition context",
      },
      {
        toolName: "grep",
        arguments: { pattern: "userService.getByPhone(query.getPhone())" },
        result: "many matching lines",
      },
    ]);

    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    const block = formatRoundBlock(rounds[0], 1);
    expect(block).toContain("- read_file");
    expect(block).toContain("- grep");
    expect(block).toContain("very-large-file.ts");
    expect(block).toContain('"offset":400');
    expect(block).toContain('"pattern":"userService.getByPhone(query.getPhone())"');
    expect(block).not.toContain("very large tool result");
    expect(block).not.toContain("userService.getByPhone");
  });
  it("落盘 assistantReport 不再按 16000 字截断", async () => {
    const longReport = `${"x".repeat(20_000)}UNIQUE_TAIL_MARKER`;
    expect(longReport.length).toBeGreaterThan(16_000);

    await persistRoundReport(tmpDir, SESSION_ID, USER_INPUT, longReport);

    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].assistantReport).toBe(longReport.trim());
    expect(rounds[0].assistantReport).toContain("UNIQUE_TAIL_MARKER");
    expect(rounds[0].assistantReport?.endsWith("…")).toBe(false);
  });

  it("无 decompose 直接写 report 不会伪造 decompose", async () => {
    await persistRoundReport(tmpDir, SESSION_ID, USER_INPUT, "只有报告");

    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].assistantReport).toBe("只有报告");
    expect(rounds[0].taskDecompose).toBeUndefined();
  });

  it("连续两轮独立存储", async () => {
    const r1 = await persistDecomposeRound(tmpDir, SESSION_ID, "第一轮请求", {
      ...decompose,
      understanding: "第一轮分解",
    });
    await persistRoundReport(tmpDir, SESSION_ID, "第一轮请求", "第一轮报告", r1!.index);

    const r2 = await persistDecomposeRound(tmpDir, SESSION_ID, "第二轮请求", {
      ...decompose,
      understanding: "第二轮分解",
    });
    await persistRoundReport(tmpDir, SESSION_ID, "第二轮请求", "第二轮报告", r2!.index);

    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].taskDecompose?.understanding).toBe("第一轮分解");
    expect(rounds[0].assistantReport).toBe("第一轮报告");
    expect(rounds[1].taskDecompose?.understanding).toBe("第二轮分解");
    expect(rounds[1].assistantReport).toBe("第二轮报告");
  });

  it("仅最近一轮与连续无报告中断后缀保留读写过程；有报告后更早轮不带", async () => {
    // 历史 newest-first 显示为 Round 1..4 = 第4..第1轮：
    // 第4、第3 无报告 → 保留 evidence/fileChanges；
    // 第2 有报告 → 不保留；第1 无报告但已越过有报告轮 → 也不保留。
    const evidence = (summary: string, path: string): PersistedEvidence[] => [
      { needId: "", summary, path, startLine: 1, endLine: 8 },
    ];
    const writes = (path: string): PersistedFileChange[] => [
      { toolName: "write_file", path, summary: `Wrote ${path} (1 lines).` },
    ];

    const r1 = await persistDecomposeRound(tmpDir, SESSION_ID, "第1轮", {
      ...decompose,
      understanding: "第1轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第1轮", r1!.index, evidence("读了第1轮文件", "src/a.ts"));
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第1轮", r1!.index, writes("src/a.ts"));

    const r2 = await persistDecomposeRound(tmpDir, SESSION_ID, "第2轮", {
      ...decompose,
      understanding: "第2轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第2轮", r2!.index, evidence("读了第2轮文件", "src/b.ts"));
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第2轮", r2!.index, writes("src/b.ts"));
    await persistRoundReport(tmpDir, SESSION_ID, "第2轮", "第2轮报告", r2!.index);

    const r3 = await persistDecomposeRound(tmpDir, SESSION_ID, "第3轮", {
      ...decompose,
      understanding: "第3轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第3轮", r3!.index, evidence("读了第3轮文件", "src/c.ts"));
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第3轮", r3!.index, writes("src/c.ts"));

    const r4 = await persistDecomposeRound(tmpDir, SESSION_ID, "第4轮", {
      ...decompose,
      understanding: "第4轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第4轮", r4!.index, evidence("读了第4轮文件", "src/d.ts"));
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第4轮", r4!.index, writes("src/d.ts"));

    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    expect(rounds).toHaveLength(4);
    const blocks = formatRoundsForDecomposeHistory(rounds);
    expect(blocks).toHaveLength(4);

    expect(blocks[0]).toContain("## Round 1");
    expect(blocks[0]).toContain("[user] 第4轮");
    expect(blocks[0]).toContain("读了第4轮文件");
    expect(blocks[0]).toContain("write_file src/d.ts");
    expect(blocks[0]).not.toContain("[assistant]");

    expect(blocks[1]).toContain("## Round 2");
    expect(blocks[1]).toContain("[user] 第3轮");
    expect(blocks[1]).toContain("读了第3轮文件");
    expect(blocks[1]).toContain("write_file src/c.ts");
    expect(blocks[1]).not.toContain("[assistant]");

    expect(blocks[2]).toContain("## Round 3");
    expect(blocks[2]).toContain("[user] 第2轮");
    expect(blocks[2]).toContain("[assistant] 第2轮报告");
    expect(blocks[2]).not.toContain("读了第2轮文件");
    expect(blocks[2]).not.toContain("write_file src/b.ts");
    expect(blocks[2]).not.toContain("[evidence]");
    expect(blocks[2]).not.toContain("[file changes]");

    expect(blocks[3]).toContain("## Round 4");
    expect(blocks[3]).toContain("[user] 第1轮");
    expect(blocks[3]).not.toContain("读了第1轮文件");
    expect(blocks[3]).not.toContain("src/a.ts");
    expect(blocks[3]).not.toContain("[file changes]");
    expect(blocks[3]).not.toContain("[evidence]");
  });

  it("最新一轮本身有报告时仍注入该轮文件探索与写文件记录，更早有报告轮不带过程信息", async () => {
    const r1 = await persistDecomposeRound(tmpDir, SESSION_ID, "旧轮", {
      ...decompose,
      understanding: "旧轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "旧轮", r1!.index, [
      { needId: "", summary: "读了旧轮文件", path: "src/old.ts", startLine: 1, endLine: 4 },
    ]);
    await persistRoundFileChanges(tmpDir, SESSION_ID, "旧轮", r1!.index, [
      { toolName: "write_file", path: "src/old.ts", summary: "Wrote src/old.ts (1 lines)." },
    ]);
    await persistRoundReport(tmpDir, SESSION_ID, "旧轮", "旧轮报告", r1!.index);

    const r2 = await persistDecomposeRound(tmpDir, SESSION_ID, "最新轮", {
      ...decompose,
      understanding: "最新轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "最新轮", r2!.index, [
      { needId: "", summary: "读了最新轮文件", path: "src/new.ts", startLine: 1, endLine: 8 },
    ]);
    await persistRoundFileChanges(tmpDir, SESSION_ID, "最新轮", r2!.index, [
      { toolName: "write_file", path: "src/new.ts", summary: "Wrote src/new.ts (1 lines)." },
    ]);
    await persistRoundReport(tmpDir, SESSION_ID, "最新轮", "最新轮报告", r2!.index);

    const blocks = formatRoundsForDecomposeHistory(await loadRecentRounds(tmpDir, SESSION_ID, 10));
    expect(blocks).toHaveLength(2);

    expect(blocks[0]).toContain("[user] 最新轮");
    expect(blocks[0]).toContain("[assistant] 最新轮报告");
    expect(blocks[0]).toContain("读了最新轮文件");
    expect(blocks[0]).toContain("write_file src/new.ts");

    expect(blocks[1]).toContain("[user] 旧轮");
    expect(blocks[1]).toContain("[assistant] 旧轮报告");
    expect(blocks[1]).not.toContain("读了旧轮文件");
    expect(blocks[1]).not.toContain("src/old.ts");
    expect(blocks[1]).not.toContain("[file changes]");
    expect(blocks[1]).not.toContain("[evidence]");
  });

  it("最近一轮保留指针级 evidence（不含原文），更早有报告轮不带过程信息", async () => {
    const evidence = (summary: string, path: string, excerpt: string): PersistedEvidence[] => [
      { needId: "", summary, path, startLine: 1, endLine: 40, excerpt },
    ];
    const writes = (path: string): PersistedFileChange[] => [
      { toolName: "write_file", path, summary: `Wrote ${path} (1 lines).` },
    ];
    const longExcerpt = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of src/full.ts`).join("\n");

    const r1 = await persistDecomposeRound(tmpDir, SESSION_ID, "第1轮", {
      ...decompose,
      understanding: "第1轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第1轮", r1!.index, evidence("读了第1轮文件", "src/a.ts", "old"));
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第1轮", r1!.index, writes("src/a.ts"));
    await persistRoundReport(tmpDir, SESSION_ID, "第1轮", "第1轮报告", r1!.index);

    const r2 = await persistDecomposeRound(tmpDir, SESSION_ID, "第2轮", {
      ...decompose,
      understanding: "第2轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第2轮", r2!.index, evidence("读了第2轮文件", "src/b.ts", "second"));
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第2轮", r2!.index, writes("src/b.ts"));
    await persistRoundReport(tmpDir, SESSION_ID, "第2轮", "第2轮报告", r2!.index);

    const r3 = await persistDecomposeRound(tmpDir, SESSION_ID, "第3轮", {
      ...decompose,
      understanding: "第3轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第3轮", r3!.index, evidence("读了第3轮文件", "src/full.ts", longExcerpt));
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第3轮", r3!.index, writes("src/full.ts"));
    await persistRoundReport(tmpDir, SESSION_ID, "第3轮", "第3轮报告", r3!.index);

    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    expect(rounds[2].evidence![0].excerpt).toBe(longExcerpt);
    const blocks = formatRoundsForDecomposeHistory(rounds);
    expect(blocks).toHaveLength(3);

    expect(blocks[0]).toContain("[user] 第3轮");
    expect(blocks[0]).toContain("读了第3轮文件");
    expect(blocks[0]).toContain("src/full.ts");
    expect(blocks[0]).not.toContain("line 40 of src/full.ts");
    expect(blocks[0]).toContain("write_file src/full.ts");

    expect(blocks[1]).toContain("[user] 第2轮");
    expect(blocks[1]).not.toContain("读了第2轮文件");
    expect(blocks[1]).not.toContain("write_file src/b.ts");
    expect(blocks[1]).not.toContain("[evidence]");
    expect(blocks[1]).not.toContain("[file changes]");

    expect(blocks[2]).toContain("[user] 第1轮");
    expect(blocks[2]).not.toContain("读了第1轮文件");
    expect(blocks[2]).not.toContain("src/a.ts");
    expect(blocks[2]).not.toContain("[file changes]");
    expect(blocks[2]).not.toContain("[evidence]");
  });
});

describe("parseDecomposeAnswer 保留 prompt 约定字段", () => {
  it("解析 informationNeeds 的 source/priority/fallback 以及步骤验证字段", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      understanding: "User wants Redis caching (act: request_change, intent: implement).",
      userConstraints: ["Must use Redis"],
      progressStatus: "New task, step 1: locate login",
      steps: [
        {
          id: "step_1",
          description: "Confirm AuthService.login and add Redis caching",
          dependsOn: [],
          informationNeeds: [
            {
              id: "need_1",
              question: "Where is AuthService.login implemented?",
              source: "file",
              priority: "blocking",
              fallback: "Assume src/auth/login.ts",
            },
          ],
          stopReadingWhen: [
            {
              condition: "login implementation located",
              requiredEvidenceIds: ["need_1"],
            },
          ],
          verificationCriteria: {
            command: "pnpm test",
            expectedOutput: "passed",
            exitCode: 0,
          },
          rollbackStrategy: "revert the Redis cache patch",
          estimatedComplexity: "medium",
        },
      ],
    }));

    expect(answer).not.toBeNull();
    expect(answer!.steps).toHaveLength(1);
    expect(answer!.steps[0].informationNeeds).toEqual([
      {
        id: "need_1",
        question: "Where is AuthService.login implemented?",
        source: "file",
        priority: "blocking",
        fallback: "Assume src/auth/login.ts",
      },
    ]);
    expect(answer!.steps[0].verificationCriteria).toEqual({
      command: "pnpm test",
      expectedOutput: "passed",
      exitCode: 0,
    });
    expect(answer!.steps[0].rollbackStrategy).toBe("revert the Redis cache patch");
    expect(answer!.steps[0].estimatedComplexity).toBe("medium");
  });

  it("非法枚举降级为缺省，不阻断整份分解", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      understanding: "Continue.",
      userConstraints: [],
      steps: [
        {
          id: "step_1",
          description: "Inspect current login path",
          dependsOn: [],
          informationNeeds: [
            {
              id: "need_1",
              question: "What is the current cache?",
              source: "database",
              priority: "urgent",
              fallback: "   ",
            },
          ],
          stopReadingWhen: [],
          verificationCriteria: { command: "", expectedOutput: "ok" },
          estimatedComplexity: "extreme",
        },
      ],
    }));

    expect(answer).not.toBeNull();
    expect(answer!.steps[0].informationNeeds[0]).toEqual({
      id: "need_1",
      question: "What is the current cache?",
      source: undefined,
      priority: undefined,
      fallback: undefined,
    });
    expect(answer!.steps[0].verificationCriteria).toBeUndefined();
    expect(answer!.steps[0].estimatedComplexity).toBeUndefined();
  });

  it("sanitize 持久化后仍保留 source/priority/fallback 与验证字段", async () => {
    const record = await persistDecomposeRound(tmpDir, "parse-fields-session", "加 Redis 缓存", {
      understanding: "用户希望登录页更快",
      userConstraints: ["必须使用 Redis"],
      steps: [
        {
          id: "step_1",
          description: "接入 Redis 缓存",
          dependsOn: [],
          informationNeeds: [
            {
              id: "need_1",
              question: "AuthService.login 在哪实现？",
              source: "file",
              priority: "blocking",
              fallback: "假设在 src/auth/login.ts",
            },
          ],
          stopReadingWhen: [
            { condition: "已定位 login 实现", requiredEvidenceIds: ["need_1"] },
          ],
          verificationCriteria: {
            command: "pnpm test",
            expectedOutput: "passed",
            exitCode: 0,
          },
          rollbackStrategy: "回滚 Redis 补丁",
          estimatedComplexity: "medium",
        },
      ],
    });

    expect(record).not.toBeNull();
    expect(record!.taskDecompose?.steps[0].informationNeeds[0]).toEqual({
      id: "need_1",
      question: "AuthService.login 在哪实现？",
      source: "file",
      priority: "blocking",
      fallback: "假设在 src/auth/login.ts",
    });
    expect(record!.taskDecompose?.steps[0].verificationCriteria).toEqual({
      command: "pnpm test",
      expectedOutput: "passed",
      exitCode: 0,
    });
    expect(record!.taskDecompose?.steps[0].rollbackStrategy).toBe("回滚 Redis 补丁");
    expect(record!.taskDecompose?.steps[0].estimatedComplexity).toBe("medium");
  });
});

describe("relevantHistory 为可承载全部相关历史的字符串", () => {
  it("解析步骤级与整单 string relevantHistory", () => {
    const historyText = [
      "### src/auth/login.ts L1-40",
      "note: 上一轮已读，直接复用",
      "export class AuthService {}",
      "",
      "先前结论：登录慢是因为每次都打 DB。",
    ].join("\n");
    const answer = parseDecomposeAnswer(JSON.stringify({
      understanding: "Continue Redis caching.",
      userConstraints: [],
      steps: [
        {
          id: "step_1",
          description: "Add Redis caching",
          dependsOn: [],
          informationNeeds: [],
          stopReadingWhen: [],
          relevantHistory: historyText,
        },
      ],
      relevantHistory: historyText,
    }));

    expect(answer).not.toBeNull();
    expect(typeof answer!.relevantHistory).toBe("string");
    expect(answer!.relevantHistory).toBe(historyText);
    expect(answer!.steps[0].relevantHistory).toBe(historyText);
  });

  it("兼容旧 { files } 对象并转成同等文本", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      understanding: "Continue.",
      userConstraints: [],
      steps: [
        {
          id: "step_1",
          description: "Reuse prior login.ts read",
          dependsOn: [],
          informationNeeds: [],
          stopReadingWhen: [],
          relevantHistory: {
            files: [
              {
                path: "src/auth/login.ts",
                content: "export class AuthService {}",
                startLine: 1,
                endLine: 40,
                note: "Already read",
              },
            ],
          },
        },
      ],
      relevantHistory: {
        files: [
          {
            path: "src/auth/login.ts",
            content: "export class AuthService {}",
            startLine: 1,
            endLine: 40,
            note: "Already read",
          },
        ],
      },
    }));

    expect(answer).not.toBeNull();
    expect(typeof answer!.relevantHistory).toBe("string");
    expect(answer!.relevantHistory).toContain("### src/auth/login.ts L1-40");
    expect(answer!.relevantHistory).toContain("export class AuthService {}");
    expect(answer!.steps[0].relevantHistory).toBe(answer!.relevantHistory);
  });

  it("步骤缺省时透传整单 relevantHistory", () => {
    const shared = "先前结论：只改登录页。\n约束：必须用 Redis。";
    const answer = parseDecomposeAnswer(JSON.stringify({
      understanding: "Continue.",
      userConstraints: [],
      steps: [
        {
          id: "step_1",
          description: "Add Redis caching",
          dependsOn: [],
          informationNeeds: [],
          stopReadingWhen: [],
        },
        {
          id: "step_2",
          description: "Verify login latency",
          dependsOn: ["step_1"],
          informationNeeds: [],
          stopReadingWhen: [],
          relevantHistory: "step-local notes",
        },
      ],
      relevantHistory: shared,
    }));

    expect(answer).not.toBeNull();
    expect(answer!.steps[0].relevantHistory).toBeUndefined();
    expect(answer!.steps[1].relevantHistory).toBe("step-local notes");
    expect(answer!.relevantHistory).toBe(shared);
  });

  it("fallback 打包已读文件与非文件对话要点", () => {
    const excerptBody = [
      "[lines 1-3 of 3]",
      "   1|export class AuthService {}",
    ].join("\n");
    const packed = packFallbackRelevantHistory({
      userMessage: "登录页太慢，给 login 加 Redis 缓存",
      history: [
        { role: "user", content: "登录页太慢，加 Redis 缓存" },
        {
          role: "tool",
          toolName: "read_file",
          content: `Read src/auth/login.ts (lines 1-3 of 3)\n${excerptBody}`,
        },
        { role: "assistant", content: "已确认 login 每次打 DB，准备加缓存。" },
        { role: "user", content: "继续" },
      ],
    });

    expect(packed).toBeDefined();
    expect(typeof packed).toBe("string");
    expect(packed).toContain("src/auth/login.ts");
    expect(packed).toContain("export class AuthService {}");
    expect(packed).toContain("## 近期对话要点");
    expect(packed).toContain("登录页太慢，加 Redis 缓存");
    expect(packed).toContain("已确认 login 每次打 DB");
  });

  it("fallback 按相关度排序并丢弃 <60% 的块", () => {
    const packed = packFallbackRelevantHistory({
      userMessage: "修复 auth login Redis 缓存",
      history: [
        { role: "user", content: "给 auth login 加 Redis 缓存" },
        {
          role: "tool",
          toolName: "read_file",
          content: [
            "Read src/auth/login.ts (lines 1-2 of 2)",
            "[lines 1-2 of 2]",
            "   1|export class AuthService {}",
            "   2|// redis cache",
          ].join("\n"),
        },
        { role: "assistant", content: "auth login 将使用 Redis 缓存。" },
        { role: "user", content: "顺便看看天气 UI 配色" },
        {
          role: "tool",
          toolName: "read_file",
          content: [
            "Read src/ui/weather-theme.css (lines 1-2 of 2)",
            "[lines 1-2 of 2]",
            "   1|body { color: blue }",
            "   2|/* theme only */",
          ].join("\n"),
        },
        { role: "assistant", content: "天气主题配色已调整为蓝色。" },
        { role: "user", content: "继续修 login 缓存" },
      ],
    });

    expect(packed).toBeDefined();
    expect(packed).toContain("src/auth/login.ts");
    expect(packed).toContain("Redis");
    // 与 login/redis 无关的天气主题应被 <0.6 过滤掉
    expect(packed).not.toContain("weather-theme.css");
    expect(packed).not.toContain("天气主题配色");
  });
});

describe("相关度排序与阈值", () => {
  it("rankAndFilterByRelevance 降序并丢弃 < threshold", () => {
    const ranked = rankAndFilterByRelevance(
      [
        { id: "a", score: 0.55 },
        { id: "b", score: 0.9 },
        { id: "c", score: 0.6 },
        { id: "d", score: 0.2 },
      ],
      RELEVANT_HISTORY_SCORE_THRESHOLD,
    );
    expect(ranked.map((x) => x.id)).toEqual(["b", "c"]);
  });

  it("estimateTextRelevance 对高重叠文本给出高分", () => {
    expect(estimateTextRelevance("auth login redis", "auth login redis cache")).toBeGreaterThanOrEqual(0.6);
    expect(estimateTextRelevance("auth login redis", "weather theme color blue")).toBeLessThan(0.6);
  });
});

describe("当前代码/当前步骤行为询问不得空 steps", () => {
  const originalQuestion = "现在任务分解这一步，历史信息是如何处理的？";

  it("识别原问法为当前实现行为询问，而不是纯讨论", () => {
    expect(isCurrentCodeBehaviorInquiry(originalQuestion)).toBe(true);
    expect(isCurrentCodeBehaviorInquiry("这段代码是如何处理超时的？")).toBe(true);
    expect(isCurrentCodeBehaviorInquiry("How does the current task decompose step handle history?")).toBe(true);
    expect(isCurrentCodeBehaviorInquiry("进度怎么样了？")).toBe(false);
    expect(isCurrentCodeBehaviorInquiry("先别改，我们讨论一下方案")).toBe(false);
  });

  it("模型把原问法判成 inquire/discuss 并清空 steps 时，补回定位阅读步骤", () => {
    const misclassified = parseDecomposeAnswer(JSON.stringify({
      understanding: "用户在询问当前任务分解阶段如何处理历史信息（对话行为：inquire；意图：discuss）。此轮目标是解释历史信息的继承、筛选和复用规则，不进行代码修改或任务规划。",
      userConstraints: [],
      steps: [],
      progressStatus: "无需执行步骤；当前仅解释历史信息处理机制。",
      relevantHistory: "历史信息按优先级使用：当前用户消息最高。",
    }));

    expect(misclassified).not.toBeNull();
    const recovered = recoverEmptyDecomposeSteps(misclassified!, originalQuestion);
    expect(recovered.steps.length).toBeGreaterThan(0);
    expect(recovered.steps[0].description).toMatch(/定位|阅读|实现|历史信息/);
    expect(recovered.steps[0].informationNeeds[0]?.question).toContain("历史信息");
    expect(recovered.steps[0].informationNeeds[0]?.source).toBe("search");
    expect(recovered.progressStatus).toMatch(/定位并阅读/);
  });

  it("真正的进度询问仍保持空 steps", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      understanding: "用户在问进度（act: query_progress, intent: query_progress）。",
      userConstraints: [],
      steps: [],
      progressStatus: "无需执行步骤。",
    }));
    expect(answer).not.toBeNull();
    const recovered = recoverEmptyDecomposeSteps(answer!, "现在做到哪一步了？");
    expect(recovered.steps).toHaveLength(0);
  });
});

describe("分解历史：最近5轮 + 按用户输入向量召回（同容器不截断）", () => {
  const SESSION_ID = "sess-vector-recall";
  const budgets = contextBudgets(BUILTIN_WORKFLOW);

  function makeChunk(partial: Partial<HistoryChunk> & Pick<HistoryChunk, "content" | "turnIndex" | "role">): HistoryChunk {
    return {
      id: partial.id ?? `id-${partial.turnIndex}`,
      turnId: partial.turnId ?? `turn-${partial.turnIndex}`,
      sessionId: partial.sessionId ?? SESSION_ID,
      role: partial.role,
      content: partial.content,
      contentHash: partial.contentHash ?? `hash-${partial.turnIndex}`,
      createdAt: partial.createdAt ?? new Date().toISOString(),
      turnIndex: partial.turnIndex,
    };
  }

  function makeOpts(overrides: Partial<AgentLoopOpts> = {}): AgentLoopOpts {
    return {
      mode: "agent",
      workspaceRoot: tmpDir,
      sessionId: SESSION_ID,
      workflow: BUILTIN_WORKFLOW,
      index: {} as AgentLoopOpts["index"],
      history: [],
      userMessage: "继续接入向量召回",
      ...overrides,
    };
  }

  it("formatRecalledHistoryChunks 整段保留，不截断", () => {
    const long = "A".repeat(1200);
    const text = formatRecalledHistoryChunks([
      { turnIndex: 3, role: "user", content: long },
      { turnIndex: 1, role: "assistant", content: "完整助手回复" },
    ]);
    expect(text).toContain(long);
    expect(text).toContain("完整助手回复");
    expect(text).toContain("[turnIndex=3]");
    expect(text).not.toContain("…(截断)");
  });

  it("无 historyVector 时召回为空", async () => {
    const recalled = await recallHistoryByUserInput({
      userMessage: "任意输入",
      sessionId: SESSION_ID,
    });
    expect(recalled).toEqual([]);
  });

  it("有 historyVector 时按当前用户输入 embed + search，并按相关度排序过滤", async () => {
    const query = "按用户输入做向量召回";
    const embedCalls: string[] = [];
    const searchCalls: Array<{ topK: number; sessionId: string | null | undefined }> = [];
    const recalledChunks = [
      { ...makeChunk({ turnIndex: 9, role: "user", content: "更早相关：向量召回接线讨论" }), score: 0.82 },
      { ...makeChunk({ turnIndex: 2, role: "assistant", content: "更早相关：已确认同容器不截断" }), score: 0.91 },
      { ...makeChunk({ turnIndex: 1, role: "user", content: "无关闲聊" }), score: 0.3 },
    ];

    const recalled = await recallHistoryByUserInput({
      userMessage: query,
      sessionId: SESSION_ID,
      historyVector: {
        embedding: {
          async embed(text: string) {
            embedCalls.push(text);
            return new Float32Array([0.1, 0.2, 0.3]);
          },
        },
        store: {
          archive() {},
          hasContentHash() {
            return false;
          },
          search(queryVector, topK, sessionId) {
            expect(queryVector).toBeInstanceOf(Float32Array);
            searchCalls.push({ topK, sessionId });
            return recalledChunks;
          },
          countBySession() {
            return recalledChunks.length;
          },
        },
      },
    });

    expect(embedCalls).toEqual([query]);
    expect(searchCalls).toEqual([{ topK: 5, sessionId: SESSION_ID }]);
    // score 降序，且 <0.6 丢弃
    expect(recalled).toEqual([
      { turnIndex: 2, role: "assistant", content: "更早相关：已确认同容器不截断", score: 0.91 },
      { turnIndex: 9, role: "user", content: "更早相关：向量召回接线讨论", score: 0.82 },
    ]);
  });

  it("向量召回返回索引中的完整 llmReport，不二次截断", async () => {
    const longReport = `${"分析结果。".repeat(900)}UNIQUE_TAIL_MARKER`;
    expect(longReport.length).toBeGreaterThan(4_000);
    const archived = JSON.stringify({
      userInput: "请分析 src/",
      taskDecomposition: { goal: "分析模块结构" },
      llmReport: longReport,
      evidence: [],
      toolCalls: [],
    });

    const recalled = await recallHistoryByUserInput({
      userMessage: "召回完整报告",
      sessionId: SESSION_ID,
      historyVector: {
        embedding: {
          async embed() {
            return new Float32Array([0.1]);
          },
        },
        store: {
          archive() {},
          hasContentHash() {
            return false;
          },
          search() {
            return [{
              ...makeChunk({ turnIndex: 4, role: "assistant", content: archived }),
              score: 0.88,
            }];
          },
          countBySession() {
            return 1;
          },
        },
      },
    });

    expect(recalled).toHaveLength(1);
    expect(recalled[0].content).toBe(archived);
    expect(recalled[0].content).toContain(longReport);
    expect(recalled[0].content).toContain("UNIQUE_TAIL_MARKER");
    expect(formatRecalledHistoryChunks(recalled)).toContain(longReport);
  });

  it("向量召回先丢 <0.6，再对剩余高相似只留最近一轮", async () => {
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

    const recalled = await recallHistoryByUserInput({
      userMessage: "召回分析模块",
      sessionId: SESSION_ID,
      historyVector: {
        embedding: {
          async embed() {
            return new Float32Array([0.1]);
          },
        },
        store: {
          archive() {},
          hasContentHash() {
            return false;
          },
          search() {
            return [
              { ...makeChunk({ turnIndex: 2, role: "assistant", content: older }), score: 0.95 },
              { ...makeChunk({ turnIndex: 3, role: "assistant", content: noise }), score: 0.41 },
              { ...makeChunk({ turnIndex: 4, role: "assistant", content: other }), score: 0.88 },
              { ...makeChunk({ turnIndex: 8, role: "assistant", content: newerLowScore }), score: 0.4 },
              { ...makeChunk({ turnIndex: 9, role: "assistant", content: newer }), score: 0.81 },
            ];
          },
          countBySession() {
            return 5;
          },
        },
      },
    });

    expect(recalled.map((item) => item.turnIndex)).toEqual([4, 9]);
    expect(recalled[1].content).toBe(newer);
    expect(recalled[1].content).toContain(longReport);
    expect(recalled[1].content).toContain("NEWER_ROUND_MARKER");
    expect(recalled[0].content).toContain(otherReport);
    expect(recalled.some((item) => item.content.includes("OLDER_ROUND_MARKER"))).toBe(false);
    expect(recalled.some((item) => item.content.includes("LOW_SCORE_NEAR_DUP_MARKER"))).toBe(false);
    expect(recalled.some((item) => item.content.includes("NOISE_MARKER"))).toBe(false);
    expect(formatRecalledHistoryChunks(recalled)).toContain(longReport);
  });

  it("向量召回低分近重复先丢掉，不能挤掉高分旧轮", async () => {
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

    const recalled = await recallHistoryByUserInput({
      userMessage: "召回分析模块",
      sessionId: SESSION_ID,
      historyVector: {
        embedding: {
          async embed() {
            return new Float32Array([0.1]);
          },
        },
        store: {
          archive() {},
          hasContentHash() {
            return false;
          },
          search() {
            return [
              { ...makeChunk({ turnIndex: 2, role: "assistant", content: older }), score: 0.95 },
              { ...makeChunk({ turnIndex: 9, role: "assistant", content: newerLowScore }), score: 0.4 },
            ];
          },
          countBySession() {
            return 2;
          },
        },
      },
    });

    expect(recalled).toHaveLength(1);
    expect(recalled[0].turnIndex).toBe(2);
    expect(recalled[0].content).toContain("KEEP_OLD_MARKER");
    expect(recalled[0].content).toContain(longReport);
    expect(recalled[0].content).not.toContain("DROP_LOW_SCORE_MARKER");
  });

  it("向量召回高相似只留最近一轮，低相似都保留且正文不裁", async () => {
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

    const recalled = await recallHistoryByUserInput({
      userMessage: "召回分析模块",
      sessionId: SESSION_ID,
      historyVector: {
        embedding: {
          async embed() {
            return new Float32Array([0.1]);
          },
        },
        store: {
          archive() {},
          hasContentHash() {
            return false;
          },
          search() {
            return [
              { ...makeChunk({ turnIndex: 2, role: "assistant", content: older }), score: 0.95 },
              { ...makeChunk({ turnIndex: 4, role: "assistant", content: other }), score: 0.88 },
              { ...makeChunk({ turnIndex: 9, role: "assistant", content: newer }), score: 0.81 },
            ];
          },
          countBySession() {
            return 3;
          },
        },
      },
    });

    expect(recalled.map((item) => item.turnIndex)).toEqual([4, 9]);
    expect(recalled[1].content).toBe(newer);
    expect(recalled[1].content).toContain(longReport);
    expect(recalled[1].content).toContain("NEWER_ROUND_MARKER");
    expect(recalled[0].content).toContain(otherReport);
    expect(recalled.some((item) => item.content.includes("OLDER_ROUND_MARKER"))).toBe(false);
    expect(formatRecalledHistoryChunks(recalled)).toContain(longReport);
    expect(formatRecalledHistoryChunks(recalled)).not.toContain("OLDER_ROUND_MARKER");
  });

  it("buildDecomposeContext：无注入时仅最近轮，不含召回段", async () => {
    const userInput = "上一轮用户输入";
    await persistDecomposeRound(tmpDir, SESSION_ID, userInput, {
      understanding: "最近一轮理解",
      userConstraints: [],
      steps: [{ id: "s1", description: "做点事", dependsOn: [], informationNeeds: [], stopReadingWhen: [] }],
    });
    await persistRoundReport(tmpDir, SESSION_ID, userInput, "最近一轮报告");

    const ctx = await buildDecomposeContext(makeOpts({ historyVector: undefined }), budgets);
    expect(ctx).toContain("Recent conversation rounds");
    expect(ctx).toContain("最近一轮理解");
    expect(ctx).not.toContain("Vector-recalled history");
  });

  it("buildDecomposeContext：有 historyVector 时同容器含最近轮 + 召回，且不截断", async () => {
    const userInput = "上一轮用户输入-完整保留";
    await persistDecomposeRound(tmpDir, SESSION_ID, userInput, {
      understanding: "最近一轮理解-完整保留",
      userConstraints: [],
      steps: [{ id: "s1", description: "接线召回", dependsOn: [], informationNeeds: [], stopReadingWhen: [] }],
    });
    await persistRoundReport(tmpDir, SESSION_ID, userInput, "最近一轮完整报告");

    const longRecalled = `召回全文-${"B".repeat(900)}`;
    const ctx = await buildDecomposeContext(
      makeOpts({
        userMessage: "把向量召回加进任务分解历史拼装",
        historyVector: {
          embedding: {
            async embed() {
              return new Float32Array([1, 0, 0]);
            },
          },
          store: {
            archive() {},
            hasContentHash() {
              return false;
            },
            search() {
              return [
                {
                  ...makeChunk({
                    turnIndex: 4,
                    role: "user",
                    content: longRecalled,
                  }),
                  score: 0.88,
                },
              ];
            },
            countBySession() {
              return 1;
            },
          },
        },
      }),
      budgets,
    );

    expect(ctx).toContain("<conversation_history>");
    expect(ctx).toContain("Recent conversation rounds");
    expect(ctx).toContain("最近一轮理解-完整保留");
    expect(ctx).toContain("Vector-recalled history");
    expect(ctx).toContain(longRecalled);
    expect(ctx).not.toContain("…(截断)");
    // 同一 conversation_history 容器内同时出现最近轮与召回
    const historyBlock = ctx.match(/<conversation_history>[\s\S]*?<\/conversation_history>/)?.[0] ?? "";
    expect(historyBlock).toContain("Recent conversation rounds");
    expect(historyBlock).toContain("Vector-recalled history");
    expect(historyBlock).toContain(longRecalled);
  });
});
