import type { ToolDef } from "@owncoder/llm";
import type { AgentLoopOpts } from "./types.ts";

export const SPEC_TASK_OUTCOME_TOOL = "submit_task_outcome";
export const SPEC_TASK_OUTCOME_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: SPEC_TASK_OUTCOME_TOOL,
    description: "End this single Spec task. Submit completed only after meeting its acceptance criteria and running relevant checks; submit failed when the task could not be completed. Use report_blocker instead when user action is needed.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "failed"] },
        result: { type: "string", description: "Summarize the result, evidence, and checks or failure reason." },
      },
      required: ["status", "result"],
      additionalProperties: false,
    },
  },
};

export const SPEC_TASK_WORKFLOW_TOOLS = new Set([
  "add_tasks", "save_tasks", "save_spec", "save_design", "save_plan",
]);

export const SPEC_TASK_REPORT_REQUIRED = "The selected Spec task ended without a structured outcome. No completion was recorded.";

export function selectedSpecTask(opts: AgentLoopOpts) {
  const task = opts.activeTasks?.length === 1 ? opts.activeTasks[0] : undefined;
  return opts.mode === "agent" && !opts.readOnly && !opts.plannerLoop && !opts.exploreLoop
    && task && opts.currentTaskId && task.id === opts.currentTaskId
    && (task.status === "pending" || task.status === "in_progress")
    ? task : undefined;
}

export type SpecTaskReport = { status: "completed" | "failed"; result: string };
export type SpecTaskSubmission = SpecTaskReport & { requiresVerification: boolean };

export function parseSpecTaskSubmission(raw: string): SpecTaskReport | undefined {
  try {
    const { status, result, ...extra } = JSON.parse(raw);
    if (Object.keys(extra).length === 0 && (status === "completed" || status === "failed")
      && typeof result === "string" && result.trim()) return { status, result: result.trim() };
  } catch {
    // Do not repair malformed terminal submissions.
  }
  return undefined;
}
