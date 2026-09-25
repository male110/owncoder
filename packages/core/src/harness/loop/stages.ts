import {
  getActiveModelRef,
  modePipeline,
  walkLinearNodes,
  type ModelRef,
  type PipelineNode,
  type SystemWorkflowConfig,
} from "@owncoder/settings";
import type { AgentMode } from "@owncoder/shared";
import type { AgentLoopOpts } from "./types.ts";

export function stageLabel(node: PipelineNode): string {
  return node.label || node.type;
}

export function emitStage(
  onEvent: AgentLoopOpts["onEvent"],
  phase: "start" | "done",
  node: PipelineNode,
): void {
  const label = stageLabel(node);
  if (phase === "start") {
    onEvent?.({ type: "stage_start", id: node.id, nodeType: node.type, label });
  } else {
    onEvent?.({ type: "stage_done", id: node.id, nodeType: node.type, label });
  }
}

export function resolveStageModel(
  workflow: SystemWorkflowConfig,
  _mode: AgentMode,
  node: PipelineNode | undefined,
  stageType?: "decomposer" | "react",
): ModelRef {
  const base = getActiveModelRef(workflow);
  
  // 1. Node-level model override (highest priority)
  if (node?.model?.trim()) {
    return { ...base, model: node.model.trim() };
  }
  
  // 2. Stage-specific model override (if separateStageModels enabled)
  if (workflow.harness.separateStageModels && stageType) {
    const stageModel = stageType === "decomposer"
      ? workflow.harness.decomposerModel
      : workflow.harness.reactModel;
    if (stageModel?.trim()) {
      return { ...base, model: stageModel.trim() };
    }
  }
  
  // 3. Default workflow model
  return base;
}

// ── Resolve Middle Stages (Pipeline Compatibility) ─────────

/**
 * Extract middle stages from the pipeline in graph order.
 * Excludes: start, end (fixed spine).
 * Included: context_gather, task_decompose,
 *           explore_tools, execute_tools, verify, post_verify, present_changes
 *
 * context_gather is now included (T8-T10) so the PipelineScheduler dispatches it
 * through its StageHandler instead of being hardcoded before the midStages loop.
 *
 * Legacy node types (load_anchors/draft_plan/save_plan) are migrated out at load
 * time by pipeline-migrator (T3/T4), so no filter is needed here. Any residual
 * legacy node has no stage handler and is skipped by the scheduler.
 *
 * This is the key bridge between the UI pipeline editor and the execution engine.
 */
export function resolveMidStages(pipeline: ReturnType<typeof modePipeline>): PipelineNode[] {
  const linear = walkLinearNodes(pipeline);
  const ctxIdx = linear.findIndex((n: PipelineNode) => n.type === "context_gather");
  const endIdx = linear.findIndex((n: PipelineNode) => n.type === "end");
  const slice = linear.slice(
    ctxIdx >= 0 ? ctxIdx : 0,
    endIdx >= 0 ? endIdx : undefined,
  );
  return slice.filter((n: PipelineNode) => n.enabled !== false);
}
