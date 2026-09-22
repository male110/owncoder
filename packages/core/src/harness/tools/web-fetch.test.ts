import assert from "node:assert/strict";
import { test } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import type { IndexClient } from "@owncoder/index";
import { looksLikeCsrShell, toolWebFetch } from "./misc.ts";
import type { ToolContext } from "./types.ts";

function stubIndex(): IndexClient {
  return {
    async open() {},
    async getTags() {
      return [];
    },
    async buildRepoMap() {
      return "";
    },
    invalidate() {},
    async rebuildAll() {},
    status() {
      return { kind: "ready", fileCount: 0, tagCount: 0 };
    },
  };
}

function makeCtx(partial: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    mode: "agent",
    workflow: BUILTIN_WORKFLOW,
    index: stubIndex(),
    readSet: new Set(),
    maxOutputChars: 24_000,
    bashMaxChars: 10_000,
    ...partial,
  };
}

test("looksLikeCsrShell detects #app mount with little text", () => {
  const html = `<!doctype html><html><body><div id="app"></div><script src="/app.js"></script><script src="/vendor.js"></script><script src="/chunk.js"></script></body></html>`;
  assert.equal(looksLikeCsrShell(html, ""), true);
});

test("looksLikeCsrShell rejects pages with substantial readable text", () => {
  const body = "A".repeat(250);
  const html = `<html><body><article>${body}</article></body></html>`;
  assert.equal(looksLikeCsrShell(html, body), false);
});

test("toolWebFetch uses renderPage when static HTML is a CSR shell", async () => {
  const article =
    "MiniMax Code CLI 发布说明：这是一篇足够长的正文，用来验证渲染回退能拿到 CSR 页面内容。" +
    "更多细节包括安装方式、命令行参数与常见问题解答。";
  const staticHtml = `<!doctype html><html><head><title>x</title></head><body><div id="app"></div><script src="a.js"></script><script src="b.js"></script><script src="c.js"></script></body></html>`;
  const renderedHtml = `<!doctype html><html><body><article><h1>MiniMax</h1><p>${article}</p></article></body></html>`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(staticHtml, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as typeof fetch;

  try {
    let renderedUrl = "";
    const ctx = makeCtx({
      renderPage: async (url) => {
        renderedUrl = url;
        return { html: renderedHtml, text: article };
      },
    });
    const result = await toolWebFetch(ctx, "https://www.oschina.net/news/502619/minimax-code-cli", 50_000);
    assert.equal(result.ok, true);
    assert.match(result.output, /rendered/);
    assert.match(result.output, /MiniMax/);
    assert.equal(renderedUrl, "https://www.oschina.net/news/502619/minimax-code-cli");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("toolWebFetch keeps static content when renderPage fails", async () => {
  const staticHtml = `<!doctype html><html><body><div id="app"></div><script src="a.js"></script><script src="b.js"></script><script src="c.js"></script></body></html>`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(staticHtml, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as typeof fetch;

  try {
    const ctx = makeCtx({
      renderPage: async () => {
        throw new Error("boom");
      },
    });
    const result = await toolWebFetch(ctx, "https://example.com/spa", 50_000);
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.output, /rendered/);
    assert.match(result.output, /id="app"|<div id="app"/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
