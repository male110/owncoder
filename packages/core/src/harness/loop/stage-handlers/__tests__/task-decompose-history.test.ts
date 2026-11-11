import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { closeConversationStore } from "../../../../conversation-store.ts";
import { tmpdir } from "node:os";
import {
  loadRecentRounds,
  loadDecomposeHistory,

  deleteDecomposeRound,
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
  type PersistedDecompose,
} from "../../../../turn-rounds.ts";
import type { AgentLoopOpts, ChatTurn } from "../../types.ts";

// extractStructuredHistory 已从 task-decompose.ts 导出
import {
  extractStructuredHistory,
  parseDecomposeAnswer,
  buildFallbackRawDecompose,
  isCurrentCodeBehaviorInquiry,
  isPreciseLocatedRequest,
  recoverEmptyDecomposeTasks,
  collapsePseudoLinearTasks,
  buildDecomposeContext,
  rankAndFilterByRelevance,
  estimateTextRelevance,
  RELEVANT_HISTORY_SCORE_THRESHOLD,
} from "../task-decompose.ts";
import { BUILTIN_WORKFLOW, BUILTIN_TASK_DECOMPOSE_PROMPT } from "@owncoder/settings";
import { contextBudgets } from "../../../budget.ts";

// ── 临时目录 ──
let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), "rounds-test-"));
});
afterEach(async () => {
  // 历史回退会打开 SQLite；Windows 删除临时目录前必须释放句柄。
  const sessionsDir = join(tmpDir, ".owncoder", "sessions");
  const files = await fs.readdir(sessionsDir).catch(() => [] as string[]);
  for (const file of files) {
    if (file.endsWith(".conversation.sqlite")) {
      closeConversationStore(tmpDir, basename(file, ".conversation.sqlite"));
    }
  }
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

  it("tool/toolName 标记与 assistant 保留在 transcript，工具输出不注入", () => {
    const history: ChatTurn[] = [
      mkTurn("user", "查找问题"),
      mkTurn("tool", "文件内容 ABC", { toolName: "read_file" }),
      mkTurn("assistant", "找到问题：ABC"),
    ];
    const rounds = extractStructuredHistory(history, 5, false);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].transcript).toContain("[tool:read_file]");
    expect(rounds[0].transcript).toContain("[assistant] 找到问题：ABC");
    // 工具输出是执行细节，只保留活动标记，不复制进分解上下文
    expect(rounds[0].transcript).not.toContain("文件内容 ABC");
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

  it("decompose JSON 保留完整结构，不只是 intent", () => {
    const decomposeObj = {
      intent: "理解用户需求",
      userConstraints: ["不能修改配置"],
      relevantHistory: "上次结论：登录用 AuthService",
      tasks: [{ id: "task_1", description: "任务1", prompt: "步骤1" }],
    };
    const history: ChatTurn[] = [
      mkTurn("user", "分析需求"),
      mkTurn("assistant", JSON.stringify(decomposeObj)),
    ];
    const rounds = extractStructuredHistory(history, 5, false);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].taskDecompose).toBeDefined();
    const parsed = JSON.parse(rounds[0].taskDecompose!);
    expect(parsed.intent).toBe("理解用户需求");
    expect(parsed.userConstraints).toEqual(["不能修改配置"]);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].prompt).toBe("步骤1");
    expect(parsed.relevantHistory).toBe("上次结论：登录用 AuthService");
  });

  it("fenced JSON 也可识别为 decompose", () => {
    const decomposeObj = {
      intent: "fenced 解析",
      tasks: [{ id: "task_1", description: "任务", prompt: "步骤" }],
    };
    const history: ChatTurn[] = [
      mkTurn("user", "请求"),
      mkTurn("assistant", `结果：\n\`\`\`json\n${JSON.stringify(decomposeObj)}\n\`\`\``),
    ];
    const rounds = extractStructuredHistory(history, 5, false);
    expect(rounds).toHaveLength(1);
    const parsed = JSON.parse(rounds[0].taskDecompose!);
    expect(parsed.intent).toBe("fenced 解析");
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

  it("jsonrepair 可修复的旧格式 JSON 仍然识别为 decompose（兼容）", () => {
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
    intent: "用户需要了解代码库结构",
    userConstraints: ["只看 TypeScript 文件"],
    tasks: [
      {
        id: "task_1",
        executionGuidance: "分析代码库结构",
      },
    ],
  };

  it("decompose 持久化后 report 更新同一轮，不新建", async () => {
    const record = await persistDecomposeRound(tmpDir, SESSION_ID, USER_INPUT, decompose);
    expect(record).not.toBeNull();
    expect(record!.taskDecompose?.intent).toBe("用户需要了解代码库结构");
    expect(record!.taskDecompose?.userConstraints).toEqual(["只看 TypeScript 文件"]);
    expect(record!.taskDecompose?.tasks).toHaveLength(1);

    const reportRecord = await persistRoundReport(
      tmpDir, SESSION_ID, USER_INPUT, "分析结果：src/ 包含 5 个模块", record!.index,
    );
    expect(reportRecord).not.toBeNull();
    expect(reportRecord!.index).toBe(record!.index);
    expect(reportRecord!.taskDecompose?.intent).toBe("用户需要了解代码库结构");
    expect(reportRecord!.assistantReport).toBe("分析结果：src/ 包含 5 个模块");

    // 再次读取确认只有一个 round
    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].taskDecompose?.intent).toBe("用户需要了解代码库结构");
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
    expect(rounds[0].taskDecompose?.intent).toBe("用户需要了解代码库结构");
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
      intent: "第1轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第1轮", r1!.index, [
      { needId: "", summary: "读了旧文件", path: "src/old.ts", startLine: 1, endLine: 4, excerpt: "secret body" },
    ]);
    await persistRoundReport(tmpDir, SESSION_ID, "第1轮", "第1轮报告", r1!.index);

    const r2 = await persistDecomposeRound(tmpDir, SESSION_ID, "第2轮", {
      ...decompose,
      intent: "第2轮分解",
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
        arguments: { file_path: "src/very-large-file.ts", offset: 400, limit: 100 },
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
    // 工具执行结果不注入（参数保留，结果丢弃）
    expect(block).not.toContain("very large tool result");
    expect(block).not.toContain("many matching lines");
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
      intent: "第一轮分解",
    });
    await persistRoundReport(tmpDir, SESSION_ID, "第一轮请求", "第一轮报告", r1!.index);

    const r2 = await persistDecomposeRound(tmpDir, SESSION_ID, "第二轮请求", {
      ...decompose,
      intent: "第二轮分解",
    });
    await persistRoundReport(tmpDir, SESSION_ID, "第二轮请求", "第二轮报告", r2!.index);

    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].taskDecompose?.intent).toBe("第一轮分解");
    expect(rounds[0].assistantReport).toBe("第一轮报告");
    expect(rounds[1].taskDecompose?.intent).toBe("第二轮分解");
    expect(rounds[1].assistantReport).toBe("第二轮报告");
  });

  it("仅最近一轮与连续无报告中断后缀保留读写过程；有报告后更早轮不带", async () => {
    // 历史 newest-first 显示为 Round 4..1 = 第4..第1轮：
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
      intent: "第1轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第1轮", r1!.index, evidence("读了第1轮文件", "src/a.ts"));
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第1轮", r1!.index, writes("src/a.ts"));

    const r2 = await persistDecomposeRound(tmpDir, SESSION_ID, "第2轮", {
      ...decompose,
      intent: "第2轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第2轮", r2!.index, evidence("读了第2轮文件", "src/b.ts"));
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第2轮", r2!.index, writes("src/b.ts"));
    await persistRoundReport(tmpDir, SESSION_ID, "第2轮", "第2轮报告", r2!.index);

    const r3 = await persistDecomposeRound(tmpDir, SESSION_ID, "第3轮", {
      ...decompose,
      intent: "第3轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第3轮", r3!.index, evidence("读了第3轮文件", "src/c.ts"));
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第3轮", r3!.index, writes("src/c.ts"));

    const r4 = await persistDecomposeRound(tmpDir, SESSION_ID, "第4轮", {
      ...decompose,
      intent: "第4轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第4轮", r4!.index, evidence("读了第4轮文件", "src/d.ts"));
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第4轮", r4!.index, writes("src/d.ts"));

    const rounds = await loadRecentRounds(tmpDir, SESSION_ID, 10);
    expect(rounds).toHaveLength(4);
    const blocks = formatRoundsForDecomposeHistory(rounds);
    expect(blocks).toHaveLength(4);

    expect(blocks.map((block) => block.match(/^## Round (\d+)/)?.[1])).toEqual(["4", "3", "2", "1"]);
    expect(blocks[0]).toContain("## Round 4");
    expect(blocks[0]).toContain("[user] 第4轮");
    expect(blocks[0]).toContain("读了第4轮文件");
    expect(blocks[0]).toContain("write_file src/d.ts");
    expect(blocks[0]).not.toContain("[assistant]");

    expect(blocks[1]).toContain("## Round 3");
    expect(blocks[1]).toContain("[user] 第3轮");
    expect(blocks[1]).toContain("读了第3轮文件");
    expect(blocks[1]).toContain("write_file src/c.ts");
    expect(blocks[1]).not.toContain("[assistant]");

    expect(blocks[2]).toContain("## Round 2");
    expect(blocks[2]).toContain("[user] 第2轮");
    expect(blocks[2]).toContain("[assistant] 第2轮报告");
    expect(blocks[2]).not.toContain("读了第2轮文件");
    expect(blocks[2]).not.toContain("write_file src/b.ts");
    expect(blocks[2]).not.toContain("[evidence]");
    expect(blocks[2]).not.toContain("[file changes]");

    expect(blocks[3]).toContain("## Round 1");
    expect(blocks[3]).toContain("[user] 第1轮");
    expect(blocks[3]).not.toContain("读了第1轮文件");
    expect(blocks[3]).not.toContain("src/a.ts");
    expect(blocks[3]).not.toContain("[file changes]");
    expect(blocks[3]).not.toContain("[evidence]");
  });

  it("最新一轮本身有报告时仍注入该轮文件探索与写文件记录，更早有报告轮不带过程信息", async () => {
    const r1 = await persistDecomposeRound(tmpDir, SESSION_ID, "旧轮", {
      ...decompose,
      intent: "旧轮分解",
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
      intent: "最新轮分解",
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
      intent: "第1轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第1轮", r1!.index, evidence("读了第1轮文件", "src/a.ts", "old"));
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第1轮", r1!.index, writes("src/a.ts"));
    await persistRoundReport(tmpDir, SESSION_ID, "第1轮", "第1轮报告", r1!.index);

    const r2 = await persistDecomposeRound(tmpDir, SESSION_ID, "第2轮", {
      ...decompose,
      intent: "第2轮分解",
    });
    await persistRoundEvidence(tmpDir, SESSION_ID, "第2轮", r2!.index, evidence("读了第2轮文件", "src/b.ts", "second"));
    await persistRoundFileChanges(tmpDir, SESSION_ID, "第2轮", r2!.index, writes("src/b.ts"));
    await persistRoundReport(tmpDir, SESSION_ID, "第2轮", "第2轮报告", r2!.index);

    const r3 = await persistDecomposeRound(tmpDir, SESSION_ID, "第3轮", {
      ...decompose,
      intent: "第3轮分解",
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

describe("parseDecomposeAnswer / fallback：intent 用原话，纯文本收成 task", () => {
  it("可从 Markdown 围栏中提取 JSON", () => {
    const answer = parseDecomposeAnswer([
      "下面是分解结果：",
      "```json",
      JSON.stringify({
        intent: "定位登录实现",
        userConstraints: [],
        relevantHistory: "登录由 AuthService 负责",
        nodes: [{
          id: "n1",
          title: "阅读登录实现",
          description: "阅读 AuthService",
          prompt: "定位 AuthService.login 后阅读相关代码",
          dependsOn: [],
        }],
      }),
      "```",
    ].join("\n"));

    expect(answer).not.toBeNull();
    expect(answer!.intent).toBe("定位登录实现");
    expect(answer!.tasks[0].executionGuidance).toContain("AuthService.login");
    expect(answer!.relevantHistory).toBe("登录由 AuthService 负责");
  });

  it("纯散文无 JSON 时返回 null，不把原文当结构化结果", () => {
    expect(parseDecomposeAnswer("用户想了解历史信息如何处理，下面直接解释……")).toBeNull();
  });

  it("fallback：intent 用用户原话，模型纯文本收成单一 task", () => {
    const userMessage = "现在任务分解这一步，历史信息是如何处理的？";
    const modelProse = "当然可以。任务分解阶段会读取最近对话，并按相关度筛选……这是一整段自然语言回答。";
    const fallback = buildFallbackRawDecompose(userMessage, modelProse);
    expect(fallback.intent).toBe(userMessage);
    expect(fallback.intent).not.toContain("当然可以");
    expect(fallback.tasks).toHaveLength(1);
    expect(fallback.tasks[0].executionGuidance).toContain(modelProse);
    expect(fallback.tasks[0].executionGuidance).toMatch(/Execute the model reply above directly/);
  });

  it("fallback 无模型纯文本时仍用用户原话与启发式指引生成单一节点", () => {
    const userMessage = "现在任务分解这一步，历史信息是如何处理的？";
    const fallback = buildFallbackRawDecompose(userMessage);
    expect(fallback.intent).toBe(userMessage);
    expect(fallback.tasks[0].executionGuidance).toContain(userMessage);
    expect(fallback.tasks[0].executionGuidance).toMatch(/Local heuristic plan/);
  });
});

describe("parseDecomposeAnswer 保留 executionGuidance 约定字段", () => {
  it("解析执行指引与相关历史；忽略旧 step 级字段", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "用户希望给登录加 Redis 缓存。",
      userConstraints: ["必须使用 Redis"],
      tasks: [{
        id: "task_1",
        executionGuidance: "先确认 AuthService.login 现状，再加缓存并自测",
        relevantHistory: "上次讨论：缓存 key 用 sessionId",
        // 旧 step 形状：描述应折叠进 executionGuidance，其余字段忽略。
        steps: [{
          id: "step_1",
          description: "确认 AuthService.login 并加缓存",
          dependsOn: [],
          verificationCriteria: { command: "pnpm test", expectedOutput: "passed", exitCode: 0 },
          rollbackStrategy: "回滚 Redis 补丁",
          estimatedComplexity: "medium",
        }],
      }],
    }));

    expect(answer).not.toBeNull();
    expect(answer!.userConstraints).toEqual(["必须使用 Redis"]);
    const task = answer!.tasks[0]!;
    expect(task.executionGuidance).toContain("先确认 AuthService.login");
    expect(task.executionGuidance).toContain("确认 AuthService.login");
    expect(task).not.toHaveProperty("relevantHistory");
    // 历史与 tasks 同级：任务级旧字段 relevantHistory 折叠到顶层。
    expect(answer!.relevantHistory).toBe("上次讨论：缓存 key 用 sessionId");
    // 旧 step 级验证/回滚/复杂度字段不再作为独立属性保留。
    expect(task).not.toHaveProperty("steps");
  });

  it("旧 steps 折叠进 executionGuidance；非法依赖字段降级", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "继续。",
      userConstraints: [],
      tasks: [{
        id: "task_1",
        executionGuidance: "检查当前登录路径",
        steps: [
          { id: "step_1", description: "检查当前登录路径", dependsOn: [] },
          { id: "step_2", description: "补一次类型检查", dependsOn: ["missing"] },
        ],
      }],
    }));

    expect(answer).not.toBeNull();
    expect(answer!.tasks[0].executionGuidance).toBe(
      "检查当前登录路径\n1. 检查当前登录路径\n2. 补一次类型检查",
    );
  });

  it("sanitize 持久化后仍保留执行指引/顶层历史", async () => {
    const record = await persistDecomposeRound(tmpDir, "parse-fields-session", "加 Redis 缓存", {
      intent: "用户希望登录页更快",
      userConstraints: ["必须使用 Redis"],
      relevantHistory: "相关历史：登录现状",
      tasks: [{
        id: "task_1",
        executionGuidance: "确认登录实现后加缓存并运行测试",
      }],
    });

    expect(record).not.toBeNull();
    const task = record!.taskDecompose?.tasks[0]!;
    expect(task.executionGuidance).toBe("确认登录实现后加缓存并运行测试");
    expect(record!.taskDecompose?.relevantHistory).toBe("相关历史：登录现状");
  });

  it("新结构解析：nodes[] 携带 title/executionGuidance/dependsOn，旧 tasks[] 仍可读", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "新意图",
      userConstraints: ["约束一"],
      relevantHistory: "共享历史",
      nodes: [
        { id: "n1", title: "节点一", executionGuidance: "任务一指引", dependsOn: [] },
        { id: "n2", title: "节点二", executionGuidance: "任务二指引", dependsOn: ["n1"] },
      ],
    }));

    expect(answer).not.toBeNull();
    expect(answer!.intent).toBe("新意图");
    expect(answer!.userConstraints).toEqual(["约束一"]);
    expect(answer!.tasks.map((t) => t.executionGuidance)).toEqual(["任务一指引", "任务二指引"]);
    expect(answer!.tasks[0].title).toBe("节点一");
    expect(answer!.tasks[1].dependsOn).toEqual(["n1"]);
    expect(answer!.relevantHistory).toBe("共享历史");

    // 旧 tasks[] 的 description/prompt/guidance 全部折叠进 executionGuidance（读兼容）。
    const legacy = parseDecomposeAnswer(JSON.stringify({
      intent: "旧意图",
      tasks: [{ id: "task_1", description: "任务", prompt: "指导", guidance: "旧指导" }],
    }));
    expect(legacy!.tasks[0].executionGuidance).toBe("任务\n指导\n旧指导");
  });

  it("旧格式兼容：顶层 steps + understanding + 被删字段 → 单 task_1（steps 折叠进 executionGuidance）+ intent", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      understanding: "旧格式理解段",
      userConstraints: ["旧约束"],
      steps: [{ id: "s1", description: "旧步骤", dependsOn: [] }],
      goal: "旧目标",
      scope: ["旧范围"],
      relation: "continue",
      completedSteps: ["旧完成"],
      pendingSteps: ["旧待办"],
      findings: [{ id: "f1", summary: "旧发现", evidenceIds: [], createdAt: "2024-01-01" }],
      checkpoints: [{ id: "c1", status: "started", createdAt: "2024-01-01" }],
    }));

    expect(answer).not.toBeNull();
    expect(answer!.intent).toBe("旧格式理解段");
    expect(answer!.userConstraints).toEqual(["旧约束"]);
    expect(answer!.tasks).toHaveLength(1);
    expect(answer!.tasks[0].id).toBe("task_1");
    expect(answer!.tasks[0].executionGuidance).toBe("1. 旧步骤");
    // 被删的旧字段直接忽略，不进入新结构。
    expect(answer).not.toHaveProperty("understanding");
    expect(answer).not.toHaveProperty("goal");
    expect(answer).not.toHaveProperty("scope");
    expect(answer).not.toHaveProperty("relation");
    expect(answer).not.toHaveProperty("completedSteps");
    expect(answer).not.toHaveProperty("pendingSteps");
    expect(answer).not.toHaveProperty("findings");
    expect(answer).not.toHaveProperty("checkpoints");
  });

  it("旧格式持久化兼容：顶层 steps + understanding → 单 task_1，steps 折叠进 executionGuidance", async () => {
    const legacy = {
      understanding: "旧理解",
      userConstraints: ["旧约束"],
      goal: "旧目标",
      relation: "continue",
      steps: [{ id: "s1", description: "旧步骤", dependsOn: [], stopReadingWhen: [] }],
    } as unknown as PersistedDecompose;
    const record = await persistDecomposeRound(tmpDir, "legacy-shape-session", "旧请求", legacy);

    expect(record).not.toBeNull();
    expect(record!.taskDecompose?.intent).toBe("旧理解");
    expect(record!.taskDecompose?.tasks).toHaveLength(1);
    expect(record!.taskDecompose?.tasks[0].id).toBe("task_1");
    expect(record!.taskDecompose?.tasks[0].executionGuidance).toBe("1. 旧步骤");
    expect(record!.taskDecompose).not.toHaveProperty("goal");
    expect(record!.taskDecompose).not.toHaveProperty("relation");
  });
});

