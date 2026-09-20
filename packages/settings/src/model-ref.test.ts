import { describe, expect, it } from "vitest";
import { BUILTIN_WORKFLOW, getActiveModelRef, SystemWorkflowConfigSchema } from "./index.ts";

describe("getActiveModelRef apiFormat", () => {
  it("defaults missing provider apiFormat to openai-chat", () => {
    const config = {
      ...BUILTIN_WORKFLOW,
      providers: [
        {
          id: "p1",
          name: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "sk-or",
          models: [{ id: "p1_claude", name: "claude-sonnet-4" }],
        },
      ],
      selectedModels: [{ id: "p1_claude", name: "claude-sonnet-4", providerId: "p1" }],
    };
    const ref = getActiveModelRef(config);
    expect(ref.apiFormat).toBe("openai-chat");
    expect(ref.model).toBe("claude-sonnet-4");
    expect(ref.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("passes explicit anthropic-messages through to ModelRef", () => {
    const config = {
      ...BUILTIN_WORKFLOW,
      providers: [
        {
          id: "p1",
          name: "Anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "sk-ant",
          apiFormat: "anthropic-messages" as const,
          models: [{ id: "p1_claude", name: "claude-sonnet-4" }],
        },
      ],
      selectedModels: [{ id: "p1_claude", name: "claude-sonnet-4", providerId: "p1" }],
    };
    expect(getActiveModelRef(config).apiFormat).toBe("anthropic-messages");
  });

  it("keeps explicit anthropic-messages on a custom URL", () => {
    const config = {
      ...BUILTIN_WORKFLOW,
      providers: [
        {
          id: "p1",
          name: "Self-hosted Claude",
          baseUrl: "https://llm.internal.example/v1",
          apiKey: "sk-ant",
          apiFormat: "anthropic-messages" as const,
          models: [{ id: "p1_claude", name: "claude-sonnet-4" }],
        },
      ],
      selectedModels: [{ id: "p1_claude", name: "claude-sonnet-4", providerId: "p1" }],
    };
    const ref = getActiveModelRef(config);
    expect(ref.apiFormat).toBe("anthropic-messages");
    expect(ref.baseUrl).toBe("https://llm.internal.example/v1");
  });

  it("infers anthropic-messages from official host when apiFormat is omitted", () => {
    const config = {
      ...BUILTIN_WORKFLOW,
      providers: [
        {
          id: "p1",
          name: "Anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "sk-ant",
          models: [{ id: "p1_claude", name: "claude-sonnet-4" }],
        },
      ],
      selectedModels: [{ id: "p1_claude", name: "claude-sonnet-4", providerId: "p1" }],
    };
    expect(getActiveModelRef(config).apiFormat).toBe("anthropic-messages");
  });

  it("accepts a provider without apiFormat in schema parse (legacy models.json)", () => {
    const parsed = SystemWorkflowConfigSchema.parse({
      ...BUILTIN_WORKFLOW,
      providers: [
        {
          id: "legacy",
          name: "Ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKey: "",
          models: [],
        },
      ],
    });
    expect(parsed.providers[0]?.apiFormat).toBeUndefined();
  });
});
