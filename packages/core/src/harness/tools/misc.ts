import type { ToolContext, ToolResult, AskUserOption } from "./types.ts";
import { assertInside, cap, fail, ok, runCommand, toAbs } from "./shared.ts";

// ── NEW: Semantic Diff Tool ────────────────────────────────

export async function toolSemanticDiff(ctx: ToolContext, filePath: string, against: string): Promise<ToolResult> {
  if (!filePath) return fail("filePath required");
  const abs = toAbs(ctx.workspaceRoot, filePath);
  assertInside(ctx.workspaceRoot, abs);

  try {
    // Get git diff
    const diffCmd = `git diff ${against} -- "${filePath}"`;
    const diffResult = await runCommand(diffCmd, ctx.workspaceRoot, 30_000, ctx.signal);

    if (!diffResult.stdout.trim()) {
      return ok(`No changes in ${filePath} compared to ${against}`);
    }

    // Analyze the diff
    const analysis = analyzeDiff(diffResult.stdout, filePath);

    return ok(cap(analysis, ctx.maxOutputChars));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function analyzeDiff(diffText: string, filePath: string): string {
  const lines = diffText.split("\n");
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  const warnings: string[] = [];

  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
      const code = line.slice(1).trim();
      if (/^export\s+(default\s+)?(interface|type|class|function|const)\s+\w+/.test(code)) {
        warnings.push(`新增导出: ${code.slice(0, 80)}`);
      }
      if (/\bany\b/.test(code) && /:\s*any/.test(code)) {
        warnings.push(`使用了 any 类型: ${code.slice(0, 80)}`);
      }
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
      const code = line.slice(1).trim();
      if (/^export\s+(default\s+)?(interface|type|class|function|const)\s+\w+/.test(code)) {
        warnings.push(`⚠ 移除了导出: ${code.slice(0, 80)} — 可能破坏依赖方`);
      }
    }
    if (line.startsWith("@@")) hunks++;
  }

  const parts: string[] = [];
  parts.push(`## Semantic Diff: ${filePath}`);
  parts.push(`Changes: +${additions} -${deletions} in ${hunks} hunk(s)`);

  if (warnings.length > 0) {
    parts.push("\n### Warnings");
    warnings.forEach((w) => parts.push(`- ${w}`));
  }

  if (additions === 0 && deletions === 0) {
    parts.push("(no changes detected)");
  }

  parts.push(`\n<details><summary>Raw diff</summary>\n\n\`\`\`diff\n${diffText.slice(0, 5000)}\n\`\`\`\n</details>`);

  return parts.join("\n");
}

// ── Web Search Tool (Bing via cn.bing.com HTML scrape — reachable from CN) ──

const BING_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function absoluteHref(href: string): string {
  if (href.startsWith("//")) return "https:" + href;
  return href;
}

