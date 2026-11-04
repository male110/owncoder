import { describe, it, expect } from "vitest";
import { summarizeArgs } from "./tool-card-utils";

describe("summarizeArgs: search", () => {
  it("grep shows the pattern, effective path, and supplied filters", () => {
    expect(summarizeArgs("grep", {
      pattern: "TaskStudentPaperMarketEntity",
      output_mode: "files_with_matches",
      file_path: ".",
      glob: "**/*.java",
      ignore_case: true,
      head_limit: 20,
    })).toBe("TaskStudentPaperMarketEntity in . · glob=**/*.java · output_mode=files_with_matches · head_limit=20 · ignore_case=true");
  });

  it("grep uses the workspace root when file_path is omitted or blank", () => {
    expect(summarizeArgs("grep", { pattern: "needle" })).toBe("needle in .");
    expect(summarizeArgs("grep", { pattern: "needle", file_path: "  " })).toBe("needle in .");
  });

  it("grep truncates long summaries", () => {
    const out = summarizeArgs("grep", {
      pattern: "x".repeat(140),
      file_path: "src",
      glob: "**/*.very-long-extension",
    });
    expect(out).toHaveLength(120);
    expect(out.endsWith("…")).toBe(true);
  });
  it("search tools show pattern/query only when no scope", () => {
    expect(summarizeArgs("search_symbols", { query: "parseBody", limit: 10 })).toBe("parseBody");
    expect(summarizeArgs("search_code", { query: "parseBody" })).toBe("parseBody");
  });

  it("search tools pick up glob scope", () => {
    expect(summarizeArgs("search_symbols", { query: "x", glob: "**/*.ts" })).toBe("x in **/*.ts");
    expect(summarizeArgs("search_code", { query: "todo", path: "packages/core" })).toBe("todo in packages/core");
  });

  it("path \".\" is not shown as scope (avoids \"in .\" noise)", () => {
    expect(summarizeArgs("search_code", { query: "todo", path: "." })).toBe("todo");
  });

  it("truncates over-long glob scope", () => {
    const glob = "**/" + "a".repeat(80) + ".ts";
    const out = summarizeArgs("search_code", { query: "x", glob });
    expect(out).toHaveLength("x in ".length + 60 + 1);
    expect(out.endsWith("…")).toBe(true);
  });
});
