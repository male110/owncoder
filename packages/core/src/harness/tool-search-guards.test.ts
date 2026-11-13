import { describe, expect, it } from "vitest";
import { READ_TOOL_DEFS } from "./enhanced-tools/read-tools.ts";

// 搜索类工具描述里的"跳过/二选一/浅层"护栏一旦回潮成引导性散文，会重新诱发
// locate-then-read 与多重搜索；此处锁住措辞。
const describeTool = (name: string): string => {
  const def = READ_TOOL_DEFS.find((tool) => tool.function.name === name);
  return JSON.stringify(def?.function ?? {});
};

describe("search tool descriptions carry skip guards", () => {
  it("glob and grep skip lookup when the target is already known", () => {
    const glob = describeTool("glob");
    const grep = describeTool("grep");
    expect(glob).toMatch(/Skip it when the path is already named/i);
    expect(grep).toMatch(/Skip it when the target file or range is already known/i);
    expect(grep).not.toMatch(/to locate files/i);
  });

  it("glob and grep declare themselves top-level tools, not run_script payloads", () => {
    for (const tool of [describeTool("glob"), describeTool("grep")]) {
      expect(tool).toMatch(/This is a top-level tool: call it directly/i);
      expect(tool).toMatch(/never wrap a single search in run_script to forward its output/i);
    }
  });

  it("symbol and semantic search route to one tool instead of both", () => {
    expect(describeTool("search_symbols")).toMatch(/Pick one search tool, not both/i);
    expect(describeTool("search_semantic")).toMatch(/Pick one search tool, not both/i);
  });

  it("graph_search defaults to one hop and reserves deeper hops for explicit audits", () => {
    const graph = describeTool("graph_search");
    expect(graph).toMatch(/default 1/i);
    expect(graph).toMatch(/depth 2\+ is justified/i);
  });
});
