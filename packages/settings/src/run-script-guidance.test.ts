import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_PROMPT, BUILTIN_SPEC_PROMPT } from "./builtin-prompts.js";
import { BUILTIN_TASK_DECOMPOSE_PROMPT } from "./task-decompose-prompt.js";

// run_script 引导已从系统提示词（spec/agent）与任务分解提示词中全部移除：
// 工具调用形式、组合规则与搜索套路随 run_script 工具描述下发（工具列表同一上下文可见），
// 系统提示词不再重复路由散文。此处锁住"不再回潮"。
describe("Agent evidence-first discipline", () => {
  it("uses short deterministic rules instead of exploration prose", () => {
    expect(BUILTIN_AGENT_PROMPT).toContain("## Evidence-first execution discipline");
    expect(BUILTIN_AGENT_PROMPT).toMatch(/exact file\/range/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/fresh evidence/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/Stop exploration/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/Most tasks require tools/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/not an absolute requirement/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/follow the current codebase's existing code style/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/single responsibility/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/Prefer reusing existing code or mature third-party solutions/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/unless the user explicitly asks/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/concise, clear comments/i);
    expect(BUILTIN_AGENT_PROMPT).toMatch(/Map types, document what the keys and values each represent/i);
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
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("use tools to search for or locate");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain("Do not prescribe a search command, search method, search scope or starting directory");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toContain("rg --files");
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toContain("先在仓库根目录");
  });
});
