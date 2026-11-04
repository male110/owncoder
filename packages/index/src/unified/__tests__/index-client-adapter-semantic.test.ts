import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { UnifiedIndex } from "../index.ts";
import { UnifiedIndexAdapter } from "../index-client-adapter.ts";
import { SEMANTIC_EMBED_DIM } from "../semantic-index.ts";
import { SemanticSearchError } from "../../semantic-search-error.ts";

function fixture() {
  const rows = [{
    id: 1, path: "src/auth.ts", symbol_name: "login", qualified_name: "Auth.login",
    kind: "function", start_line: 4, end_line: 8, content: "login\nfunction login()",
    language: "typescript", distance: 0.1,
  }];
  const get = vi.fn(() => ({ name: "code_chunks_vec" }) as { name: string } | undefined);
  const all = vi.fn(() => rows);
  const prepare = vi.fn(() => ({ get, all }));
  const db = { prepare } as unknown as Database.Database;
  const getDatabase = vi.spyOn(UnifiedIndex.prototype, "getDatabase").mockReturnValue(null);
  const open = vi.spyOn(UnifiedIndex.prototype, "open").mockImplementation(() => {
    getDatabase.mockReturnValue(db);
  });
  vi.spyOn(UnifiedIndex.prototype, "getStats").mockReturnValue({ files: 1 } as ReturnType<UnifiedIndex["getStats"]>);
  const semantic = {
    embedQuery: vi.fn(async () => new Float32Array(SEMANTIC_EMBED_DIM)),
    embedBatch: vi.fn(async () => []),
    loadVec: vi.fn(),
  };
  const adapter = new UnifiedIndexAdapter({ semantic });
  return { adapter, semantic, get, all, prepare, db, getDatabase, open };
}

afterEach(() => vi.restoreAllMocks());

describe("UnifiedIndexAdapter 语义检索状态", () => {
  it("未配置嵌入服务时抛出明确错误", async () => {
    await expect(new UnifiedIndexAdapter().ragSearch("登录", 10)).rejects.toMatchObject({
      name: "SemanticSearchError", code: "embedding_not_configured",
    });
  });

  it("索引未打开时报告向量索引未加载", async () => {
    const { adapter, semantic } = fixture();
    await expect(adapter.ragSearch("登录", 10)).rejects.toMatchObject({ code: "vector_index_unavailable" });
    expect(semantic.embedQuery).not.toHaveBeenCalled();
  });

  it("sqlite-vec 加载失败不伪装成嵌入未配置，且允许重试", async () => {
    const { adapter, semantic } = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    semantic.loadVec.mockImplementationOnce(() => { throw new Error("load failed"); });
    await adapter.open("repo");
    await expect(adapter.ragSearch("登录", 10)).rejects.toMatchObject({ code: "vector_index_unavailable" });
    await adapter.open("repo");
    await expect(adapter.ragSearch("登录", 10)).resolves.toHaveLength(1);
    expect(semantic.loadVec).toHaveBeenCalledTimes(2);
  });

  it("向量表缺失时报告索引尚未构建且不调用嵌入", async () => {
    const { adapter, get, semantic } = fixture();
    await adapter.open("repo");
    get.mockReturnValue(undefined);
    await expect(adapter.ragSearch("登录", 10)).rejects.toMatchObject({ code: "vector_index_unavailable" });
    expect(semantic.embedQuery).not.toHaveBeenCalled();
  });

  it("保留向量命中的顺序、位置和分数", async () => {
    const { adapter, all, semantic } = fixture();
    await adapter.open("repo");
    const row = all.getMockImplementation()!()[0]!;
    all.mockReturnValue([
      { ...row, distance: 0.1 },
      { ...row, id: 2, path: "src/user.ts", distance: 0.4 },
    ]);
    const hits = await adapter.ragSearch("登录", 10);
    expect(hits.map(hit => hit.filePath)).toEqual(["src/auth.ts", "src/user.ts"]);
    expect(hits[0]).toMatchObject({ symbol: "Auth.login", startLine: 4, endLine: 8, semanticScore: 0.9 });
    expect(semantic.embedQuery).toHaveBeenCalledWith("登录");
    expect(all).toHaveBeenCalledWith(expect.any(Float32Array), 10);
  });

  it("成功的空查询结果返回空数组", async () => {
    const { adapter, all } = fixture();
    await adapter.open("repo");
    all.mockReturnValue([]);
    await expect(adapter.ragSearch("登录", 10)).resolves.toEqual([]);
  });

  it("嵌入服务异常保留 cause 并报告检索失败", async () => {
    const { adapter, semantic } = fixture();
    await adapter.open("repo");
    const cause = new Error("embedding timeout");
    semantic.embedQuery.mockRejectedValue(cause);
    await expect(adapter.ragSearch("登录", 10)).rejects.toMatchObject({
      code: "search_failed", message: expect.stringContaining("embedding timeout"), cause,
    });
  });

  it("错误的嵌入维度报告失败", async () => {
    const { adapter, semantic } = fixture();
    await adapter.open("repo");
    semantic.embedQuery.mockResolvedValue(new Float32Array(3));
    await expect(adapter.ragSearch("登录", 10)).rejects.toMatchObject({
      code: "search_failed", message: expect.stringContaining("Invalid embedding dimension"),
    });
  });

  it("数据库检索异常不会返回空数组", async () => {
    const { adapter, all } = fixture();
    await adapter.open("repo");
    all.mockImplementation(() => { throw new Error("KNN failed"); });
    await expect(adapter.ragSearch("登录", 10)).rejects.toBeInstanceOf(SemanticSearchError);
    await expect(adapter.ragSearch("登录", 10)).rejects.toMatchObject({
      code: "search_failed", message: expect.stringContaining("KNN failed"),
    });
  });

  it("切换数据库连接时重新注册 sqlite-vec", async () => {
    const { adapter, semantic, db, getDatabase, open } = fixture();
    await adapter.open("repo-a");
    const nextDb = { ...db } as Database.Database;
    open.mockImplementation(() => { getDatabase.mockReturnValue(nextDb); });
    await adapter.open("repo-b");
    expect(semantic.loadVec.mock.calls).toEqual([[db], [nextDb]]);
  });
});
