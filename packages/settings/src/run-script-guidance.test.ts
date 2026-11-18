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
  it("keeps design deliverables separate from Planner eligibility and code edits", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Deliverable classification is separate from Planner eligibility");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("even when the current deliverable is only a design or plan");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("tracing cross-module workflows");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("an ordinary conceptual proposal or explanation of a known single file does not qualify");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Generate code-change tasks only when");
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

  it("keeps code exploration guidance tool-oriented and command-agnostic", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("read that implementation in one pass");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("give an entry point, not a search command");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toContain("rg --files");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toContain("先在仓库根目录");
  });
});

describe("task-decompose plan detail rules", () => {
  it("requires confirmed anchors in executionGuidance and forbids invented ones", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("ordered as deliverable, then anchors, then how, then report");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Anchors second");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Evidence rule — never invent");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Confirmed: you hold the path and symbol from evidence");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Partially confirmed");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("No codebase evidence at all");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("never guess a path or method name to fill the gap");
  });

  it("keeps exploration out of the task list and degrades instead of stalling", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("The plan must be executable at decomposition time, not after re-exploration");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Never spend a task on exploration");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("When evidence runs out, degrade the plan; do not stall it");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Never return a plan that only asks for more investigation");
  });

  it("mines history entries for reusable anchors", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Mine the history for anchors, not just for prose");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("an anchor already read in an earlier round is confirmed evidence");
  });

  it("shows confirmed, partial, and evidence-free task examples", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Confirmed anchors, written into the task so the executor starts at the site");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Partial evidence: name the known entry point");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("locating is the first action inside the deliverable task");
  });

  it("requires a detailed Explore brief for every delegated exploration", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("self-contained exploration brief rather than a broad request");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("every confirmed path and class/method/function/field or line range");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("the conclusions and evidence already held");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("the exact unknowns to resolve");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("the preferred entry points");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("the limited call chains to trace");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("the areas and anchors that must not be read or explored again");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("the relevant boundaries and failure paths");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("the file paths, symbols, and line ranges the Explore report must return");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("When only a module-level entry is known");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("when no repository evidence exists");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("without guessing paths or method names");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain('Never reduce the request to "explore the relevant code"');
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("never ask Explore to relocate anchors already confirmed in history");
  });
});
