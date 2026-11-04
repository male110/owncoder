import type { ToolDef } from "@owncoder/llm";

// ── Web Search Tool ───────────────────────────────────────

export const WEB_SEARCH_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: true,
  function: {
    name: "web_search",
    description:
      "Search the web. Use this proactively when you do not know something or are stuck: " +
      "unfamiliar errors, missing API/docs, library behavior, version-specific details, " +
      "or after one local retry still fails. Do not guess — search first, then web_fetch " +
      "the best official/source URL. Also use for latest documentation and current facts.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Be specific, include version numbers or dates if relevant.",
        },
        maxResults: {
          type: "integer",
          description: "Maximum number of results (default 5, max 10)",
        },
        language: {
          type: "string",
          description: "Preferred language (e.g., zh-CN, en-US)",
        },
      },
      required: ["query"],
    },
  },
};

export const WEB_FETCH_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: true,
  function: {
    name: "web_fetch",
    description:
      "Fetch a URL and return its main readable text (article/body only). Strips navigation, " +
      "headers, footers, ads, sidebars, scripts and other chrome. For CSR/SPA pages the host " +
      "Electron renderer may be used as a fallback to obtain post-JS content. Use when the user " +
      "provides a specific webpage URL and you need to read the page (docs, articles, API " +
      "references, GitHub pages, etc.). Prefer this over web_search when you already have the exact URL.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full http(s) URL to fetch",
        },
        maxChars: {
          type: "integer",
          description: "Max characters of extracted text to return (default 50000, max 100000)",
        },
      },
      required: ["url"],
    },
  },
};
