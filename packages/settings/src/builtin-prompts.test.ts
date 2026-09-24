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
      /^You are the request-understanding[\s\S]*Your entire reply must be exactly one valid JSON object/,
    );
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/planning protocol, not a chat turn/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/Never write that explanation as free-form text outside JSON/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toMatch(/\u00a0/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toMatch(/Always reply/);
  });
});

