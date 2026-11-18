import { describe, expect, it } from "vitest";
import { SAVE_DESIGN_TOOL_DEF, SAVE_TASKS_TOOL_DEF } from "./specs.ts";

function contentDescription(tool: typeof SAVE_DESIGN_TOOL_DEF): string {
  const parameters = tool.function.parameters as { properties: { content: { description: string } } };
  return parameters.properties.content.description;
}

describe("Spec save tool guidance", () => {
  it("asks for a concrete design and includes open questions in the same Markdown file", () => {
    const guidance = contentDescription(SAVE_DESIGN_TOOL_DEF);
    expect(guidance).toContain("use the verified existing stack");
    expect(guidance).toContain("recommend one stack with reasons and assumptions");
    expect(guidance).toContain("implementation order and verification");
    expect(guidance).toContain("in this same document (假设与待确认)");
    expect(guidance).toContain("Do not leave them only in research notes or chat");
    expect(guidance).toContain("Use any suitable Markdown structure");
  });

  it("bases tasks on the recommendation without assuming unresolved decisions are approved", () => {
    const guidance = contentDescription(SAVE_TASKS_TOOL_DEF);
    expect(guidance).toContain("Use the recommended design as the baseline");
    expect(guidance).toContain("list a clarification task rather than scheduling the dependent implementation");
  });
});
