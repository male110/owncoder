import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatCompletion, chatCompletionStream } from "@owncoder/llm";
import { BUILTIN_WORKFLOW, type ModelRef } from "@owncoder/settings";
import { closeConversationStore } from "../../conversation-store.ts";
import { savePlannerPlan } from "../../plans.ts";
import { readSpecPhase, saveSpec, writeFeatureState } from "../../specs.ts";
import { BudgetLedger } from "../budget-ledger.ts";
import { runAgentLoop } from "../loop.ts";
import { classifySpecDesignIntent, classifySpecRequirementsIntent } from "./spec-design-intent.ts";
import type { AgentLoopOpts } from "./types.ts";

vi.mock("@owncoder/llm", async (original) => ({
  ...await original<typeof import("@owncoder/llm")>(),
  chatCompletion: vi.fn(), chatCompletionStream: vi.fn(), writeEventLog: vi.fn(),
}));
vi.mock("../../turn-rounds.ts", async (original) => ({
  ...await original<typeof import("../../turn-rounds.ts")>(),
  persistRoundReport: vi.fn(async () => null), persistRoundToolCalls: vi.fn(async () => undefined),
}));
const complete = vi.mocked(chatCompletion);
const model = {} as ModelRef;
const opts = { sessionId: "s1", history: [], budget: new BudgetLedger() };

function reply(content: string) {
  return { choices: [{ message: { content } }] } as Awaited<ReturnType<typeof chatCompletion>>;
}

beforeEach(() => complete.mockReset());

describe("Spec design intent routing", () => {
  it.each([
    ["架构就按这版，帮我拆一下实施工作吧", "generate_tasks"],
    ["The proposal looks good. Break it down into implementation work.", "generate_tasks"],
    ["先把权限模型改完，再列任务", "revise_design"],
    ["接下来会做什么？", "discuss_or_clarify"],
    ["先别列任务，我还在看", "discuss_or_clarify"],
  ] as const)("routes the model's intent for %s", async (text, intent) => {
    complete.mockResolvedValueOnce(reply(JSON.stringify({ intent })));
    expect(await classifySpecDesignIntent({ ...opts, userMessage: text }, model, "login")).toBe(intent);
    expect(complete).toHaveBeenCalledOnce();
    const [, messages, callOptions] = complete.mock.calls[0]!;
    expect(JSON.parse(String(messages[1]?.content))).toMatchObject({ currentFeature: "login", latestUserMessage: text });
    expect(callOptions?.tools).toBeUndefined();
  });

  it("keeps old requests separate from the latest user instruction", async () => {
    complete.mockResolvedValueOnce(reply('{"intent":"discuss_or_clarify"}'));
    const history = [{ role: "user" as const, content: "生成任务" }];
    const latest = "我改主意了，先不要生成";
    expect(await classifySpecDesignIntent({ ...opts, history, userMessage: latest }, model, "login")).toBe("discuss_or_clarify");
    const messages = complete.mock.calls[0]![1];
    expect(messages[0]?.content).toContain("never override the latest message");
    expect(JSON.parse(String(messages[1]?.content))).toMatchObject({ history, latestUserMessage: latest });
  });

  it.each(["generate_tasks", '{"intent":"approve_tasks"}', '{"intent":"generate_tasks","feature":"other"}', "not JSON"])("fails closed for %s", async (output) => {
    complete.mockResolvedValueOnce(reply(output));
    expect(await classifySpecDesignIntent({ ...opts, userMessage: "下一步" }, model, "login")).toBe("discuss_or_clarify");
  });

  it("does not authorize when the model call fails or the request is cancelled", async () => {
    complete.mockRejectedValueOnce(new Error("provider unavailable"));
    expect(await classifySpecDesignIntent({ ...opts, userMessage: "继续" }, model, "login")).toBe("discuss_or_clarify");
    const abort = new AbortController();
    complete.mockImplementationOnce(async () => {
      abort.abort();
      return reply('{"intent":"generate_tasks"}');
    });
    expect(await classifySpecDesignIntent({ ...opts, userMessage: "继续", signal: abort.signal }, model, "login")).toBe("discuss_or_clarify");
  });
});

it.each([
  ["需求就这些，按这个范围把架构方案写出来", "generate_design"],
  ["Before moving on, drop the reporting requirement", "revise_requirements"],
  ["What would the design phase cover?", "discuss_or_clarify"],
  ["先不要写设计", "discuss_or_clarify"],
] as const)("routes requirements review in natural language: %s", async (userMessage, intent) => {
  complete.mockResolvedValueOnce(reply(JSON.stringify({ intent })));
  expect(await classifySpecRequirementsIntent({ ...opts, userMessage }, model, "login")).toBe(intent);
  expect(complete.mock.calls[0]?.[2]?.purpose).toBe("spec_requirements_intent");
});