describe("relevantHistory 与 ID 归一化", () => {
  it("解析重复 task id，执行指引保留到归一化后的节点", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "测试",
      relevantHistory: "共享历史",
      tasks: [
        { id: "task", description: "一", prompt: "指导A" },
        { id: "task", description: "二", prompt: "指导B" },
      ],
    }));
    expect(answer).not.toBeNull();
    expect(answer!.tasks.map((task) => task.id)).toEqual(["task", "task_2"]);
    expect(answer!.tasks.map((task) => task.executionGuidance)).toEqual([
      "一\n指导A",
      "二\n指导B",
    ]);
    expect(answer!.relevantHistory).toBe("共享历史");
  });

  it("保留顶层 relevantHistory；旧格式任务级历史折叠到顶层", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "测试",
      tasks: [{ id: "task", description: "任务", relevantHistory: "task history", prompt: "指导" }],
    }));
    expect(answer!.tasks[0]).not.toHaveProperty("relevantHistory");
    expect(answer!.relevantHistory).toBe("task history");
    // 顶层显式声明优先于任务级折叠。
    const explicit = parseDecomposeAnswer(JSON.stringify({
      intent: "测试",
      relevantHistory: "顶层历史",
      tasks: [{ id: "task", description: "任务", relevantHistory: "任务历史", prompt: "指导" }],
    }));
    expect(explicit!.relevantHistory).toBe("顶层历史");
  });

  it("简单任务零分解也保留顶层 relevantHistory", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "用户只是问一个问题",
      userConstraints: [],
      tasks: [],
      relevantHistory: "相关历史：上次讨论的结论",
    }));
    expect(answer!.tasks).toHaveLength(0);
    expect(answer!.relevantHistory).toBe("相关历史：上次讨论的结论");
  });

  it("持久化往返保留顶层 relevantHistory 与节点 executionGuidance/dependsOn", async () => {
    const record = await persistDecomposeRound(tmpDir, "history-session", "请求", {
      intent: "测试",
      userConstraints: [],
      relevantHistory: "task history",
      tasks: [{
        id: "n1",
        title: "任务标题",
        executionGuidance: "指导",
        dependsOn: [],
      }],
    });
    const task = record!.taskDecompose?.tasks[0]!;
    expect(task.executionGuidance).toBe("指导");
    expect(task.title).toBe("任务标题");
    expect(record!.taskDecompose?.relevantHistory).toBe("task history");
    const rounds = await loadRecentRounds(tmpDir, "history-session", 1);
    expect(rounds[0].taskDecompose?.relevantHistory).toBe("task history");
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

describe("当前代码/当前步骤行为询问不得空 tasks", () => {
  const originalQuestion = "现在任务分解这一步，历史信息是如何处理的？";

  it("识别原问法为当前实现行为询问，而不是纯讨论", () => {
    expect(isCurrentCodeBehaviorInquiry(originalQuestion)).toBe(true);
    expect(isCurrentCodeBehaviorInquiry("这段代码是如何处理超时的？")).toBe(true);
    expect(isCurrentCodeBehaviorInquiry("How does the current task decompose step handle history?")).toBe(true);
    expect(isCurrentCodeBehaviorInquiry("进度怎么样了？")).toBe(false);
    expect(isCurrentCodeBehaviorInquiry("先别改，我们讨论一下方案")).toBe(false);
  });

  it("模型把原问法判成 discuss 并清空 tasks 时，补回任务但不写执行引导", () => {
    const misclassified = parseDecomposeAnswer(JSON.stringify({
      intent: "用户在询问当前任务分解阶段如何处理历史信息。此轮目标是解释历史信息的继承、筛选和复用规则，不进行代码修改或任务规划。",
      userConstraints: [],
      tasks: [],
      relevantHistory: "历史信息按优先级使用：当前用户消息最高。",
    }));

    expect(misclassified).not.toBeNull();
    const recovered = recoverEmptyDecomposeTasks(misclassified!, originalQuestion);
    expect(recovered.tasks).toHaveLength(1);
    // 任务只携带用户原话，不追加“怎么读/怎么找”。
    expect(recovered.tasks[0].executionGuidance).toContain(originalQuestion);
  });

  it("真正的进度询问仍保持空 tasks", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "用户在问进度。",
      userConstraints: [],
      tasks: [],
    }));
    expect(answer).not.toBeNull();
    const recovered = recoverEmptyDecomposeTasks(answer!, "现在做到哪一步了？");
    expect(recovered.tasks).toHaveLength(0);
  });
});

