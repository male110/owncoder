import assert from "node:assert/strict";
import { test } from "vitest";
import { allEnhancedTools } from "../enhanced-tools.ts";
import { buildExploreSubagentPrompt, EXPLORE_SUBAGENT_ALLOWED_TOOLS } from "./explore-subagent.ts";

test("Explore prompt: 角色与工具能力保留，命令搜索引导全部移除", () => {
  const prompt = buildExploreSubagentPrompt();
  // 保留：角色定义、只读约束、工具能力文档、报告契约。
  for (const text of [
    "You are OwnCoder Explore",
    "READ-ONLY MODE",
    "One principle: read less",
    "read_outline` / `read_symbol`",
    "search_symbols",
    "repo_map` / `graph_search` / `project_deps`",
    "run_script` lets you program it",
    "workspace-relative file paths and line numbers",
  ]) {
    assert.ok(prompt.includes(text), text);
  }
  // 已删：命令搜索教学（grep/find/ls 通过 run_script/bash 执行的引导）、
  // 阅读纪律块、工作流程套路、广度档位引导、复用指令。
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
});

test("Explore prompt: ZCode 式速度优先框架与并行批次指令（机制层 PARALLEL_SAFE_TOOLS 并发执行同批只读调用）", () => {
  const prompt = buildExploreSubagentPrompt();
  // 速度优先：fast agent 定位 + 聪明选择工具。
  assert.ok(prompt.includes("fast agent that returns output as quickly as possible"));
  assert.ok(prompt.includes("pick the tool that answers the question in the fewest steps"));
  // 并行批次：多个独立搜索/读取放同一批并发执行（直接压低轮次与预算消耗）。
  assert.ok(prompt.includes("parallel tool calls in one batch"));
  assert.ok(prompt.includes("execute concurrently"));
  // 节选读取：读区间而不是整文件（定位代码而非评审代码）。
  assert.ok(prompt.includes("reading excerpts rather than whole files"));
  assert.ok(prompt.includes("offset/limit"));
  assert.ok(prompt.includes("locate code and evidence"));
  // 显式只读禁令：枚举禁止操作而不是一句话带过。
  assert.ok(prompt.includes("strictly prohibited from creating, modifying, deleting, moving, or copying files"));
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

test("Explore 结构性收口：白名单含 submit_report，且仅 exploreLoop 门控下注册", () => {
  // 白名单含 submit_report（提交即结束循环的只读控制流工具）。
  assert.ok(EXPLORE_SUBAGENT_ALLOWED_TOOLS.includes("submit_report"));
  // 工具清单门控：exploreLoop 注册 submit_report；默认（主循环）与
  // plannerLoop（Planner 循环）都不注册它——机制层防误用。
  const exploreNames = allEnhancedTools({ mode: "agent", exploreLoop: true }).map(t => t.function.name);
  assert.ok(exploreNames.includes("submit_report"));
  assert.ok(!exploreNames.includes("submit_plan"));
  for (const mode of ["agent", "spec"] as const) {
    assert.ok(!allEnhancedTools({ mode }).map(t => t.function.name).includes("submit_report"));
  }
  assert.ok(!allEnhancedTools({ mode: "agent", plannerLoop: true }).map(t => t.function.name).includes("submit_report"));
});

test("Explore prompt 不再要求 Final Report 标题（runner 统一包装）", () => {
  const prompt = buildExploreSubagentPrompt();
  assert.ok(!prompt.includes("## Final Report"));
  // 内容契约保留：证据引用 + 明确结论。
  assert.ok(prompt.includes("workspace-relative file paths and line numbers"));
  assert.ok(prompt.includes("clear conclusion"));
});

test("Explore prompt 摘录纪律对齐 ZCode：只贴载荷性代码，不复述读过的内容", () => {
  const prompt = buildExploreSubagentPrompt();
  // 报告保持结论密度：绝对不搬运读过的代码，只在原文承载关键事实时引用
  // （找到的 bug、被点名要的签名）；父循环需要正文时自己读引用区间。
  assert.ok(prompt.includes("Include code snippets only when the exact text is load-bearing"));
  assert.ok(prompt.includes("do not recap code you merely read"));
});

test("Explore prompt 把 submit_report 声明为唯一成功出口", () => {
  const prompt = buildExploreSubagentPrompt();
  assert.ok(prompt.includes("submit_report"));
  assert.ok(/only successful exit/i.test(prompt));
  // 找不到的点显式写入报告后照常提交，而不是继续搜索。
  assert.ok(/submit anyway rather than searching further/.test(prompt));
});

test("Explore prompt 范围纪律：命名锚点之外即越界（对齐 Codex well-scoped delegation 的子代理侧兜底）", () => {
  const prompt = buildExploreSubagentPrompt();
  for (const text of [
    "Scope discipline (mandatory)",
    "Stay inside the task's named scope",
    "out of scope unless the question cannot be answered without it",
    "Search hits outside the named scope are noise",
    "Do not tour the repository to build context first",
    "node_modules, dist, build output, .git",
  ]) {
    assert.ok(prompt.includes(text), text);
  }
});

test("Explore prompt 任务 intake：收到上游 brief 先细化，锚点修正回写报告", () => {
  const prompt = buildExploreSubagentPrompt();
  for (const text of [
    "Task intake (mandatory — refine the upstream brief before acting)",
    "restate the delegated question in one sentence",
    "Split the question into the core",
    "Verify the brief's named anchors",
    "relocate it and report the correction explicitly",
    "Decide your first targeted action before acting",
  ]) {
    assert.ok(prompt.includes(text), text);
  }
  // 报告契约要求锚点修正显式可见，父级据此修正计划。
  assert.ok(/a silent correction is wasted work/.test(prompt));
});
