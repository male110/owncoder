import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENT_PROMPT,
  BUILTIN_PLAN_PROMPT,
  ensureWebSearchGuidance,
} from "./builtin-prompts.js";
import { BUILTIN_WORKFLOW, mergeWorkflow } from "./index.js";
import { BUILTIN_TASK_DECOMPOSE_PROMPT } from "./task-decompose-prompt.js";

describe("web search prompt guidance", () => {
  it("puts web_search in the agent and plan loops before Stop", () => {
    for (const prompt of [BUILTIN_AGENT_PROMPT, BUILTIN_PLAN_PROMPT]) {
      const loop = prompt.split("## Loop")[1]?.split("## ")[0] ?? "";
      expect(loop).toMatch(/web_search/);
      expect(loop.indexOf("web_search")).toBeLessThan(loop.indexOf("**Stop**"));
    }
  });

  it("requires exact named identifiers before semantic search", () => {
    for (const prompt of [BUILTIN_AGENT_PROMPT, BUILTIN_PLAN_PROMPT]) {
      expect(prompt).toMatch(/## Code location/);
      expect(prompt).toMatch(/verbatim/);
      expect(prompt).toMatch(/container first/i);
      expect(prompt).toMatch(/semantic\/code-map search|semantic rewrite/);
    }
  });

  it("appends guidance when a saved prompt never mentions web_search", () => {
    const saved = "# Agent Mode — OwnCode\nMake precise edits. Avoid redundant reads.";
    const out = ensureWebSearchGuidance(saved);
    expect(out).toContain("web_search");
    expect(out.startsWith(saved)).toBe(true);
  });

  it("does not duplicate guidance when web_search is already present", () => {
    expect(ensureWebSearchGuidance(BUILTIN_AGENT_PROMPT)).toBe(BUILTIN_AGENT_PROMPT);
  });

  it("injects web_search into saved overlays that omit it", () => {
    const merged = mergeWorkflow(BUILTIN_WORKFLOW, {
      version: 2,
      prompts: { agent: "# Agent Mode — OwnCode\nEdit code.", plan: "# Plan Mode — OwnCode\nWrite a plan." },
    });
    expect(merged.prompts.agent).toMatch(/web_search/);
    expect(merged.prompts.plan).toMatch(/web_search/);
  });
});

describe("task decompose prompt JSON contract", () => {
  it("把 JSON-only 契约放在开篇，且示例不含 NBSP", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(
      /^You are the request-understanding[\s\S]*Produce only one valid JSON object/,
    );
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/planning protocol, not chat/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/Explanations must live inside JSON, never as free text outside/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toMatch(/\u00a0/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toMatch(/Always reply/);
  });

  it("要求从上下文提取 relevantHistory，并区分整单与步骤级", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/## Relevant History/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/Extract task-relevant history into `relevantHistory`/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/original goal and scope/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/user requirements and prohibitions/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/key decisions and their reasons/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/files \/ symbols \/ modules \/ docs already inspected or modified/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/conclusions from prior code reading/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/failed attempts and known errors/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/Distinguish confirmed facts from assumptions/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/do not copy conversation or source code/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(
      /Top-level `relevantHistory` stores history reusable across the whole plan/,
    );
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(
      /step-level `relevantHistory` stores history needed only by that step/,
    );
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/Empty string when there is no relevant task history/);
  });

  it("把 continue/继续 理解为完成最近一次任务分解的全部剩余任务，而不是只完成某个 step", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(
      /If the user says continue, 继续, or similar resume wording, treat it as a request to complete every remaining task from the most recent task decomposition — not to finish only a previous step/,
    );
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(
      /the work needed this turn is every remaining task from the most recent task decomposition — include all of those tasks in `tasks`, not a single leftover step/,
    );
  });
});

