/**
 * Planner 子代理结构性收口契约测试。
 *
 * 锁住的语义：
 * - submit_plan 收口工具只在 plannerLoop 门控下注册，主循环/Explore 永远看不到
 * - Planner 白名单含 submit_plan 且不含任何写工具
 * - 提示词契约把 submit_plan 声明为唯一成功出口
 */
import { describe, expect, it } from "vitest";
import { allEnhancedTools } from "../enhanced-tools.ts";
import { SUBMIT_PLAN_TOOL_DEF } from "../enhanced-tools/interaction.ts";
import {
  buildPlannerSubagentPrompt,
  PLANNER_SUBAGENT_ALLOWED_TOOLS,
} from "./planner-subagent.ts";

describe("submit_plan 工具注册门控", () => {
  it("SUBMIT_PLAN_TOOL_DEF 标记 readOnly（纯控制流，无副作用）", () => {
    expect(SUBMIT_PLAN_TOOL_DEF.readOnly).toBe(true);
    expect(SUBMIT_PLAN_TOOL_DEF.function.name).toBe("submit_plan");
  });

  it("plannerLoop 时注册 submit_plan；默认（主循环）与 exploreLoop 都不注册", () => {
    const plannerTools = allEnhancedTools({ mode: "agent", plannerLoop: true }).map((t) => t.function.name);
    expect(plannerTools).toContain("submit_plan");
    expect(plannerTools).not.toContain("submit_report");
    for (const mode of ["agent", "spec"] as const) {
      const tools = allEnhancedTools({ mode }).map((t) => t.function.name);
      expect(tools).not.toContain("submit_plan");
    }
    expect(allEnhancedTools({ mode: "agent", exploreLoop: true }).map((t) => t.function.name)).not.toContain("submit_plan");
  });
});

describe("Planner 白名单与提示词契约", () => {
  it("白名单含 submit_plan 收口工具，不含写/Bash/任务清单工具", () => {
    expect(PLANNER_SUBAGENT_ALLOWED_TOOLS).toContain("submit_plan");
    for (const banned of ["bash", "write_file", "apply_patch", "append_file", "save_spec", "save_design", "add_tasks"]) {
      expect(PLANNER_SUBAGENT_ALLOWED_TOOLS).not.toContain(banned);
    }
  });

  it("提示词把 submit_plan 声明为唯一成功出口，并保留五段计划契约", () => {
    const prompt = buildPlannerSubagentPrompt({ workingDirectory: "/tmp/ws", isGitRepository: true, platform: "win32" });
    expect(prompt).toContain("submit_plan");
    expect(prompt).toMatch(/only successful exit/i);
    for (const section of ["目标", "编号步骤", "相关文件", "风险与不确定性", "验证方式"]) {
      expect(prompt).toContain(section);
    }
    // 未知点显式进入风险段，而不是继续调研。
    expect(prompt).toMatch(/submit the plan instead of expanding the search speculatively/);
  });

  it("提示词要求按计划步骤窄化研究，并在无法证实时停止并提交风险", () => {
    const prompt = buildPlannerSubagentPrompt({}, "已确认锚点：src/a.ts:12");
    for (const text of [
      "Reuse the background history and confirmed anchors as starting evidence",
      "For each planning step, investigate only its required implementation landing point",
      "Every additional file you inspect must answer a concrete question tied to a planning step",
      "Prefer targeted workspace-relative `glob` / `grep` patterns and symbol-level reads",
      "stay within the brief's named target directory",
      "expand to one explicitly relevant directory only when needed",
      "Skip out-of-scope hits and directory enumeration",
      "Put anything you could not verify under 风险与不确定性 and submit the plan",
    ]) {
      expect(prompt).toContain(text);
    }
  });

  it("relevantHistory 注入仍标注为背景证据而非当前指令", () => {
    const prompt = buildPlannerSubagentPrompt({}, "已确认锚点：src/a.ts:12");
    expect(prompt).toContain("=== 任务分解阶段相关历史 ===");
    expect(prompt).toContain("背景证据与已确认锚点");
    expect(prompt).toContain("已确认锚点：src/a.ts:12");
  });

  it("提示词含 Scope discipline：brief 范围之外即越界（对齐 Explore / Codex well-scoped delegation）", () => {
    const prompt = buildPlannerSubagentPrompt({ workingDirectory: "/tmp/ws", isGitRepository: true, platform: "win32" });
    for (const text of [
      "Scope discipline (mandatory)",
      "Stay inside the brief's named scope",
      "including modules that must not change",
      "out of bounds unless a named open question requires it",
      "Search hits outside the named scope are noise",
      "Do not tour the repository to build context first",
      "node_modules, dist, build output, .git",
      "Do not re-read or re-locate anchors the brief or the background history already confirmed",
    ]) {
      expect(prompt).toContain(text);
    }
  });

  it("Task intake: refines the upstream brief before acting (critical-path ordering, anchor verification, first step)", () => {
    const prompt = buildPlannerSubagentPrompt({ workingDirectory: "/tmp/ws", isGitRepository: true, platform: "win32" });
    for (const text of [
      "Task intake (mandatory — refine the upstream brief before acting)",
      "restate the delegated goal in one sentence",
      "Verify the brief's confirmed anchors",
      "Sequence the plan around the critical path",
      "Decide the first concrete step before acting",
    ]) {
      expect(prompt).toContain(text);
    }
    // 计划契约要求锚点修正显式进入相关文件段。
    expect(prompt).toContain("call the correction out under 相关文件");
  });
});
