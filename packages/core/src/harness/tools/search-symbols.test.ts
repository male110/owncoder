/**
 * search_symbols 符号索引单元测试。
 *
 * 锁住的语义：仅使用 FTS 符号索引，空结果回退精确名称 grep，不混入语义向量召回。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IndexClient, SymbolSearchResult } from "@owncoder/index";
import { toolSearchSymbols } from "./search-symbols.ts";
import { toolGrep } from "./grep.ts";

vi.mock("./grep.ts", () => ({ toolGrep: vi.fn() }));

function sym(path: string, name: string, kind = "function", line = 12): SymbolSearchResult {
  return { path, name, kind, line, signature: "(x: number)", score: 0.9 };
}

function ctxWith(index: object): Parameters<typeof toolSearchSymbols>[0] {
  return { index, maxOutputChars: 8000 } as unknown as Parameters<typeof toolSearchSymbols>[0];
}

describe("toolSearchSymbols — symbols", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("仅返回符号索引命中，不调用语义检索", async () => {
    const ragSearch = vi.fn(async () => { throw new Error("must not call rag"); });
    const index = {
      ftsSearch: vi.fn(async () => [sym("src/user.ts", "UserService", "class")]),
      ragSearch,
    } as unknown as IndexClient;
    const result = await toolSearchSymbols(ctxWith(index), "UserService", 20);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Found 1 symbol results");
    expect(result.output).toContain("**class** `UserService`");
    expect(ragSearch).not.toHaveBeenCalled();
  });

  it("无语义端口不影响符号搜索", async () => {
    const index = { ftsSearch: vi.fn(async () => [sym("src/a.ts", "foo")]) } as unknown as IndexClient;
    const result = await toolSearchSymbols(ctxWith(index), "foo", 20);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Found 1 symbol results");
  });

  it("FTS 未命中走精确名称回退", async () => {
    const index = { ftsSearch: vi.fn(async () => []) } as unknown as IndexClient;
    vi.mocked(toolGrep).mockResolvedValue({ ok: true, output: "src/auth.ts:42:validateToken" });
    const result = await toolSearchSymbols(ctxWith(index), "validateToken", 20);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("index fallback");
  });

  it("索引无结果 → grep 精确名回退", async () => {
    const index = { ftsSearch: vi.fn(async () => []) } as unknown as IndexClient;
    vi.mocked(toolGrep).mockResolvedValue({ ok: true, output: "src/x.ts:7:function missing" });
    const result = await toolSearchSymbols(ctxWith(index), "missing", 20);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("index fallback");
    expect(result.output).toContain("src/x.ts:7:function missing");
    expect(toolGrep).toHaveBeenCalledWith(expect.anything(), "\\bmissing\\b", ".", 30);
  });

  it("limit 对符号结果生效", async () => {
    const index = { ftsSearch: vi.fn(async () => [sym("src/a.ts", "a"), sym("src/b.ts", "b")]) } as unknown as IndexClient;
    const result = await toolSearchSymbols(ctxWith(index), "a", 1);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Found 1 symbol results");
  });

  it("FTS 异常仍回退到精确名称搜索", async () => {
    const index = { ftsSearch: vi.fn(async () => { throw new Error("corrupt"); }) } as unknown as IndexClient;
    vi.mocked(toolGrep).mockResolvedValue({ ok: true, output: "src/a.ts:1:foo" });
    const result = await toolSearchSymbols(ctxWith(index), "foo", 20);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("index fallback");
  });

  it("空查询 → fail", async () => {
    const result = await toolSearchSymbols(ctxWith({}), "  ", 20);
    expect(result.ok).toBe(false);
  });
});
