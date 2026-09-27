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

  it("仅在上下文不足且需要历史信息时允许检索历史", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/## Historical Context/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/current context is insufficient/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/relevant to planning/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/functions\.recall_history_for_task_decompose/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toMatch(/(?<!functions\.)`recall_history`/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/Prefer the supplied context whenever it is sufficient/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toMatch(/## Available Tools/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toMatch(/web_search|search_symbols|code-map|file reading|file modification|testing/);
  });

  it("把 continue/继续 理解为完成最近一次任务分解的全部剩余任务，而不是只完成某个 step", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(
      /If the user says continue, 继续, or similar resume wording, treat it as a request to complete every remaining task from the most recent task decomposition — not to finish only a previous step/,
    );
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(
      /the work needed this turn is every remaining task from the most recent task decomposition — include all of those tasks in `tasks`, not a single leftover step/,
    );
  });

  it("把 task 定义为独立目标，并要求步骤保持抽象且不提前写入探索结果", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/`tasks` represents one or more independent, user-deliverable goals/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/Steps are abstract, ordered actions or phases/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/execution happens later/);
  });

  it("要求 relevantHistory 精简但完整，覆盖当前任务所需上下文", () => {
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/Extract concise but complete task-relevant context/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/into the `relevantHistory` field/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/all information that may be needed to execute or verify this task/);
    for (const item of [
      "confirmed requirements and constraints",
      "decisions",
      "assumptions",
      "prior instructions",
      "progress",
      "reusable results",
      "outstanding questions",
      "blockers",
      "dependencies",
      "relevant files",
    ]) {
      expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toContain(item);
    }
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/not only these examples/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/tasks\[\]\.userConstraints/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/tasks\[\]\.relevantHistory/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/tasks\[\]\.progressStatus/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).toMatch(/return exactly one task/);
    expect(BUILTIN_TASK_DECOMPOSE_PROMPT).not.toMatch(/"intent": string/);
  });
});

