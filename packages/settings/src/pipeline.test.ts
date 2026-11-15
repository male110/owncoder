import { describe, expect, it } from "vitest";
import {
  builtinAgentPipeline,
  builtinSpecPipeline,
  positionConstraintsOf,
  removePipelineNode,
  walkLinearNodes,
} from "./pipeline.ts";

describe("fixed Agent pipeline", () => {
  it("keeps task decomposition followed by the ReAct execution stage", () => {
    expect(walkLinearNodes(builtinAgentPipeline()).map((node) => node.type)).toEqual([
      "start",
      "context_gather",
      "task_decompose",
      "execute_tools",
      "post_verify",
      "present_changes",
      "end",
    ]);
  });

  it.each(["task_decompose", "execute_tools"] as const)(
    "does not expose %s as deletable or repeatable",
    (type) => {
      expect(positionConstraintsOf(type)).toMatchObject({
        deletable: false,
        repeatable: false,
      });
      const pipeline = builtinAgentPipeline();
      const node = pipeline.nodes.find((candidate) => candidate.type === type)!;
      expect(() => removePipelineNode(pipeline, node.id)).toThrow();
    },
  );

  it("decomposes spec tasks before the dedicated ReAct stage", () => {
    expect(positionConstraintsOf("explore_tools")).toMatchObject({
      deletable: true,
      repeatable: true,
    });
    expect(walkLinearNodes(builtinSpecPipeline()).map((node) => node.type)).toEqual([
      "start",
      "context_gather",
      "task_decompose",
      "explore_tools",
      "end",
    ]);
    const spec = builtinSpecPipeline();
    const agent = builtinAgentPipeline();
    expect(spec.nodes.find((node) => node.type === "task_decompose")?.prompt).toContain("# Spec Mode — Task Planning Overrides");
    expect(spec.nodes.find((node) => node.type === "task_decompose")?.prompt).toContain("# Output requirements");
    expect(spec.nodes.find((node) => node.type === "explore_tools")?.prompt).toContain("# Spec Mode");
    expect(agent.nodes.find((node) => node.type === "task_decompose")?.prompt).not.toContain("Spec Request Understanding");
  });
});
