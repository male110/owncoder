/**
 * index-navigation（检索优先探索起点的共享核心）单元测试。
 *
 * 锁住的语义：
 * - 标识符提取：引号串优先、驼峰/蛇形/点分限定名、停用词过滤、去重、上限
 * - ftsSearch 聚合：同文件多符号合并、每文件 ≤3 符号、按命中数排序、≤8 文件
 * - 降级：ftsSearch 缺失 / 抛错 / 空结果 / 无标识符 → 一律 undefined
 * - 渲染：path:line 格式 + 总长硬上限
 */
import { describe, expect, it, vi } from "vitest";
import type { IndexClient, RagHit, SymbolSearchResult } from "@owncoder/index";
import {
  buildDecompositionRecallQuery,
  buildTaskRecallQuery,
  buildTaskRecallBlock,
  buildRecallBlock,
  extractNavigationIdentifiers,
  queryIndexNavigation,
  renderNavigationBlock,
} from "./index-navigation.ts";

function sym(path: string, name: string, kind = "function", line = 12, signature?: string): SymbolSearchResult {
  return { path, name, kind, line, ...(signature ? { signature } : {}), score: 0.9 };
}

function fakeIndex(resultsByQuery: Record<string, SymbolSearchResult[]> | undefined): IndexClient {
  return {
    ftsSearch: resultsByQuery
      ? vi.fn(async (q: string) => resultsByQuery[q] ?? [])
      : undefined,
  } as unknown as IndexClient;
}

describe("extractNavigationIdentifiers", () => {
  it("引号串优先，驼峰/蛇形/点分限定名都提取，停用词丢弃", () => {
    const ids = extractNavigationIdentifiers(
      '修改 "UserService" 的 validateToken 方法，看看 auth.middleware 怎么调用，the function use the from',
    );
    expect(ids).toContain("UserService");
    expect(ids).toContain("validateToken");
    expect(ids).toContain("auth.middleware");
    expect(ids).not.toContain("the");
    expect(ids).not.toContain("function");
    expect(ids).not.toContain("use");
  });

  it("去重 + 上限 8 + 纯数字/过短丢弃", () => {
    const text = Array.from({ length: 12 }, (_, i) => `sym${i}`).join(" ") + " sym0 sym1 42 ab";
    const ids = extractNavigationIdentifiers(text);
    expect(ids.length).toBeLessThanOrEqual(8);
    expect(new Set(ids).size).toBe(ids.length); // 无重复
    expect(ids).not.toContain("42");
    expect(ids).not.toContain("ab");
  });

  it("纯中文/无标识符文本 → 空数组", () => {
    expect(extractNavigationIdentifiers("你好，世界")).toEqual([]);
  });
});

describe("queryIndexNavigation", () => {
  it("按文件聚合：同文件多符号合并、每文件 ≤3、按命中数排序、≤8 文件", async () => {
    const index = fakeIndex({
      UserService: [sym("src/user.ts", "UserService", "class"), sym("src/user.ts", "createUser"), sym("src/user.ts", "deleteUser"), sym("src/user.ts", "listUsers")],
      validateToken: [sym("src/auth.ts", "validateToken"), sym("src/user.ts", "validateUser")],
    });
    const hits = await queryIndexNavigation(index, "UserService validateToken");
    expect(hits).toBeDefined();
    // src/user.ts 聚合 3 个（上限截断第 4 个 listUsers）+ validateUser = 但每文件 ≤3
    const userFile = hits!.find((h) => h.path === "src/user.ts")!;
    expect(userFile.symbols.length).toBeLessThanOrEqual(3);
    // 命中数多的文件排前面
    expect(hits![0]!.path).toBe("src/user.ts");
  });

  it("同一文件内同名符号去重", async () => {
    const index = fakeIndex({
      foo: [sym("a.ts", "foo"), sym("a.ts", "foo")],
    });
    const hits = await queryIndexNavigation(index, "foo");
    expect(hits![0]!.symbols).toHaveLength(1);
  });

  it("降级：ftsSearch 缺失 / 抛错 / 空结果 / 无标识符 → undefined", async () => {
    expect(await queryIndexNavigation({} as IndexClient, "foo")).toBeUndefined();
    const throwing = { ftsSearch: vi.fn(async () => { throw new Error("index corrupt"); }) } as unknown as IndexClient;
    expect(await queryIndexNavigation(throwing, "foo")).toBeUndefined();
    expect(await queryIndexNavigation(fakeIndex({}), "foo")).toBeUndefined();
    expect(await queryIndexNavigation(fakeIndex({}), "你好世界")).toBeUndefined();
  });

  it("单标识符查询失败不拖垮整体（其余标识符仍命中）", async () => {
    const index = {
      ftsSearch: vi.fn(async (q: string) => {
        if (q === "bad") throw new Error("query rejected");
        return [sym("ok.ts", "good")];
      }),
    } as unknown as IndexClient;
    const hits = await queryIndexNavigation(index, "bad good");
    expect(hits).toBeDefined();
    expect(hits![0]!.path).toBe("ok.ts");
  });
});

