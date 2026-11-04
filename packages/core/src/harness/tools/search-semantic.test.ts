import { describe, expect, it, vi } from "vitest";
import { createIndexClient, SemanticSearchError, type IndexClient } from "@owncoder/index";
import { toolGrep } from "./grep.ts";
import { toolSearchSemantic } from "./search-semantic.ts";

vi.mock("./grep.ts", () => ({ toolGrep: vi.fn() }));

function ctx(index: object) {
  return { index, maxOutputChars: 8000 } as Parameters<typeof toolSearchSemantic>[0];
}

describe("toolSearchSemantic", () => {
  it("只调用向量检索并返回排序命中", async () => {
    const ftsSearch = vi.fn(async () => { throw new Error("must not call fts"); });
    const index = {
      ftsSearch,
      ragSearch: vi.fn(async () => [{
        chunkId: "a:4", filePath: "src/a.ts", symbol: "login", content: "login\nfunction login()",
        startLine: 4, endLine: 8, language: "typescript", score: 0.9, semanticScore: 0.91,
      }]),
    } as unknown as IndexClient;
    const result = await toolSearchSemantic(ctx(index), "用户登录校验", 10);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Semantic Search");
    expect(result.output).toContain("src/a.ts:4-8");
    expect(index.ragSearch).toHaveBeenCalledWith("用户登录校验", 16);
    expect(ftsSearch).not.toHaveBeenCalled();
    expect(toolGrep).not.toHaveBeenCalled();
  });

  it("拒绝空查询和未提供向量检索的索引", async () => {
    expect((await toolSearchSemantic(ctx({}), "  ", 10)).ok).toBe(false);
    const result = await toolSearchSemantic(ctx({}), "登录", 10);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("unavailable");
    expect(result.output).not.toContain("No semantic results");
  });

  it.each([
    ["embedding_not_configured", "Embedding service is not configured"],
    ["vector_index_unavailable", "Vector index is not loaded"],
    ["search_failed", "Embedding request failed"],
  ] as const)("传播 %s 错误且不报告零命中", async (code, message) => {
    const result = await toolSearchSemantic(ctx({
      ragSearch: async () => { throw new SemanticSearchError(code, message); },
    }), "登录", 10);
    expect(result.ok).toBe(false);
    expect(result.output).toContain(code);
    expect(result.output).toContain(message);
    expect(result.output).not.toContain("No semantic results");
    expect(toolGrep).not.toHaveBeenCalled();
  });

  it("实际适配器未配置嵌入服务时返回不可用", async () => {
    const result = await toolSearchSemantic(ctx(createIndexClient()), "登录", 10);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("embedding_not_configured");
    expect(result.output).not.toContain("No semantic results");
  });

  it("异常返回失败并保留错误原因", async () => {
    const result = await toolSearchSemantic(ctx({
      ragSearch: async () => { throw new Error("embed timeout"); },
    }), "登录", 10);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("failed");
    expect(result.output).toContain("embed timeout");
    expect(result.output).not.toContain("No semantic results");
  });

  it("成功的零命中保持成功状态且不触发文件搜索", async () => {
    const result = await toolSearchSemantic(ctx({ ragSearch: async () => [] }), "登录", 10);
    expect(result.ok).toBe(true);
    expect(result.output).toBe('No semantic results for "登录"');
    expect(toolGrep).not.toHaveBeenCalled();
  });

  it("无效检索响应不会被当作零命中", async () => {
    const result = await toolSearchSemantic(ctx({ ragSearch: async () => undefined }), "登录", 10);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("invalid response");
  });

  it("limit 边界限制为 50", async () => {
    const ragSearch = async (_query: string, topK: number) => {
      expect(topK).toBe(50);
      return [];
    };
    await toolSearchSemantic(ctx({ ragSearch }), "登录", 1000);
  });
});