export async function toolWebSearch(
  ctx: ToolContext,
  query: string,
  maxResults: number,
  _language: string,
): Promise<ToolResult> {
  if (!query?.trim()) return fail("query required");

  try {
    const url = new URL("https://cn.bing.com/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(Math.max(maxResults, 1), 25)));
    url.searchParams.set("setlang", "zh-CN");

    const controller = new AbortController();
    const onAbort = () => controller.abort(ctx.signal?.reason);
    if (ctx.signal?.aborted) onAbort();
    else ctx.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 15_000);

    let html: string;
    try {
      const resp = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          "User-Agent": BING_UA,
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
      html = await resp.text();
    } finally {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", onAbort);
    }

    const items: Array<{ title: string; href: string; snippet: string }> = [];
    const block = /<li class="b_algo"[^>]*>([\s\S]*?)(?=<li class="b_algo"|<\/ol>)/gi;
    let m: RegExpExecArray | null;
    while ((m = block.exec(html))) {
      const seg = m[1] ?? "";
      let link = /<h2[^>]*>\s*<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(seg);
      if (!link) link = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(seg);
      if (!link) continue;
      const href = absoluteHref(link[1]!);
      const title = stripTags(link[2] ?? "");
      if (!title || href.startsWith("javascript:")) continue;
      const cap = /<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i.exec(seg);
      const snippet = cap
        ? stripTags(/<p[^>]*>([\s\S]*?)<\/p>/i.exec(cap[1] ?? "")?.[1] ?? "")
        : "";
      items.push({ title, href, snippet });
    }

    if (!items.length) {
      return ok(cap(`No Bing results found for "${query}". Try more specific terms.`, ctx.maxOutputChars));
    }

    const results =
      `Web search results for "${query}" (Bing):\n\n` +
      items
        .slice(0, maxResults)
        .map((it, i) => `${i + 1}. ${it.title}\n   ${it.href}${it.snippet ? "\n   " + it.snippet : ""}`)
        .join("\n\n");

    return ok(cap(results, ctx.maxOutputChars));
  } catch (e) {
    // Graceful degradation: provide useful fallback
    return ok(
      `Web search for "${query}" could not reach Bing.\n` +
      `Suggested: Check if the term appears in the codebase first using search_symbols.\n` +
      `Error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ── Web Fetch Tool (fetch a URL and return readable text content) ──

const FETCH_UA = BING_UA;
const DEFAULT_FETCH_MAX_CHARS = 50_000;
const HARD_FETCH_MAX_CHARS = 100_000;

/** Tags that never contribute readable article body. */
const NOISE_TAGS =
  "script|style|noscript|template|svg|canvas|iframe|object|embed|form|button|input|select|textarea|option|nav|header|footer|aside|menu|dialog|figure|figcaption|picture|source|link|meta|base|head";

/**
 * Class/id tokens that usually mark chrome (nav, ads, cookies, sidebars…).
 * Matched as whole tokens inside class/id attribute values.
 */
const NOISE_ATTR_RE =
  /\b(nav|navbar|navigation|menu|menubar|sidebar|side-bar|aside|footer|header|masthead|breadcrumb|breadcrumbs|pagination|pager|toolbar|cookie|cookies|consent|banner|advert|ads?|ad-|promo|sponsor|social|share|sharing|related|recommend|newsletter|subscribe|popup|modal|overlay|toc|table-of-contents|comment|comments|disqus|widget|rail|sidenav|topbar|bottombar|site-header|site-footer|page-header|page-footer)\b/i;

/** Prefer these containers when present — typical main-content landmarks. */
const MAIN_CONTAINER_RES: RegExp[] = [
  /<article\b[^>]*>([\s\S]*?)<\/article>/i,
  /<main\b[^>]*>([\s\S]*?)<\/main>/i,
  /<(?:div|section)\b[^>]*\brole\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i,
  /<(?:div|section|article)\b[^>]*(?:id|class)\s*=\s*["'][^"']*\b(?:article-body|post-content|entry-content|article-content|post-body|markdown-body|readme|content-body|main-content|page-content|article__body|post__content)\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section|article)>/i,
  /<(?:div|section)\b[^>]*\bid\s*=\s*["'](?:content|main|main-content|article|post)["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i,
];

function stripNoiseElements(html: string): string {
  let s = html;
  // Drop paired non-content / chrome tag trees (matched open/close tag name)
  s = s.replace(
    new RegExp(`<(${NOISE_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"),
    " ",
  );
  // Self-closing / void noise tags left behind
  s = s.replace(new RegExp(`<(?:${NOISE_TAGS})\\b[^>]*\\/?>`, "gi"), " ");
  // Drop elements whose class/id looks like chrome. Multi-pass so nested
  // wrappers (e.g. sidebar > ad) shrink from the inside out.
  for (let pass = 0; pass < 4; pass++) {
    const next = s.replace(
      /<(div|section|ul|ol|span|p|table|aside)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
      (full, _tag: string, attrs: string) => {
        const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
        const cls = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
        if (NOISE_ATTR_RE.test(`${id} ${cls}`)) return " ";
        return full;
      },
    );
    if (next === s) break;
    s = next;
  }
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  return s;
}

function pickMainHtml(html: string): string {
  let best = "";
  for (const re of MAIN_CONTAINER_RES) {
    const m = re.exec(html);
    if (m?.[1] && m[1].length > best.length) best = m[1];
  }
  if (best.length >= 200) return best;
  // Fall back to <body> if present
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1];
  return body && body.length > best.length ? body : best || html;
}

function normalizeReadableText(s: string): string {
  s = s.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|br|hr|blockquote|pre|td|th)[^>]*>/gi, "\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  // Strip remaining tags but keep newlines (stripTags collapses all whitespace)
  s = decodeHtmlEntities(s.replace(/<[^>]+>/g, ""));
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, i, arr) => line.length > 0 || (i > 0 && arr[i - 1]!.length > 0))
    .join("\n")
    .trim();
}

/**
 * Extract readable main text from HTML: prefer article/main containers,
 * strip nav/footer/ads/chrome, then return plain text.
 */
function htmlToReadableText(html: string): string {
  const scoped = pickMainHtml(html);
  const cleaned = stripNoiseElements(scoped);
  let text = normalizeReadableText(cleaned);
  // If aggressive scoping wiped too much, fall back to full-document clean
  if (text.length < 80) {
    text = normalizeReadableText(stripNoiseElements(html));
  }
  return text;
}

