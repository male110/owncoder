/**
 * search_symbols 双路混合（hybrid）单元测试。
 *
 * 锁住的语义：
 * - FTS 精确命中排前，语义命中按文件去重补位并标注 semantic match
 * - 计数行正确（exact / semantic 分列）
 * - 单路缺失/抛错不拖垮另一路；双路皆空走 grep 回退
 * - limit 上限对总数生效
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IndexClient, RagHit, SymbolSearchResult } from "@owncoder/index";
import { toolSearchSymbols } from "./search-symbols.ts";
import { toolGrep } from "./grep.ts";

vi.mock("./grep.ts", () => ({ toolGrep: vi.fn() }));

function sym(path: string, name: string, kind = "function", line = 12): SymbolSearchResult {
  return { path, name, kind, line, signature: "(x: number)", score: 0.9 };
}

function rag(filePath: string, symbol: string, startLine: number, endLine: number, content: string): RagHit {
  return {
    chunkId: `${filePath}:${startLine}`,
    filePath,
    symbol,
    content,
    startLine,
    endLine,
    language: "typescript",
    score: 0.8,
    semanticScore: 0.8,
  };
}

function ctxWith(index: object): Parameters<typeof toolSearchSymbols>[0] {
  return { index, maxOutputChars: 8000 } as unknown as Parameters<typeof toolSearchSymbols>[0];
}

describe("toolSearchSymbols — hybrid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("FTS 命中排前，语义命中补位未覆盖文件并标注 semantic match", async () => {
    const index = {
      ftsSearch: vi.fn(async () => [sym("src/user.ts", "UserService", "class")]),
      ragSearch: vi.fn(async () => [
        rag("src/auth.ts", "validateToken", 42, 60, "validateToken\nexport function validateToken(t: string): boolean"),
        // 同一文件已被 FTS 覆盖 → 不重复
        rag("src/user.ts", "login", 5, 9, "login\nfunction login()"),
      ]),
    } as unknown as IndexClient;
    const result = await toolSearchSymbols(ctxWith(index), "UserService", 20);
    expect(result.ok).toBe(true);
    const out = result.output;
    expect(out).toContain("Found 2 results (1 exact, 1 semantic)");
    expect(out).toContain("**class** `UserService`");
    // 语义块：未覆盖文件、带区间行号与签名预览
    expect(out).toContain("**semantic match** `validateToken`");
    expect(out).toContain("src/auth.ts:42-60");
    expect(out).toContain("export function validateToken(t: string)");
    // FTS 已覆盖的文件不进语义段
    expect(out).not.toContain("`login`");
    expect(index.ragSearch).toHaveBeenCalledWith("UserService", 16);
  });

  it("无 ragSearch（CLI 无语义端口）→ 纯 FTS，无语义段", async () => {
    const index = {
      ftsSearch: vi.fn(async () => [sym("src/a.ts", "foo")]),
    } as unknown as IndexClient;
    const result = await toolSearchSymbols(ctxWith(index), "foo", 20);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Found 1 results (1 exact, 0 semantic)");
    expect(result.output).not.toContain("Semantic matches");
  });

  it("FTS 未命中但语义路有结果 → 语义命中直出", async () => {
    const index = {
      ftsSearch: vi.fn(async () => []),
      ragSearch: vi.fn(async () => [rag("src/auth.ts", "validateToken", 42, 60, "validateToken\nexport function validateToken(t: string): boolean")]),
    } as unknown as IndexClient;
    const result = await toolSearchSymbols(ctxWith(index), "登录 token 怎么校验", 20);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("**semantic match**");
    expect(result.output).toContain("src/auth.ts:42-60");
  });

  it("单路抛错不拖垮另一路", async () => {
    const index = {
      ftsSearch: vi.fn(async () => { throw new Error("fts corrupt"); }),
      ragSearch: vi.fn(async () => [rag("src/b.ts", "bar", 3, 9, "bar\nfunction bar()")]),
    } as unknown as IndexClient;
    const result = await toolSearchSymbols(ctxWith(index), "bar", 20);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("**semantic match** `bar`");
  });

  it("双路皆空 → grep 精确名回退", async () => {
    const index = {
      ftsSearch: vi.fn(async () => []),
      ragSearch: vi.fn(async () => []),
    } as unknown as IndexClient;
    vi.mocked(toolGrep).mockResolvedValue({ ok: true, output: "src/x.ts:7:function missing" });
    const result = await toolSearchSymbols(ctxWith(index), "missing", 20);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("index fallback");
    expect(result.output).toContain("src/x.ts:7:function missing");
    expect(toolGrep).toHaveBeenCalledWith(expect.anything(), "\\bmissing\\b", ".", 30);
  });

  it("limit 对总数生效（exact 满额时语义段不溢出）", async () => {
    const index = {
      ftsSearch: vi.fn(async () => [sym("src/a.ts", "a"), sym("src/b.ts", "b")]),
      ragSearch: vi.fn(async () => [rag("src/c.ts", "c", 1, 2, "c\nfunction c()")]),
    } as unknown as IndexClient;
    const result = await toolSearchSymbols(ctxWith(index), "a", 2);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Found 2 results (2 exact, 0 semantic)");
  });

  it("空查询 → fail", async () => {
    const result = await toolSearchSymbols(ctxWith({}), "  ", 20);
    expect(result.ok).toBe(false);
  });
});
