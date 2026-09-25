/**
 * Ensure base ends with `/` so `new URL(relative, base)` appends a path segment
 * instead of replacing the last segment.
 */
export function ensureTrailingSlash(base: string): string {
  return base.endsWith("/") ? base : `${base}/`;
}


/**
 * Normalize LLM API base URL before joining protocol paths
 * (`messages`, `chat/completions`, `models`, …):
 * Always returns with a trailing slash for safe relative URL joining.
 *
 * @example
 * normalizeApiBaseUrl("https://api.anthropic.com")     // → "https://api.anthropic.com/"
 * normalizeApiBaseUrl("https://api.anthropic.com/v1")  // → "https://api.anthropic.com/v1/"
 * normalizeApiBaseUrl("https://proxy.example/anthropic") // → "https://proxy.example/anthropic/"
 */
export function normalizeApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return ensureTrailingSlash(trimmed.replace(/\/+$/, ""));
}
