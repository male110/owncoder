import { describe, expect, it } from "vitest";
import { BUILTIN_WORKFLOW, type SystemWorkflowConfig } from "@owncoder/settings";
import { resolveReactThinkingEffort } from "./tools.ts";

function workflow(
  harness: Partial<SystemWorkflowConfig["harness"]> = {},
  defaultEffort: SystemWorkflowConfig["thinking"]["defaultEffort"] = "high",
): SystemWorkflowConfig {
  return {
    ...BUILTIN_WORKFLOW,
    thinking: { defaultEffort },
    harness: { ...BUILTIN_WORKFLOW.harness, ...harness },
  };
}

describe("resolveReactThinkingEffort", () => {
  it("双模型启用且未显式配置时默认使用中等思考等级", () => {
    expect(resolveReactThinkingEffort({ workflow: workflow({ separateStageModels: true }) })).toBe("medium");
  });

  it("双模型启用时保留用户显式设置的思考等级", () => {
    expect(resolveReactThinkingEffort({
      workflow: workflow({ separateStageModels: true, reactThinkingEffort: "none" }),
    })).toBe("none");
  });

  it("未启用双模型时继续使用统一思考等级", () => {
    expect(resolveReactThinkingEffort({
      workflow: workflow({ separateStageModels: false }, "high"),
    })).toBe("high");
  });
});
