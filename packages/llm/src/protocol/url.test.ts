import { describe, expect, it } from "vitest";
import { ensureTrailingSlash, normalizeApiBaseUrl } from "./url.ts";

describe("ensureTrailingSlash", () => {
  it("appends slash only when missing", () => {
    expect(ensureTrailingSlash("https://a.example/v1")).toBe("https://a.example/v1/");
    expect(ensureTrailingSlash("https://a.example/v1/")).toBe("https://a.example/v1/");
  });
});

describe("normalizeApiBaseUrl", () => {
  it("appends /v1 when base has no version segment", () => {
    expect(normalizeApiBaseUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/");
    expect(normalizeApiBaseUrl("https://api.anthropic.com/")).toBe("https://api.anthropic.com/v1/");
    expect(normalizeApiBaseUrl("http://127.0.0.1:8080/anthropic")).toBe(
      "http://127.0.0.1:8080/anthropic/v1/",
    );
    expect(normalizeApiBaseUrl("https://gateway.example.com/claude")).toBe(
      "https://gateway.example.com/claude/v1/",
    );
  });

  it("does not double /v1 when base already ends with /v + digits", () => {
    expect(normalizeApiBaseUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1/");
    expect(normalizeApiBaseUrl("https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com/v1/");
    expect(normalizeApiBaseUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1/");
    expect(normalizeApiBaseUrl("https://gateway.example.com/claude/v1")).toBe(
      "https://gateway.example.com/claude/v1/",
    );
    expect(normalizeApiBaseUrl("https://example.com/api/v2")).toBe("https://example.com/api/v2/");
  });
});