describe("collapsePseudoLinearTasks：伪线性认知链折叠", () => {
  it("定位→分析→结论的三任务链折叠为单个任务，保留原字段内容", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "审查 syncProcessRecordsToMarket 的 isManual 条件是否正确实现",
      userConstraints: ["仅审查，不修改代码"],
      relevantHistory: "",
      tasks: [
        { id: "t1", title: "定位方法源码", executionGuidance: "在 DefaultCorrectServiceImpl 中找到方法实现", dependsOn: [], cognitiveOnly: true },
        { id: "t2", title: "分析分支逻辑", executionGuidance: "梳理 existing 查询与写入流程", dependsOn: ["t1"], cognitiveOnly: true },
        { id: "t3", title: "输出审查结论", executionGuidance: "给出逻辑是否正确的结论", dependsOn: ["t2"], cognitiveOnly: true },
      ],
    }))!;

    const collapsed = collapsePseudoLinearTasks(answer);
    expect(collapsed.tasks).toHaveLength(1);
    const task = collapsed.tasks[0]!;
    expect(task.id).toBe("t1");
    expect(task.dependsOn).toEqual([]);
    // executionGuidance 携带 intent 与全部子任务要点
    expect(task.executionGuidance).toContain("审查 syncProcessRecordsToMarket");
    expect(task.executionGuidance).toContain("定位方法源码");
    expect(task.executionGuidance).toContain("输出审查结论");
    expect(task.executionGuidance).toContain("merged from 3 linear sub-tasks");
    // 每个子任务的执行指引都并入合并后的指引
    expect(task.executionGuidance).toContain("在 DefaultCorrectServiceImpl 中找到方法实现");
    expect(task.executionGuidance).toContain("给出逻辑是否正确的结论");
    // 其余字段不动
    expect(collapsed.userConstraints).toEqual(["仅审查，不修改代码"]);
  });

  it("单任务直通", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "改一处",
      tasks: [{ id: "t1", description: "改", prompt: "", dependsOn: [] }],
    }))!;
    expect(collapsePseudoLinearTasks(answer).tasks).toHaveLength(1);
  });

  it("独立交付物的线性链不折叠", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "按 API 契约实现客户端",
      tasks: [
        { id: "t1", title: "生成 API 契约", description: "产出可独立审阅的 API 契约文档", prompt: "", dependsOn: [], cognitiveOnly: false },
        { id: "t2", title: "实现客户端", description: "按契约实现客户端调用", prompt: "", dependsOn: ["t1"], cognitiveOnly: false },
      ],
    }))!;
    expect(collapsePseudoLinearTasks(answer).tasks).toHaveLength(2);
  });

  it("cognitiveOnly 缺失时保留链，包括漏标 kind 的验证任务", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "实现并验证缓存",
      tasks: [
        { id: "t1", title: "实现缓存", description: "接入 Redis 缓存", prompt: "", dependsOn: [], cognitiveOnly: false },
        { id: "t2", title: "运行测试", description: "运行测试验证缓存实现", prompt: "", dependsOn: ["t1"] },
      ],
    }))!;
    expect(collapsePseudoLinearTasks(answer).tasks).toHaveLength(2);
    expect(answer.tasks[1]?.kind).toBeUndefined();
    expect(answer.tasks[1]?.cognitiveOnly).toBeUndefined();
  });

  it("含 verification 任务的不折叠", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "加缓存并验证",
      tasks: [
        { id: "t1", description: "接入 Redis 缓存", prompt: "", dependsOn: [] },
        { id: "t2", description: "跑测试验证", prompt: "", dependsOn: ["t1"], kind: "verification" },
      ],
    }))!;
    expect(collapsePseudoLinearTasks(answer).tasks).toHaveLength(2);
  });

  it("分支/汇合的真 DAG 不折叠", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "多交付物",
      tasks: [
        { id: "t1", description: "生成契约", prompt: "", dependsOn: [] },
        { id: "t2", description: "实现 A", prompt: "", dependsOn: ["t1"] },
        { id: "t3", description: "实现 B", prompt: "", dependsOn: ["t1"] },
        { id: "t4", description: "整合", prompt: "", dependsOn: ["t2", "t3"] },
      ],
    }))!;
    expect(collapsePseudoLinearTasks(answer).tasks).toHaveLength(4);
  });

  it("链中某任务依赖链外任务时不折叠", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "混合",
      tasks: [
        { id: "t1", description: "一", prompt: "", dependsOn: [] },
        { id: "t2", description: "二", prompt: "", dependsOn: ["t0"] },
      ],
    }))!;
    expect(collapsePseudoLinearTasks(answer).tasks).toHaveLength(2);
  });

  it("空任务列表直通", () => {
    const answer = parseDecomposeAnswer(JSON.stringify({
      intent: "提问",
      tasks: [],
      relevantHistory: "h",
    }))!;
    expect(collapsePseudoLinearTasks(answer).tasks).toHaveLength(0);
  });
});