describe("Spec review through the harness", () => {
  const stream = vi.mocked(chatCompletionStream);
  const sessionId = "spec-review";
  const feature = "login";
  const requirements = "# Login requirements\n\nR1: Users can sign in.";
  const design = "# Login design\n\n- R1: Validate credentials in the sign-in handler.";
  let root: string;

  beforeEach(async () => {
    stream.mockReset();
    root = await fs.mkdtemp(join(tmpdir(), "owncoder-spec-review-"));
  });
  afterEach(async () => {
    closeConversationStore(root, sessionId);
    await fs.rm(root, { recursive: true, force: true });
  });

  function options(userMessage: string): AgentLoopOpts {
    return {
      mode: "spec", sessionId, workspaceRoot: root, currentFeature: feature, userMessage,
      workflow: BUILTIN_WORKFLOW, history: [], leanPipeline: true,
      index: {} as AgentLoopOpts["index"], llmApiKey: "test-key", maxIterations: 1,
      persistExperiencesOverride: async () => [], askUser: vi.fn(),
    };
  }

  function saveFromModel(name: string, content: string) {
    stream.mockResolvedValueOnce({ choices: [{ message: {
      content: "", tool_calls: [{ id: "save", type: "function", function: { name, arguments: JSON.stringify({ feature, content }) } }],
    } }] } as Awaited<ReturnType<typeof chatCompletionStream>>);
  }

  function offeredSaves() {
    return stream.mock.calls.at(-1)?.[2]?.tools?.map((tool) => tool.function.name).filter((name) =>
      ["save_spec", "save_design", "save_tasks"].includes(name));
  }

  it.each(["awaiting_spec_approval", "spec_approved"] as const)("continues from %s, then offers only the task-list save", async (stage) => {
    await saveSpec(root, feature, requirements, sessionId);
    await writeFeatureState(root, feature, stage, sessionId);
    await savePlannerPlan(root, sessionId, "spec", "# Old read-only plan");
    complete.mockResolvedValueOnce(reply('{"intent":"generate_design"}'));
    saveFromModel("save_design", design);
    const first = options("请按这版需求写技术方案");
    await runAgentLoop(first);
    expect(offeredSaves()).toEqual(["save_design"]);
    expect(first.askUser).not.toHaveBeenCalled();
    expect(await readSpecPhase(root, feature, "design", sessionId)).toContain(design);

    stream.mockReset();
    complete.mockResolvedValueOnce(reply('{"intent":"generate_tasks"}'));
    saveFromModel("save_tasks", [
      "# Tasks", "- [ ] Implement login", "  - 依赖: none", "  - 文件: auth.ts",
      "  - 实现: Validate credentials", "  - 验收: Test sign-in", "  - 需求: R1",
    ].join("\n"));
    const result = await runAgentLoop(options("Break the proposal into implementation work"));
    expect(offeredSaves()).toEqual(["save_tasks"]);
    expect(result.assistantText).toContain("全部执行");
    expect(await readSpecPhase(root, feature, "tasks", sessionId)).toContain("Implement login");
  });

  it.each(["revise_requirements", "discuss_or_clarify", "generate_design"] as const)("limits writes for %s", async (intent) => {
    await saveSpec(root, feature, requirements, sessionId);
    await writeFeatureState(root, feature, "awaiting_spec_approval", sessionId);
    const revised = `${requirements}\n\nR2: Users can sign out.`;
    complete.mockImplementationOnce(async () => {
      if (intent === "generate_design") await saveSpec(root, feature, revised, sessionId);
      return reply(JSON.stringify({ intent }));
    });
    saveFromModel(intent === "revise_requirements" ? "save_spec" : "save_design", intent === "revise_requirements" ? revised : design);
    await runAgentLoop(options("Follow up on the requirements"));
    expect(offeredSaves()).toEqual(intent === "revise_requirements" ? ["save_spec"] : intent === "generate_design" ? ["save_design"] : []);
    await expect(readSpecPhase(root, feature, "design", sessionId)).rejects.toThrow();
    expect(await readSpecPhase(root, feature, "spec", sessionId)).toContain(intent === "discuss_or_clarify" ? requirements : revised);
  });
});
