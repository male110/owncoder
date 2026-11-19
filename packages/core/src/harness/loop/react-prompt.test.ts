/**
 * Execution prompt contract: keep the discipline short, explicit, and
 * evidence-first without reintroducing the old long routing essay.
 */
import { describe, expect, it } from "vitest";
import { formatCurrentTaskContext, formatIterationBudgetHint } from "./react-prompt.ts";
import type { TaskItem } from "../../plans.ts";

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: "n1",
    executionGuidance: "修改示例文件",
    status: "in_progress",
    dependsOn: [],
    retryCount: 0,
    maxRetries: 2,
    ...overrides,
  };
}

describe("任务上下文：短硬执行纪律", () => {
  it("注入精准任务、证据复用和停止条件", () => {
    const text = formatCurrentTaskContext(makeTask({
      executionGuidance: "请修改 packages/core/src/harness/loop/context.ts:46 的 freshReadGuidance",
    }));
    expect(text).toMatch(/Execution discipline \(mandatory\)/);
    expect(text).toMatch(/exact file\/range/i);
    expect(text).toMatch(/fresh evidence/i);
    expect(text).toMatch(/You have no search tools/i);
    expect(text).toMatch(/stop dispatching explorations/i);
  });

  it.each([
    "分析 @EnumValue 与 @JsonValue 的项目使用规范并提供证据",
    "修复格式缺陷并报告根因、修改与验证结果",
  ])("多点报告不再被强制压成一句话：%s", (executionGuidance) => {
    const text = formatCurrentTaskContext(makeTask({ executionGuidance }));
    expect(text).not.toMatch(/report the result in one sentence/i);
    expect(text).toContain("stop calling tools");
    expect(text).toContain("Markdown headings (## / ###)");
    expect(text).toContain("short paragraphs separated by blank lines");
    expect(text).toContain("bullet or numbered lists");
    expect(text).toContain("fenced code blocks with a language tag when needed");
    expect(text).toContain("Preserve the business conclusions, supporting evidence, and uncertainty");
    expect(text).toContain("unless the user explicitly requests a different format");
    expect(text).toContain("Simple answers may stay brief without extra sections");
  });

  it("requires a detailed Explore brief and rejects broad delegation", () => {
    const text = formatCurrentTaskContext(makeTask({
      executionGuidance: "在已确认的 react-prompt.ts 中调整 Explore 任务描述，并验证提示词测试。",
    }));
    expect(text).toContain('Before dispatch_agent with agent_type="Explore"');
    expect(text).toContain("self-contained exploration brief");
    expect(text).toContain("confirmed file paths and classes/methods/fields or line ranges");
    expect(text).toContain("conclusions and their evidence");
    expect(text).toContain("the specific unknowns to resolve");
    expect(text).toContain("preferred entry points");
    expect(text).toContain("the limited call chains to trace");
    expect(text).toContain("areas and anchors that must not be read or explored again");
    expect(text).toContain("relevant boundaries and failure paths");
    expect(text).toContain("the file paths, symbols, and line ranges the Explore report must return");
    expect(text).toContain("If only a module-level entry is known");
    expect(text).toContain("if no repository evidence exists");
    expect(text).toContain("without guessing paths or method names");
    expect(text).toContain('Never send only broad requests such as "explore the relevant code"');
    expect(text).toContain("never ask Explore to relocate anchors already confirmed in history");
  });

  it("先复用分解阶段历史，历史为空时不注入该引导", () => {
    const withHistory = formatCurrentTaskContext(makeTask({
      relevantHistory: "packages/core/src/example.ts 中的 updateTask 函数负责更新任务。",
    }));
    expect(withHistory).toContain("### Reusable history (from task decomposition)");
    expect(withHistory).toContain("Review and reuse this history before acting.");
    expect(withHistory).toContain("do not search for or re-explore them");
    expect(withHistory).toContain("Treat history as a lead, not verified fact");
    expect(withHistory).toContain("cite actual evidence in the result");
    expect(withHistory).toContain("packages/core/src/example.ts 中的 updateTask");

    const withoutHistory = formatCurrentTaskContext(makeTask());
    expect(withoutHistory).not.toContain("### Reusable history");
    expect(withoutHistory).not.toContain("Review and reuse this history");
  });

  it("仍携带任务字段（做什么），顺序为标题在前", () => {
    const task = makeTask({
      executionGuidance: "修改示例文件",
    });
    const text = formatCurrentTaskContext(task);
    expect(text).toMatch(/## \*\*Current Task/);
    expect(text).toMatch(/ID: n1/);
    expect(text).toMatch(/Execution guidance \(how to carry out this task\): 修改示例文件/);
    expect(text.indexOf("## **Current Task")).toBeLessThan(
      text.indexOf("Execution guidance (how to carry out this task): 修改示例文件"),
    );
  });

  it("要求动手前核对 brief 锚点：锚点错误时在任务内校准，且明确任务清单不可改", () => {
    const text = formatCurrentTaskContext(makeTask());
    expect(text).toContain("verify the brief's anchors");
    expect(text).toContain("the task list is append-only");
    expect(text).toContain("State the corrected anchors you actually used in the final report");
  });

  it("注入上游接力包（Upstream results），无接力时不注入该段", () => {
    const withRelay = formatCurrentTaskContext(
      makeTask({ dependsOn: ["t1"] }),
      false,
      "**Verified anchors**: src/a.ts L10-40\n**Changed files**: src/a.ts",
    );
    expect(withRelay).toContain("### Upstream results (verified; do not re-verify)");
    expect(withRelay).toContain("**Verified anchors**: src/a.ts L10-40");
    // 接力段位于 execution guidance 之前
    expect(withRelay.indexOf("Upstream results")).toBeLessThan(
      withRelay.indexOf("Execution guidance (how to carry out this task):"),
    );

    const withoutRelay = formatCurrentTaskContext(makeTask());
    expect(withoutRelay).not.toContain("Upstream results");
  });

  it("迭代预算提示给出当前序号、上限与剩余次数，剩余 0 时改为强制收尾指令", () => {
    expect(formatIterationBudgetHint(1, 39)).toContain("当前第 1 次迭代，上限 39 次，剩余 38 次");
    expect(formatIterationBudgetHint(1, 39)).toContain("请据此安排工具调用预算");

    const last = formatIterationBudgetHint(39, 39);
    expect(last).toContain("当前第 39 次迭代，上限 39 次，剩余 0 次");
    // 最后一轮：强制收尾——不得再调用工具，必须直接输出最终计划/结论文本。
    expect(last).toContain("这是最后一次迭代");
    expect(last).toContain("不得再调用任何工具");
    expect(last).toContain("必须直接输出最终计划/结论文本");
    // 不再出现工具调用引导，且不与终态文案“已达到最大迭代限制”重复。
    expect(last).not.toContain("请据此安排工具调用预算");
    expect(last).not.toContain("已达到最大迭代限制");
    // 上限被调小到当前序号之后也按 0 兜底，不出现负数剩余
    expect(formatIterationBudgetHint(5, 3)).toContain("剩余 0 次");
    expect(formatIterationBudgetHint(5, 3)).toContain("不得再调用任何工具");
  });

  it("planner 模式：常规轮引导高效调研与 submit_plan 出口，收尾区注入递进收口压力", () => {
    // 常规轮（剩余 > PLANNER_WRAP_UP_TURNS）：提示高效调研 + submit_plan 出口，
    // 不出现执行循环的“核心改动与验证”措辞（只读规划循环不可执行）。
    const normal = formatIterationBudgetHint(3, 25, "planner");
    expect(normal).toContain("当前第 3 次迭代，上限 25 次，剩余 22 次");
    expect(normal).toContain("submit_plan");
    expect(normal).toContain("高效调研");
    expect(normal).not.toContain("核心改动与验证");

    // 收尾区（剩余 ≤ PLANNER_WRAP_UP_TURNS）：停止调研、基于已有证据写计划并立即提交。
    const wrapUp = formatIterationBudgetHint(20, 25, "planner");
    expect(wrapUp).toContain("仅剩 5 次迭代");
    expect(wrapUp).toContain("停止进一步调研");
    expect(wrapUp).toContain("立即调用 submit_plan");
    expect(wrapUp).toContain("风险与不确定性");

    // 边界：剩余恰好等于 PLANNER_WRAP_UP_TURNS 时已进入收尾区。
    expect(formatIterationBudgetHint(19, 25, "planner")).toContain("停止进一步调研");

    // 最后一轮与 executor 共用强制收尾指令。
    const last = formatIterationBudgetHint(25, 25, "planner");
    expect(last).toContain("这是最后一次迭代");
    expect(last).toContain("不得再调用任何工具");

    // executor 模式不受 planner 措辞影响（默认模式仍引导工具调用预算）。
    expect(formatIterationBudgetHint(20, 25)).toContain("请据此安排工具调用预算");
    expect(formatIterationBudgetHint(20, 25)).not.toContain("submit_plan");
  });

  it("explore 模式：常规轮引导高效调研与 submit_report 出口，收尾区注入递进收口压力", () => {
    const normal = formatIterationBudgetHint(3, 40, "explore");
    expect(normal).toContain("当前第 3 次迭代，上限 40 次，剩余 37 次");
    expect(normal).toContain("submit_report");
    expect(normal).toContain("高效调研");
    expect(normal).not.toContain("核心改动与验证");

    const wrapUp = formatIterationBudgetHint(35, 40, "explore");
    expect(wrapUp).toContain("仅剩 5 次迭代");
    expect(wrapUp).toContain("停止进一步调研");
    expect(wrapUp).toContain("立即调用 submit_report");
    expect(wrapUp).toContain("未确认缺口");

    // 最后一轮与 executor 共用强制收尾指令。
    expect(formatIterationBudgetHint(40, 40, "explore")).toContain("不得再调用任何工具");

    // explore 与 planner 的出口措辞互不串扰。
    expect(formatIterationBudgetHint(35, 40, "explore")).not.toContain("submit_plan");
    expect(formatIterationBudgetHint(20, 25, "planner")).not.toContain("submit_report");
  });
});