function ragHit(filePath: string, symbol: string, startLine: number, endLine: number, content: string, score = 0.8): RagHit {
  return {
    chunkId: `${filePath}:${startLine}`,
    filePath,
    symbol,
    content,
    startLine,
    endLine,
    language: "typescript",
    score,
    semanticScore: score,
  };
}

describe("queryIndexNavigation — hybrid（语义路 + 关键词路）", () => {
  it("语义文件排前：ragSearch 命中优先于关键词命中文件，preview 取 chunk 签名/doc 行", async () => {
    const index = {
      ragSearch: vi.fn(async () => [
        ragHit("src/auth.ts", "validateToken", 42, 60, "validateToken\nexport function validateToken(t: string): boolean\nChecks the signature."),
      ]),
      ftsSearch: vi.fn(async () => [sym("src/user.ts", "UserService", "class", 10)]),
    } as unknown as IndexClient;
    const hits = await queryIndexNavigation(index, "UserService 为什么登录失败");
    expect(hits!.map((h) => h.path)).toEqual(["src/auth.ts", "src/user.ts"]);
    expect(hits![0]!.semantic).toBe(true);
    expect(hits![0]!.symbols[0]!.line).toBe(42);
    expect(hits![0]!.symbols[0]!.preview).toContain("validateToken(t: string)");
  });

  it("语义路抛错 → 关键词路照常工作（行为与现状一致）", async () => {
    const index = {
      ragSearch: vi.fn(async () => {
        throw new Error("vec table missing");
      }),
      ftsSearch: vi.fn(async () => [sym("src/a.ts", "foo", "function", 3)]),
    } as unknown as IndexClient;
    const hits = await queryIndexNavigation(index, "foo");
    expect(hits).toHaveLength(1);
    expect(hits![0]!.semantic).toBeUndefined();
  });

  it("双路皆空 → undefined（调用方跳过注入）", async () => {
    const index = {
      ragSearch: vi.fn(async () => []),
      ftsSearch: vi.fn(async () => []),
    } as unknown as IndexClient;
    expect(await queryIndexNavigation(index, "anything")).toBeUndefined();
  });

  it("同一文件两路命中合并，符号按名去重", async () => {
    const index = {
      ragSearch: vi.fn(async () => [ragHit("src/a.ts", "login", 10, 20, "login\nfunction login()")]),
      ftsSearch: vi.fn(async () => [sym("src/a.ts", "login", "function", 10), sym("src/a.ts", "logout", "function", 30)]),
    } as unknown as IndexClient;
    const hits = await queryIndexNavigation(index, "login logout");
    expect(hits).toHaveLength(1);
    expect(hits![0]!.symbols.map((s) => s.name).sort()).toEqual(["login", "logout"]);
    expect(hits![0]!.semantic).toBe(true);
  });
});

describe("renderNavigationBlock", () => {
  it("渲染 path:line kind name: 预览 格式", () => {
    const text = renderNavigationBlock("## nav", [
      { path: "src/a.ts", symbols: [{ name: "foo", kind: "function", line: 3, preview: ": (x: number)" }] },
    ]);
    expect(text).toContain("## nav");
    expect(text).toContain("`src/a.ts:3` function foo: (x: number)");
  });

  it("总长硬上限 1500 字符（超限截断，保留已渲染行）", () => {
    const longSig = "x".repeat(300);
    const hits = Array.from({ length: 8 }, (_, i) => ({
      path: `src/f${i}.ts`,
      symbols: [sym(`src/f${i}.ts`, `sym${i}`, "function", 1, longSig)],
    }));
    const text = renderNavigationBlock("## nav", hits);
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text).toContain("src/f0.ts");
  });
});

