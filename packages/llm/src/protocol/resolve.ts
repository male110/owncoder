import { isApiFormat, type ApiFormat } from "./types.js";

/**
 * Resolve the wire format for a model reference.
 *
 * Order:
 * 1. explicit apiFormat if it is a known enum value
 * 2. official Anthropic host only (api.anthropic.com / *.anthropic.com)
 * 3. default openai-chat
 *
 * Never infer from model name. Never infer from a URL path that merely
 * contains the word "anthropic" — many OpenAI-compatible gateways do.
 */
export function resolveApiFormat(ref: { apiFormat?: unknown; baseUrl?: string }): ApiFormat {
  if (isApiFormat(ref.apiFormat)) return ref.apiFormat;
  if (isOfficialAnthropicHost(ref.baseUrl)) return "anthropic-messages";
  return "openai-chat";
}

export function isOfficialAnthropicHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.anthropic.com" || host.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}
