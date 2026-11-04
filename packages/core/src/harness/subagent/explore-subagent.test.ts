import assert from "node:assert/strict";
import { test } from "vitest";
import { allEnhancedTools } from "../enhanced-tools.ts";
import { buildExploreSubagentPrompt, EXPLORE_SUBAGENT_ALLOWED_TOOLS } from "./explore-subagent.ts";

test("Explore prompt: 角色与工具能力保留，命令搜索引导全部移除", () => {
  for (const breadth of ["medium", "very thorough"]) {
    const prompt = buildExploreSubagentPrompt(breadth);
    // 保留：角色定义、只读约束、工具能力文档、报告契约。
    for (const text of [
      "You are OwnCoder Explore",
      "READ-ONLY MODE",
      "One principle: read less",
      "read_outline` / `read_symbol`",
      "search_symbols",
      "repo_map` / `graph_search` / `project_deps`",
      "run_script` lets you program it",
      "## Final Report",
      "workspace-relative file paths and line numbers",
    ]) {
      assert.ok(prompt.includes(text), text);
    }
    // 已删：命令搜索教学（grep/find/ls 通过 run_script/bash 执行的引导）、
    // 阅读纪律块、工作流程套路、thoroughness 引导、复用指令。
    for (const removed of [
      "grep -rnE --exclude-dir=node_modules 'pattern' .",
      "find . -name 'x'",
      "child_process or tools.call(\"bash\"",
      "typical search patterns are documented",
      "File location & reading discipline",
      "How to work",
      "issue multiple parallel tool calls",
      "Adapt your search approach",
      "Exploration pattern",
      "confirmed hits versus open questions",
      "use it directly without re-exploring",
      "do not broaden the scope",
    ]) {
      assert.ok(!prompt.includes(removed), removed);
    }
  }
});

test("Explore exposes run_script in both modes without granting shell or writes", () => {
  const allowed = new Set(EXPLORE_SUBAGENT_ALLOWED_TOOLS);
  for (const mode of ["agent", "spec"] as const) {
    const tools = allEnhancedTools({ mode }).filter(t => allowed.has(t.function.name));
    const names = tools.map(t => t.function.name);
    assert.ok(names.includes("run_script"));
    assert.ok(names.includes("grep"));
    assert.ok(names.includes("glob"));
    assert.ok(names.includes("read_file"));
    for (const name of ["bash", "write_file", "apply_patch", "dispatch_agent", "ask_user", "type_check", "save_memory", "list_dir"]) {
      assert.ok(!names.includes(name), name);
    }
  }
});
