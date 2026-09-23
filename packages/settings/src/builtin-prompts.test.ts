import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENT_PROMPT,
  BUILTIN_PLAN_PROMPT,
  ensureWebSearchGuidance,
} from "./builtin-prompts.js";
import { BUILTIN_WORKFLOW, mergeWorkflow } from "./index.js";

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

