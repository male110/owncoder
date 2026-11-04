/**
 * buildIndexNavigationCandidate（context_gather 索引导航候选）测试。
 *
 * 锁住的语义：
 * - 有命中 → 候选 source="index-navigation"、freshness="indexed"、path=首个命中文件
 * - 空结果 / 抛错 / 索引缺失 → undefined（不入池，行为与现状一致）
 */
import { describe, expect, it, vi } from "vitest";
import type { IndexClient, SymbolSearchResult } from "@owncoder/index";
import { buildIndexNavigationCandidate } from "./context.ts";

function sym(path: string, name: string, line = 12): SymbolSearchResult {
  return { path, name, kind: "function", line, score: 0.9 };
}

function fakeIndex(results: SymbolSearchResult[] | undefined, throws = false): IndexClient {
  return {
    ftsSearch: results === undefined
      ? undefined
      : vi.fn(async () => {
          if (throws) throw new Error("index corrupt");
          return results;
        }),
  } as unknown as IndexClient;
}

describe("buildIndexNavigationCandidate", () => {
  it("有命中 → index-navigation 候选（indexed 新鲜度 + 首个命中路径 + 导航块内容）", async () => {
    const candidate = await buildIndexNavigationCandidate(
      fakeIndex([sym("src/auth.ts", "validateToken", 42)]),
      "为什么 validateToken 登录失败",
    );
    expect(candidate).toBeDefined();
    expect(candidate!.source).toBe("index-navigation");
    expect(candidate!.freshness).toBe("indexed");
    expect(candidate!.path).toBe("src/auth.ts");
    expect(candidate!.content).toContain("## Index navigation starting points");
    expect(candidate!.content).toContain("src/auth.ts:42");
    expect(candidate!.mandatory).toBeUndefined(); // 非强制候选
  });

  it("空结果 / 抛错 / 无 ftsSearch → undefined（不入池）", async () => {
    expect(await buildIndexNavigationCandidate(fakeIndex([]), "validateToken")).toBeUndefined();
    expect(await buildIndexNavigationCandidate(fakeIndex([sym("a.ts", "foo")], true), "foo")).toBeUndefined();
    expect(await buildIndexNavigationCandidate({} as IndexClient, "foo")).toBeUndefined();
  });

  it("无标识符的纯中文查询 → undefined", async () => {
    expect(await buildIndexNavigationCandidate(fakeIndex([sym("a.ts", "foo")]), "你好世界")).toBeUndefined();
  });
});
