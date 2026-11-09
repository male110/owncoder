import { describe, it, expect } from "vitest";
import { applyStreamSnapshot, pushStreamSnapshot } from "./streaming-snapshot";

describe("applyStreamSnapshot", () => {
  it("replaces the accumulated value with the next cumulative snapshot", () => {
    expect(applyStreamSnapshot("The", "The grep")).toBe("The grep");
    expect(applyStreamSnapshot("The grep results", "The grep results show")).toBe(
      "The grep results show",
    );
  });

  it("does not duplicate content across many snapshots (O(n) not O(n^2))", () => {
    let acc = "";
    const total = 4000;
    for (let i = 1; i <= total; i++) {
      acc = applyStreamSnapshot(acc, `x`.repeat(i));
    }
    expect(acc).toBe("x".repeat(total));
  });

  it("accepts a shorter snapshot (tail-only think-tag stripping)", () => {
    expect(applyStreamSnapshot("foo(text) extra", "foo(text)")).toBe("foo(text)");
  });

  it("appends genuinely new text segments (one-shot finalReport / suffix)", () => {
    expect(applyStreamSnapshot("现有正文", "新的整段报告")).toBe("现有正文新的整段报告");
  });

  it("完整保留跨快照的空行、列表与代码块换行", () => {
    const report = "## 结论\n\n项目规范以 `@EnumValue` 为主。\n\n## 证据\n\n- value 同时使用 `@EnumValue`、`@JsonValue`。\n\n```java\n@EnumValue\n@JsonValue\n```";
    let accumulated = "";
    const chunks: string[] = [];
    for (let end = 1; end <= report.length; end++) {
      const snapshot = report.slice(0, end);
      accumulated = applyStreamSnapshot(accumulated, snapshot);
      pushStreamSnapshot(chunks, snapshot);
    }
    expect(accumulated).toBe(report);
    expect(chunks).toEqual([report]);
  });

  it("handles empty current value", () => {
    expect(applyStreamSnapshot("", "hello")).toBe("hello");
  });
});

describe("pushStreamSnapshot", () => {
  it("replaces the last chunk for the same segment, pushes new segments", () => {
    const chunks: string[] = [];
    pushStreamSnapshot(chunks, "The");
    pushStreamSnapshot(chunks, "The grep");
    pushStreamSnapshot(chunks, "The grep results");
    expect(chunks).toEqual(["The grep results"]);

    pushStreamSnapshot(chunks, "final report");
    expect(chunks).toEqual(["The grep results", "final report"]);
  });

  it("keeps memory bounded for long streaming segments", () => {
    const chunks: string[] = [];
    let snapshot = "";
    for (let i = 0; i < 5000; i++) {
      snapshot += "abcdefgh";
      pushStreamSnapshot(chunks, snapshot);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(snapshot);
    expect(chunks.join("").length).toBe(40000);
  });
});