describe("删除对话后分解历史同步", () => {
  const sessionId = "deleted-round-history";
  const budgets = contextBudgets(BUILTIN_WORKFLOW);
  const opts = (): AgentLoopOpts => ({
    mode: "agent", workspaceRoot: tmpDir, sessionId, workflow: BUILTIN_WORKFLOW,
    index: {} as AgentLoopOpts["index"], history: [], userMessage: "继续",
  });

  it("删除中间轮后，用户输入及模型报告均不再进入下次任务分解", async () => {
    for (const n of [1, 2, 3]) {
      const input = `请求-${n}`;
      const round = await persistDecomposeRound(tmpDir, sessionId, input, {
        intent: `分解-${n}`, userConstraints: [], tasks: [],
      }, [], [], `turn-${n}`);
      await persistRoundReport(tmpDir, sessionId, input, `模型回复-${n}`, round!.index);
    }
    expect(await deleteDecomposeRound(tmpDir, sessionId, "turn-2")).toBe(true);
    const context = await buildDecomposeContext(opts(), budgets);
    expect(context).toContain("请求-1");
    expect(context).toContain("模型回复-3");
    expect(context).not.toContain("请求-2");
    expect(context).not.toContain("模型回复-2");
    expect(context).not.toContain("分解-2");
  });

  it("删除唯一轮后不再注入历史，旧格式轮次可通过输入定位", async () => {
    const round = await persistDecomposeRound(tmpDir, sessionId, "唯一请求", {
      intent: "唯一分解", userConstraints: [], tasks: [],
    }, [], [], "only-turn");
    await persistRoundReport(tmpDir, sessionId, "唯一请求", "唯一回复", round!.index);
    expect(await deleteDecomposeRound(tmpDir, sessionId, "only-turn")).toBe(true);
    const context = await buildDecomposeContext(opts(), budgets);
    expect(context).not.toContain("唯一请求");
    expect(context).not.toContain("唯一回复");

    await persistRoundReport(tmpDir, sessionId, "旧格式请求", "旧格式回复");
    await persistRoundReport(tmpDir, sessionId, "保留请求", "保留回复");
    expect(await deleteDecomposeRound(tmpDir, sessionId, "legacy-id", "旧格式请求")).toBe(true);
    const remaining = await buildDecomposeContext(opts(), budgets);
    expect(remaining).toContain("保留回复");
    expect(remaining).not.toContain("旧格式请求");
    expect(remaining).not.toContain("旧格式回复");
  });
  it("删除被压缩轮次时清空包含已删内容的检查点", async () => {
    const first = await persistDecomposeRound(tmpDir, sessionId, "压缩轮", {
      intent: "压缩内容", userConstraints: [], tasks: [],
    }, [], [], "compressed-turn");
    await persistRoundReport(tmpDir, sessionId, "压缩轮", "压缩报告", first!.index);
    for (let n = 0; n < 6; n++) await persistRoundReport(tmpDir, sessionId, `保留-${n}`, `回复-${n}`);
    const summary = "压缩轮 压缩报告";
    const { persistDecomposeHistory } = await import("../../../../turn-rounds.ts");
    expect(await persistDecomposeHistory(tmpDir, sessionId, 0, first!.index, summary)).toBe(true);
    expect(await deleteDecomposeRound(tmpDir, sessionId, "compressed-turn")).toBe(true);
    expect((await loadDecomposeHistory(tmpDir, sessionId)).checkpoint).toBeUndefined();
    expect(await buildDecomposeContext(opts(), budgets)).not.toContain("压缩轮");
  });
});


