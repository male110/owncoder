import { describe, expect, it } from "vitest";
import { resolveApiFormat } from "./resolve.ts";

describe("resolveApiFormat", () => {
  it("uses an explicit openai-chat format even on an Anthropic host", () => {
    expect(
      resolveApiFormat({
        apiFormat: "openai-chat",
        baseUrl: "https://api.anthropic.com/v1",
      }),
    ).toBe("openai-chat");
  });

  it("uses an explicit anthropic-messages format on an OpenAI-compatible URL", () => {
    expect(
      resolveApiFormat({
        apiFormat: "anthropic-messages",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
    ).toBe("anthropic-messages");
  });

  it("keeps explicit anthropic-messages on any custom URL", () => {
    expect(
      resolveApiFormat({
        apiFormat: "anthropic-messages",
        baseUrl: "https://llm.internal.example/v1",
      }),
    ).toBe("anthropic-messages");
    expect(
      resolveApiFormat({
        apiFormat: "anthropic-messages",
        baseUrl: "http://127.0.0.1:8080",
      }),
    ).toBe("anthropic-messages");
  });

  it("infers anthropic-messages only for official Anthropic hosts", () => {
    expect(resolveApiFormat({ baseUrl: "https://api.anthropic.com/v1" })).toBe("anthropic-messages");
    expect(resolveApiFormat({ baseUrl: "https://proxy.anthropic.com/v1" })).toBe("anthropic-messages");
  });

  it("does not infer from model-like paths or third-party hosts that mention anthropic", () => {
    expect(resolveApiFormat({ baseUrl: "https://openrouter.ai/api/anthropic/v1" })).toBe("openai-chat");
    expect(resolveApiFormat({ baseUrl: "https://api.example.com/anthropic" })).toBe("openai-chat");
    expect(resolveApiFormat({ baseUrl: "http://127.0.0.1:11434/v1" })).toBe("openai-chat");
  });

  it("defaults missing or unknown format to openai-chat", () => {
    expect(resolveApiFormat({})).toBe("openai-chat");
    expect(resolveApiFormat({ apiFormat: "unknown" })).toBe("openai-chat");
  });
});
