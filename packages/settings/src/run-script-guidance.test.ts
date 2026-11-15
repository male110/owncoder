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
    expect(BUILTIN_AGENT_PROMPT).toMatch(/read_outline/i);
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
});

for (const [mode, prompt] of [["agent", BUILTIN_AGENT_PROMPT], ["spec", BUILTIN_SPEC_PROMPT]] as const) {
  describe(`${mode} run_script guidance`, () => {
    it("carries the promoted tool-selection rule", () => {
      expect(prompt).toContain("Call a single `grep`, `glob`, or `read_file` directly as a top-level tool call");
      expect(prompt).toMatch(/Use `run_script` when JavaScript will materially filter, aggregate, parse, or cross-match/);
      expect(prompt).toMatch(/consumes a nested-call budget/);
      expect(prompt).not.toContain("Investigation Routing");
      expect(prompt).not.toContain("Investigation Strategy");
      expect(prompt).not.toContain("RUN_SCRIPT_EXAMPLES");
    });
  });
}

describe("spec-mode Planner eligibility", () => {
  it("plans cross-file architecture before approval without escalating simple requests", () => {
    expect(BUILTIN_SPEC_PROMPT).toContain("use dispatch_agent with agent_type=\"Planner\" first");
    expect(BUILTIN_SPEC_PROMPT).toContain("crosses modules or workflow boundaries");
    expect(BUILTIN_SPEC_PROMPT).toContain("even when the current deliverable is only a design");
    expect(BUILTIN_SPEC_PROMPT).toContain("## Final Report");
    expect(BUILTIN_SPEC_PROMPT).toContain("相关文件 backed by actual code paths and line or symbol ranges");
    expect(BUILTIN_SPEC_PROMPT).toContain("Do not call Planner merely because a request mentions design");
    expect(BUILTIN_SPEC_PROMPT).toContain("explanations of an already-known single file");
    expect(BUILTIN_SPEC_PROMPT).toContain("do not edit source code before approval");
    expect(BUILTIN_SPEC_PROMPT).toContain("Present its plan via ask_user for explicit approval");
    expect(BUILTIN_SPEC_PROMPT).toContain("if approval is unavailable, rejected, or requests revision, pause without saving the next document");
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
    expect(BUILTIN_SPEC_TASK_DECOMPOSE_PROMPT).toContain("crossing modules or workflows");
    expect(BUILTIN_SPEC_TASK_DECOMPOSE_PROMPT).toContain("ordinary conceptual requests or explanations of a known single file");
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
