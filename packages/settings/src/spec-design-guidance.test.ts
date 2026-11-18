import { describe, expect, it } from "vitest";
import { BUILTIN_SPEC_PROMPT } from "./builtin-prompts.js";

const design = BUILTIN_SPEC_PROMPT.split("### design.md")[1]!.split("### tasks.md")[0]!;

describe("Spec design deliverable guidance", () => {
  it("reuses the verified stack or recommends one for a new project", () => {
    expect(design).toMatch(/use the existing stack verified in the repository/i);
    expect(design).toMatch(/recommend one concrete stack, explain why it fits/i);
    expect(design).toMatch(/module boundaries, key flows, interfaces and data models/);
    expect(design).toMatch(/implementation order, and how to verify/);
  });

  it("keeps open questions in the design and reserves questions for missing non-defaultable decisions", () => {
    expect(design).toContain("假设与待确认");
    expect(design).toMatch(/in this same design document, not just in research notes or chat/);
    expect(design).toMatch(/its impact, the proposed default if one exists, and when it must be confirmed/);
    expect(design).toMatch(/Use `ask_user` only when .* the user alone can provide and there is no reasonable default/);
    expect(design).toMatch(/silence is not agreement/);
    expect(BUILTIN_SPEC_PROMPT).toMatch(/Do not schedule implementation that depends on an unresolved decision with no reasonable default/);
  });
});
