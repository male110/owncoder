import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_PROMPT, BUILTIN_SPEC_PROMPT } from "./builtin-prompts.js";
import { BUILTIN_TASK_DECOMPOSE_PROMPT } from "./task-decompose-prompt.js";

// run_script 引导已从系统提示词（spec/agent）与任务分解提示词中全部移除：
// 工具调用形式、组合规则与搜索套路随 run_script 工具描述下发（工具列表同一上下文可见），
// 系统提示词不再重复路由散文。此处锁住"不再回潮"。
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
    it("no longer carries run_script routing text", () => {
      expect(prompt).not.toContain("run_script");
      expect(prompt).not.toContain("Investigation Routing");
      expect(prompt).not.toContain("Investigation Strategy");
      expect(prompt).not.toContain("RUN_SCRIPT_EXAMPLES");
    });
  });
}

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