describe("分解历史轮次编号与排序", () => {
  const budgets = contextBudgets(BUILTIN_WORKFLOW);
  const opts = (history: ChatTurn[] = [], sessionId = "history-fallback"): AgentLoopOpts => ({
    mode: "agent", workspaceRoot: tmpDir, sessionId, workflow: BUILTIN_WORKFLOW,
    index: {} as AgentLoopOpts["index"], history, userMessage: "当前请求",
  });

  it("持久化历史使用原始递增编号，删除中间轮后仍按最新到最早展示", async () => {
    const sessionId = "history-round-order";
    for (const n of [1, 2, 3]) {
      const round = await persistDecomposeRound(tmpDir, sessionId, `请求-${n}`, {
        intent: `分解-${n}`, userConstraints: [], tasks: [],
      }, [], [], `turn-${n}`);
      await persistRoundReport(tmpDir, sessionId, `请求-${n}`, `回复-${n}`, round!.index);
    }
    await deleteDecomposeRound(tmpDir, sessionId, "turn-2");
    const context = await buildDecomposeContext(opts([], sessionId), budgets);
    expect([...context.matchAll(/^## Round (\d+)\n\[user\] (请求-\d+)/gm)].map((match) => [match[1], match[2]])).toEqual([
      ["3", "请求-3"], ["1", "请求-1"],
    ]);
    expect(context).toContain("newest to oldest, highest Round number to lowest");
  });

  it("回退历史按最早 round 1、最新最大编号倒序展示", async () => {
    const history: ChatTurn[] = [1, 2, 3].flatMap((n) => [
      { role: "user", content: `回退请求-${n}` },
      { role: "assistant", content: `回退回复-${n}` },
    ]);
    const context = await buildDecomposeContext(opts(history), budgets);
    expect([...context.matchAll(/^## Round (\d+)\n\[user\] (回退请求-\d+)/gm)].map((match) => [match[1], match[2]])).toEqual([
      ["3", "回退请求-3"], ["2", "回退请求-2"], ["1", "回退请求-1"],
    ]);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Conversation history is presented from newest to oldest (nearest to farthest)");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Round 1 is the earliest session");
  });
});

describe("分解历史：使用滚动摘要和最近轮次，不检索向量历史", () => {
  const SESSION_ID = "sess-vector-recall";
  const budgets = contextBudgets(BUILTIN_WORKFLOW);


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

  it("buildDecomposeContext：无注入时仅最近轮，不含召回段", async () => {
    const userInput = "上一轮用户输入";
    await persistDecomposeRound(tmpDir, SESSION_ID, userInput, {
      intent: "最近一轮理解",
      userConstraints: [],
      tasks: [{ id: "task_1", executionGuidance: "最近一轮任务" }],
    });
    await persistRoundReport(tmpDir, SESSION_ID, userInput, "最近一轮报告");

    const ctx = await buildDecomposeContext(makeOpts({ historyVector: undefined }), budgets);
    expect(ctx).toContain("Recent conversation rounds");
    expect(ctx).toContain("最近一轮理解");
    expect(ctx).not.toContain("Vector-recalled history");
  });

  it("buildDecomposeContext：有 historyVector 时也不自动召回，仅注入最近轮", async () => {
    const userInput = "上一轮用户输入-完整保留";
    await persistDecomposeRound(tmpDir, SESSION_ID, userInput, {
      intent: "最近一轮理解-完整保留",
      userConstraints: [],
      tasks: [{ id: "task_1", executionGuidance: "接线召回任务" }],
    });
    await persistRoundReport(tmpDir, SESSION_ID, userInput, "最近一轮完整报告");

    let searchCalled = false;
    const ctx = await buildDecomposeContext(
      makeOpts({
        userMessage: "把向量召回加进任务分解历史拼装",
        history: [{ role: "user", content: "当前输入不应触发旧轮召回" }],
        historyVector: {
          embedding: {
            async embed() {
              throw new Error("任务分解上下文不应自动 embed 历史");
            },
          },
          store: {
            archive() {},
            hasContentHash() {
              return false;
            },
            search() {
              searchCalled = true;
              return [];
            },
            countBySession() {
              return 0;
            },
            deleteBySession() {},
          },
        },
      }),
      budgets,
    );

    expect(ctx).toContain("<conversation_history>");
    expect(ctx).toContain("Recent conversation rounds");
    expect(ctx).toContain("最近一轮理解-完整保留");
    expect(ctx).not.toContain("当前输入不应触发旧轮召回");
    expect(ctx).not.toContain("Vector-recalled history");
    expect(ctx).not.toContain("…(截断)");
    expect(searchCalled).toBe(false);
  });
});

describe("精确定位请求：不补任务、直接走快速路径", () => {
  const preciseMessages = [
    "请修改 packages/core/src/harness/loop/context.ts:46-54，把 freshReadGuidance 函数删掉",
    "把 tools.ts 第 70-75 行的任务执行判定改掉",
    "Fix src/auth.ts:120 — the token check returns early",
    "请修改 context.ts，把 `function freshReadGuidance(paths) {` 这段原文替换为 return paths;",
  ];
  const vagueMessages = [
    "帮我改一下登录逻辑",
    "请修改这个报错",
    "fix this",
    "把权限相关的代码重构一下",
  ];

  it("路径 + 行号锚点（或嵌入原文）判为精确请求", () => {
    for (const message of preciseMessages) {
      expect(isPreciseLocatedRequest(message)).toBe(true);
    }
  });

  it("只有路径或只有改码意愿，不判为精确请求", () => {
    for (const message of vagueMessages) {
      expect(isPreciseLocatedRequest(message)).toBe(false);
    }
    expect(isPreciseLocatedRequest("看看 src/auth.ts")).toBe(false);
    expect(isPreciseLocatedRequest("")).toBe(false);
  });

  it("精确请求空 tasks 时不补回定位任务（交给执行端快速路径）", () => {
    const precise = parseDecomposeAnswer(JSON.stringify({
      intent: "删除 freshReadGuidance 函数",
      userConstraints: [],
      tasks: [],
      relevantHistory: "",
    }));

    expect(precise).not.toBeNull();
    const recovered = recoverEmptyDecomposeTasks(precise!, preciseMessages[0]!);
    expect(recovered.tasks).toHaveLength(0);
  });

  it("模糊改码请求空 tasks 时仍补回可执行任务", () => {
    const vague = parseDecomposeAnswer(JSON.stringify({
      intent: "用户想修改代码",
      userConstraints: [],
      tasks: [],
      relevantHistory: "",
    }));

    expect(vague).not.toBeNull();
    const recovered = recoverEmptyDecomposeTasks(vague!, vagueMessages[0]!);
    expect(recovered.tasks.length).toBeGreaterThan(0);
  });
});
