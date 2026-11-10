import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Markdown } from "./Markdown";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  memo: (component: unknown) => component,
  useMemo: (factory: () => unknown) => factory(),
}));

type Element = ReactElement<{ children?: unknown; code?: string }>;
function descendants(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!node || typeof node !== "object" || !("type" in node)) return [];
  const element = node as Element;
  return [element, ...descendants(element.props.children)];
}
function render(content: string): Element[] {
  const element = Markdown({ content });
  const component = element.type as (props: typeof element.props) => Element;
  return descendants(component(element.props));
}

describe("分析报告的 Markdown 分节", () => {
  it("重现无换行结论只生成一个段落，不会自动生成标题或列表", () => {
    const nodes = render("结论：项目规范以 **@EnumValue** 为主；证据是 `WrongSelectModeEnum.java:4-38` 的 value 字段同时使用 `@EnumValue`、`@JsonValue`。");
    expect(nodes.filter((node) => node.type === "p")).toHaveLength(1);
    expect(nodes.some((node) => node.type === "h2" || node.type === "ul")).toBe(false);
  });

  it("相同结论的结构化 Markdown 生成标题、多个段落、列表和代码块", () => {
    const nodes = render([
      "## 结论", "", "项目规范以 **@EnumValue** 为主。", "",
      "以下是注解使用证据。", "", "## 证据", "",
      "- [WrongSelectModeEnum.java:4-38](E:/MarkingPaperTask/WrongSelectModeEnum.java:4-38) 的 value 字段同时使用 `@EnumValue`、`@JsonValue`。", "",
      "## 注解示例", "", "```java", "@EnumValue", "@JsonValue", "private final Integer value;", "```",
    ].join("\n"));
    expect(nodes.filter((node) => node.type === "h2")).toHaveLength(3);
    expect(nodes.filter((node) => node.type === "p")).toHaveLength(2);
    expect(nodes.filter((node) => node.type === "ul")).toHaveLength(1);
    expect(nodes.filter((node) => node.type === "li")).toHaveLength(1);
    expect(nodes.some((node) => node.type === "a")).toBe(true);
    expect(nodes.find((node) => typeof node.type === "function" && node.props.code)?.props.code)
      .toBe("@EnumValue\n@JsonValue\nprivate final Integer value;");
  });
});