describe("buildDecompositionRecallQuery", () => {
  it("从分解结果构造查询：intent + 各任务 prompt/description + 用户原文", () => {
    const query = buildDecompositionRecallQuery(
      {
        intent: "实现登录接口",
        tasks: [
          { id: "t1", description: "校验 token", prompt: "给 validateToken 加过期检查" },
          { id: "t2", description: "返回错误码", prompt: "" },
        ],
      },
      "用户要求支持企微扫码登录",
    );
    expect(query).toContain("实现登录接口");
    expect(query).toContain("给 validateToken 加过期检查");
    // prompt 优先于 description；空 prompt 回落 description
    expect(query).toContain("返回错误码");
    expect(query).toContain("用户要求支持企微扫码登录");
  });

  it("无分解结果时回落用户原文；两者皆空返回空串", () => {
    expect(buildDecompositionRecallQuery(undefined, "修一下登录 bug")).toBe("修一下登录 bug");
    expect(buildDecompositionRecallQuery(undefined, "")).toBe("");
    expect(buildDecompositionRecallQuery({ intent: "", tasks: [] }, "")).toBe("");
  });

  it("查询合成有硬上限（超长截断）", () => {
    const query = buildDecompositionRecallQuery(
      { intent: "x".repeat(3000), tasks: [] },
      "y".repeat(3000),
    );
    expect(query.length).toBeLessThanOrEqual(2000);
  });
});

describe("task-scoped recall", () => {
  it("does not merge sibling task text into the query", () => {
    const query = buildTaskRecallQuery({ executionGuidance: "定位 validateToken", description: "校验 token" }, "实现登录并修改返回码");
    expect(query).toContain("定位 validateToken");
    expect(query).not.toContain("返回码");
  });

  it("drops low-confidence semantic hits", async () => {
    const index = {
      ragSearch: vi.fn(async () => [ragHit("src/noise.ts", "noise", 1, 2, "noise", 0.2)]),
      ftsSearch: vi.fn(async () => []),
    } as unknown as IndexClient;
    expect(await queryIndexNavigation(index, "validate token")).toBeUndefined();
  });

  it("limits task recall to a small candidate set", async () => {
    const index = {
      ragSearch: vi.fn(async () => [ragHit("src/auth.ts", "validateToken", 10, 20, "validateToken\nfunction validateToken()", 0.9)]),
      ftsSearch: vi.fn(async () => []),
    } as unknown as IndexClient;
    const block = await buildTaskRecallBlock(index, { description: "校验 token" }, "");
    expect(block).toContain("src/auth.ts");
  });
});

describe("buildRecallBlock", () => {
  it("分解驱动召回：查询喂给双路检索，渲染含标题与命中行", async () => {
    const index = {
      ragSearch: vi.fn(async () => [
        ragHit("src/auth.ts", "validateToken", 42, 60, "validateToken\nexport function validateToken(t: string): boolean"),
      ]),
      ftsSearch: vi.fn(async () => []),
    } as unknown as IndexClient;
    const block = await buildRecallBlock(
      index,
      { intent: "登录失败排查", tasks: [{ id: "t1", description: "检查 token 校验", prompt: "" }] },
      "为什么登录失败",
    );
    expect(block).toBeDefined();
    expect(block).toContain("Relevant code recalled");
    expect(block).toContain("`src/auth.ts:42-60`");
    // Legacy request-level callers still include the full query, but use the
    // stricter bounded semantic top-K.
    expect(index.ragSearch).toHaveBeenCalledWith(
      expect.stringContaining("登录失败排查"),
      12,
    );
  });

  it("无 index / 双路皆空 / 无分解且无原文 → undefined", async () => {
    expect(await buildRecallBlock(undefined, { intent: "x", tasks: [] }, "y")).toBeUndefined();
    const empty = { ragSearch: vi.fn(async () => []), ftsSearch: vi.fn(async () => []) } as unknown as IndexClient;
    expect(await buildRecallBlock(empty, { intent: "x", tasks: [] }, "y")).toBeUndefined();
    expect(await buildRecallBlock(empty, undefined, "")).toBeUndefined();
  });
});
