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
    expect(description).toContain("one-off `grep`, `glob`, or `read_file` as ordinary top-level tool calls");
    expect(description).toContain("Do not wrap a single grep, glob, or read_file call merely to forward its output");
  });

  it("keeps materially transformed and multi-call work in scope", () => {
    const description = getDescription();
    expect(description).toContain("filtering");
    expect(description).toContain("aggregating");
    expect(description).toContain("parsing");
    expect(description).toContain("cross-matching");
    expect(description).toContain("script materially transforms its result");
  });

  it("explains nested-call cost and limits tools.call wording to scripts", () => {
    const description = getDescription();
    expect(description).toContain("Each tools.call inside the script is also charged as a nested call");
    expect(description).toContain("Inside the script only");

    const codeDescription = getCodeDescription();
    expect(codeDescription).toContain("单个 grep、glob、read_file 若只是原样转发结果，应直接调用对应顶层工具");
    expect(codeDescription).toContain("实质过滤、聚合或解析结果");
  });

  it("does not claim run_script is read-only", () => {
    expect(RUN_SCRIPT_TOOL_DEF).not.toHaveProperty("readOnly", true);
    expect(RUN_SCRIPT_TOOL_DEF.function).not.toHaveProperty("readOnly", true);
  });
});
