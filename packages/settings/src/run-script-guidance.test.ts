import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_PROMPT, BUILTIN_SPEC_PROMPT } from "./builtin-prompts.js";
import { BUILTIN_SPEC_TASK_DECOMPOSE_PROMPT, BUILTIN_TASK_DECOMPOSE_PROMPT } from "./task-decompose-prompt.js";

// run_script 的工具选择规则已从项目上下文片段提升到内置系统提示词（spec/agent）：
// 单次 grep/glob/read_file 直接作为顶层工具调用，run_script 只用于实质过滤/聚合/解析/交叉比对
// 或编排多次工具调用；嵌套 tools.call 额外消耗嵌套调用预算。此处锁住该规则存在且不再回潮。
describe("Agent evidence-first discipline", () => {
  it("uses short deterministic rules instead of exploration prose", () => {
    expect(BUILTIN_AGENT_PROMPT).toContain("## Minimal reading discipline");
    expect(BUILTIN_AGENT_PROMPT).toMatch(/Act first/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/end the exploration/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/Reuse what is already in context/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/analyze from it instead of re-reading/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/Tool responses confirm edits/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/do not re-read the file to verify your own change/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/follow the current codebase's existing code style/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/single responsibility/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/Prefer reusing existing code or mature third-party solutions/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/unless the user explicitly asks/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/reuse only when the existing code's logic and semantics genuinely fit/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/Never contort the implementation to force reuse/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/concise, clear comments/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/Map types, document what the keys and values each represent/i);
    // 精简后不得回潮成冗长的探索散文
    expect(BUILTIN_AGENT_PROMPT).not.toMatch(/at most ~3 exploratory tool calls/i);
    expect(BUILTIN_AGENT_PROMPT).not.toContain("## Evidence-first execution discipline");
    expect(BUILTIN_AGENT_PROMPT).not.toContain("## Output format (Markdown)");
  });

  it("delegates exploration to Explore subagents instead of inline search tools", () => {
    // 探索外包契约：executor 没有搜索工具，调研全部走 dispatch_agent。
    expect(BUILTIN_AGENT_PROMPT).toMatch(/No inline exploration/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/no search tools/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/dispatch_agent/);
    // 单一交付的调研/审查只发一个综合 Explore 简报，不得为并行而拆分。
    expect(BUILTIN_AGENT_PROMPT).toMatch(/One assignment, one dispatch/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/never a split of one assignment just to parallelize/);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/read_file` is only for paths already established/);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/Explore reports are evidence/i);
    // 报告即证据：按引用区间（offset/limit）读取并动手，不整文件重读。
    expect(BUILTIN_AGENT_PROMPT).toMatch(/read the cited range \(offset\/limit\), not the whole file/);
    // 顺序依赖的后续派发：先前 Explore 报告的锚点蒸馏进新简报（标记为背景、
    // 禁止重定位）；不逐字转发报告，也不走 relevantHistory 参数。
    expect(BUILTIN_AGENT_PROMPT).toMatch(/fold that report's confirmed paths, symbols, and conclusions into the new brief/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/forward distilled anchors — never the report verbatim/);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/never via the relevantHistory parameter/);
    // 续接优先：报告尾注里的 agent id 用于 continueAgentId 续接，保留完整上下文。
    expect(BUILTIN_AGENT_PROMPT).toMatch(/continueAgentId/);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/dispatch again with that id as `continueAgentId`/i);
    // 内联搜索教学不得回潮（read_outline/grep/glob 直调规则已被删除）
    expect(BUILTIN_AGENT_PROMPT).not.toMatch(/read_outline/i);
    expect(BUILTIN_AGENT_PROMPT).not.toContain("Call a single `grep`, `glob`, or `read_file` directly as a top-level tool call");
  });
});

for (const [mode, prompt] of [["agent", BUILTIN_AGENT_PROMPT], ["spec", BUILTIN_SPEC_PROMPT]] as const) {
  describe(`${mode} run_script guidance`, () => {
    it("carries the promoted tool-selection rule", () => {
      if (mode === "spec") {
        // spec 模式保留内联搜索：直调规则只锁 spec 侧。
        expect(prompt).toContain("Call a single `grep`, `glob`, or `read_file` directly as a top-level tool call");
      }
      expect(prompt).toMatch(/Use `run_script` when JavaScript will materially filter, aggregate, parse, or cross-match/);
      expect(prompt).toMatch(/consumes a nested-call budget/);
      expect(prompt).not.toContain("Investigation Routing");
      expect(prompt).not.toContain("Investigation Strategy");
      expect(prompt).not.toContain("RUN_SCRIPT_EXAMPLES");
    });
  });
}

describe("spec-mode design research", () => {
  it("uses read-only evidence without a Planner approval", () => {
    expect(BUILTIN_SPEC_PROMPT).toContain("read-only tools or Explore");
    expect(BUILTIN_SPEC_PROMPT).toContain("crosses modules or workflow boundaries");
    expect(BUILTIN_SPEC_PROMPT).toContain("do not dispatch Planner or require a separate plan approval in Spec mode");
    expect(BUILTIN_SPEC_PROMPT).toContain("source code never modified");
  });
});

describe("task-decompose Planner classification", () => {
  it("routes complex changes to Planner together with the relevant history", () => {
    // 精简后的分解提示词只保留 Planner 入口：复杂变更先出计划，并传递相关历史；
    // 旧版 deliverable/Planner 分类长段已被有意精简。
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("invoke the plan-generating subagent (Planner)");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("pass the relevant history to it");
  });
});

describe("dedicated spec task decomposition", () => {
  it("uses the Agent JSON fields but prohibits code implementation", () => {
    expect(BUILTIN_SPEC_TASK_DECOMPOSE_PROMPT).toContain("# Output requirements");
    expect(BUILTIN_SPEC_TASK_DECOMPOSE_PROMPT).toContain('\"relevantHistory\"');
    expect(BUILTIN_SPEC_TASK_DECOMPOSE_PROMPT).toContain("never create implementation tasks that edit source code");
    expect(BUILTIN_SPEC_TASK_DECOMPOSE_PROMPT).toContain("Planner and code-change rules apply only to Agent mode");
    expect(BUILTIN_SPEC_TASK_DECOMPOSE_PROMPT).toContain("latest user message clearly asks to proceed");
    expect(BUILTIN_SPEC_TASK_DECOMPOSE_PROMPT).toContain("全部执行");
  });
});

describe("task-decompose run_script guidance", () => {
  it("no longer steers task executors toward run_script", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toContain("run_script");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toContain("RUN_SCRIPT_EXAMPLES");
  });

  it("keeps code exploration guidance tool-agnostic and free of shell commands", () => {
    // 旧的命令式探索教学（rg --files、先在仓库根目录…）已删；执行指引只保留
    // 行动原则（read one, change one），不再绑定具体命令。
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("read one, change one");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toContain("rg --files");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toContain("先在仓库根目录");
  });
});

describe("task-decompose executionGuidance brief", () => {
  it("requires a well-scoped brief ordered as deliverable, anchors, scope, how, report", () => {
    // Codex 式 well-scoped delegation：executor 的范围完全来自 brief，
    // 所以 brief 必须按固定顺序写全五个部分。
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Deliverable: one sentence naming the concrete outcome");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Anchors: every confirmed anchor you hold for this task");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Scope: name the files or modules this task owns");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("How: the approach, the order to proceed in");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Report: the final report must cite");
  });

  it("forbids invented anchors and keeps the executor off out-of-scope files", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Never invent a path or symbol to look detailed");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("out of bounds: search hits there are noise to skip");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Two tasks must never own the same files");
  });

  it("does not re-explore anchors already established in the brief or history", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Do not re-explore established evidence");
    // relevantHistory 侧的配合：转发给子代理的已确认锚点标记为背景、禁止重定位。
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("tell the subagent not to re-read or relocate already confirmed anchors");
  });

  it("keeps task splitting deliverable-oriented", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("never return an empty `tasks` array");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("do not treat the steps of completing a task as separate tasks");
  });

  it("still shows a confirmed-anchor task example", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Confirmed anchors, written into the task so the executor starts at the site");
  });
});
