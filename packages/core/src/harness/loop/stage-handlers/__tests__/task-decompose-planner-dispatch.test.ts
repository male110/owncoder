import { describe, expect, it } from "vitest";
import type { ToolCall } from "@owncoder/llm";
import { DECOMPOSE_PLANNER_TOOL_DEF, isDecomposePlannerCall } from "../task-decompose.ts";

function dispatch(agent_type: string, task = "Investigate cross-file migration and plan for approval"): ToolCall {
  return {
    id: "plan-1",
    type: "function",
    function: { name: "dispatch_agent", arguments: JSON.stringify({ agent_type, task }) },
  };
}

describe("task decomposition subagent boundary", () => {
  it("exposes Planner alone, requiring an explicit agent type", () => {
    const parameters = DECOMPOSE_PLANNER_TOOL_DEF.function.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(parameters.properties.agent_type).toMatchObject({ enum: ["Planner"] });
    expect(parameters.required).toEqual(expect.arrayContaining(["agent_type", "task"]));
    expect(DECOMPOSE_PLANNER_TOOL_DEF.function.description).toContain("separate user approval");
  });

  it("rejects Explore instead of silently converting research into a plan", () => {
    expect(isDecomposePlannerCall(dispatch("Explore"), true)).toBe(false);
    expect(isDecomposePlannerCall(dispatch("Explore"), false)).toBe(false);
    expect(isDecomposePlannerCall({ ...dispatch("Planner"), function: { name: "dispatch_agent", arguments: JSON.stringify({ task: "Investigate" }) } }, true)).toBe(false);
  });

  it("allows a valid Planner request only when approval planning is available", () => {
    expect(isDecomposePlannerCall(dispatch("Planner"), true)).toBe(true);
    expect(isDecomposePlannerCall(dispatch("Planner"), false)).toBe(false);
    expect(isDecomposePlannerCall(dispatch("Planner", " "), true)).toBe(false);
    expect(isDecomposePlannerCall({ ...dispatch("Planner"), function: { name: "dispatch_agent", arguments: "{broken" } }, true)).toBe(false);
    expect(isDecomposePlannerCall(undefined, true)).toBe(false);
  });
});
