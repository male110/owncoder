/**
 * Ensure base ends with `/` so `new URL(relative, base)` appends a path segment
 * instead of replacing the last segment.
 */
export function ensureTrailingSlash(base: string): string {
  return base.endsWith("/") ? base : `${base}/`;
}

/** Path already ends with a version segment like `/v1` or `/v2/` (case-insensitive). */
function endsWithVersionSegment(base: string): boolean {
  const raw = base.trim();
  try {
    return /\/v\d+\/?$/i.test(new URL(raw).pathname);
  } catch {
    return /\/v\d+\/?$/i.test(raw);
  }
}

/**
 * Normalize LLM API base URL before joining protocol paths
 * (`messages`, `chat/completions`, `models`, …):
 * - if path already ends with `/v` + digits → keep as-is (no double `/v1`)
 * - otherwise append `/v1`
 * Always returns with a trailing slash for safe relative URL joining.
 *
 * @example
 * normalizeApiBaseUrl("https://api.anthropic.com")     // → ".../v1/"
 * normalizeApiBaseUrl("https://api.anthropic.com/v1")  // → ".../v1/"
 * normalizeApiBaseUrl("https://proxy.example/anthropic") // → ".../anthropic/v1/"
 */
export function normalizeApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return ensureTrailingSlash(trimmed);

  if (endsWithVersionSegment(trimmed)) {
    return ensureTrailingSlash(trimmed.replace(/\/+$/, ""));
  }
  return ensureTrailingSlash(`${trimmed.replace(/\/+$/, "")}/v1`);
}