export async function toolWebFetch(
  ctx: ToolContext,
  urlStr: string,
  maxChars: number,
): Promise<ToolResult> {
  if (!urlStr?.trim()) return fail("url required");

  let parsed: URL;
  try {
    parsed = new URL(urlStr.trim());
  } catch {
    return fail(`Invalid URL: ${urlStr}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail(`Only http/https URLs are allowed (got ${parsed.protocol})`);
  }

  const limit = Math.min(
    Math.max(maxChars > 0 ? maxChars : DEFAULT_FETCH_MAX_CHARS, 1_000),
    HARD_FETCH_MAX_CHARS,
  );

  try {
    const controller = new AbortController();
    const onAbort = () => controller.abort(ctx.signal?.reason);
    if (ctx.signal?.aborted) onAbort();
    else ctx.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 20_000);

    let status = 0;
    let contentType = "";
    let body = "";
    try {
      const resp = await fetch(parsed.toString(), {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent": FETCH_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
      status = resp.status;
      contentType = resp.headers.get("content-type") ?? "";
      if (!resp.ok) {
        return fail(`HTTP ${status} fetching ${parsed.toString()}`);
      }
      // Avoid downloading huge binary payloads
      const lowerType = contentType.toLowerCase();
      if (
        lowerType &&
        !/text\/|json|xml|javascript|svg|html/i.test(lowerType) &&
        /octet-stream|image\/|audio\/|video\/|zip|pdf|wasm/i.test(lowerType)
      ) {
        return fail(`Unsupported content-type for text fetch: ${contentType}`);
      }
      body = await resp.text();
    } finally {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", onAbort);
    }

    const isHtml = /html|xml/i.test(contentType) || /^\s*</.test(body);
    const text = isHtml ? htmlToReadableText(body) : body.trim();
    if (!text) {
      return ok(cap(`Fetched ${parsed.toString()} (HTTP ${status}) but extracted no readable text.`, ctx.maxOutputChars));
    }

    const header =
      `URL content: ${parsed.toString()}\n` +
      `HTTP ${status}` +
      (contentType ? ` | ${contentType.split(";")[0]!.trim()}` : "") +
      `\n\n`;
    return ok(cap(header + text, Math.min(limit, ctx.maxOutputChars)));
  } catch (e) {
    return fail(
      `Failed to fetch ${parsed.toString()}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ── Handoff Tool ───────────────────────────────────────────

/** Reasons a turn may hand control back to the user. */
const BLOCKER_REASON_LABELS: Record<string, string> = {
  user_owned_state: "根因位于用户自有的运行态数据/配置中，不由 agent 修改",
  user_prohibited: "用户已禁止该操作，且没有获授权的替代路径",
  needs_user_decision: "需要用户做出决定（取舍 / 凭据 / 不可逆操作的批准）",
  false_premise: "任务前提与实际情况不符",
  attempts_exhausted: "多次定向尝试均失败，且没有新的假设可验证",
};

/**
 * report_blocker — pure control-flow tool. It performs no side effect; its only
 * purpose is to give the ReAct loop an explicit, compliant way to end a turn and
 * hand control back to the user. The loop intercepts the call, so the returned
 * output is only ever seen if interception is bypassed.
 */
export async function toolReportBlocker(
  _ctx: ToolContext,
  reason: string,
  summary: string,
  userAction: string,
  completed: string,
): Promise<ToolResult> {
  if (!summary.trim()) return fail("summary required: state the blocker or root cause concretely");
  if (!userAction.trim()) return fail("userAction required: state what the user must do or decide");
  return ok(
    formatBlockerReport(reason, summary, userAction, completed) +
      "\n\nHanded back to the user. Do not call any further tools this turn.",
  );
}

/** Render a blocker report for the conversation. Shared with the ReAct loop. */
export function formatBlockerReport(
  reason: string,
  summary: string,
  userAction: string,
  completed: string,
): string {
  const parts: string[] = [];
  const label = BLOCKER_REASON_LABELS[reason];
  parts.push(label ? `**已交还给你**（${label}）` : "**已交还给你**");
  parts.push(`\n**原因**\n${summary.trim()}`);
  parts.push(`\n**需要你处理**\n${userAction.trim()}`);
  if (completed.trim()) parts.push(`\n**已完成并验证**\n${completed.trim()}`);
  return parts.join("\n");
}

// ── Ask User Tool ─────────────────────────────────────────

/**
 * ask_user — blocks the turn while the user answers a question.
 *
 * The implementation only forwards the structured request to the host-supplied
 * `ctx.askUser` (which round-trips to the UI). When no host bridge is wired the
 * call fails explicitly rather than silently returning a guess, so the model
 * learns the tool is unavailable instead of acting on a fabricated answer.
 */
export async function toolAskUser(
  ctx: ToolContext,
  question: string,
  options: AskUserOption[],
  allowFreeText: boolean,
  placeholder: string,
): Promise<ToolResult> {
  if (!question.trim()) return fail("question required: state what you need the user to decide");
  if (!ctx.askUser) return fail("ask_user is not available in this context; state the question in your reply instead");
  const cleanOptions = Array.isArray(options)
    ? options.filter((o) => o && o.label && o.value).map((o) => ({ label: o.label, value: o.value, description: o.description }))
    : [];
  if (cleanOptions.length === 0 && !allowFreeText) {
    return fail("provide at least one option, or set allowFreeText=true for an open-ended answer");
  }
  // When fixed options are present, always also offer free-text input so the
  // user is never limited to the predefined choices (e.g. options 1/2/3).
  const freeTextEnabled = allowFreeText || cleanOptions.length > 0;
  try {
    const answer = await ctx.askUser({
      question: question.trim(),
      options: cleanOptions,
      allowFreeText: freeTextEnabled,
      placeholder: placeholder || (freeTextEnabled && cleanOptions.length > 0 ? "或输入自定义回答…" : undefined),
    });
    return ok(answer && answer.trim() ? answer.trim() : "(用户未提供回答)");
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
