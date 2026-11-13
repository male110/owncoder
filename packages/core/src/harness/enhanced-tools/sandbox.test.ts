import { describe, expect, it } from "vitest";
import { RUN_SCRIPT_TOOL_DEF } from "./sandbox.js";

function getDescription(): string {
  return RUN_SCRIPT_TOOL_DEF.function.description ?? "";
}

function getCodeDescription(): string {
  const parameters = RUN_SCRIPT_TOOL_DEF.function.parameters as {
    properties?: Record<string, { description?: string }>;
  };
  return parameters.properties?.code?.description ?? "";
}

describe("run_script tool guidance", () => {
  it("routes simple one-off file tools to top-level calls", () => {
    const description = getDescription();
    expect(description).toContain("Do not wrap a single `grep`, `glob`, or `read_file` call in run_script to forward its output");
    expect(description).toContain("issue that call directly as a top-level tool call");
    expect(description).toContain("One locate-then-read is two ordinary top-level calls, not a chain");
    expect(description).toContain("Never wrap a single search in run_script");
  });

  it("keeps materially transformed and multi-call work in scope", () => {
    const description = getDescription();
    expect(description).toContain("filtering");
    expect(description).toContain("aggregating");
    expect(description).toContain("parsing");
    expect(description).toContain("cross-matching");
    expect(description).toContain("three or more files");
  });

  it("explains nested-call cost and limits tools.call wording to scripts", () => {
    const description = getDescription();
    expect(description).toContain("Each tools.call inside the script is also charged as a nested call");
    expect(description).toContain("Inside the script");

    const codeDescription = getCodeDescription();
    expect(codeDescription).toContain("不要用 run_script 包装单个 grep、glob、read_file 来转发结果");
    expect(codeDescription).toContain("实质过滤、聚合、解析结果");
    expect(codeDescription).not.toContain("tools.call(\"read_file\"");
  });

  it("does not claim run_script is read-only", () => {
    expect(RUN_SCRIPT_TOOL_DEF).not.toHaveProperty("readOnly", true);
    expect(RUN_SCRIPT_TOOL_DEF.function).not.toHaveProperty("readOnly", true);
  });
});
