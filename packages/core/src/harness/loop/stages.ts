import {
  getActiveModelRef,
  modePipeline,
  resolveApiFormat,
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

  // 1. Node-level model override (highest priority). A node currently stores
  // only the model name, so preserve the selected provider for compatibility.
  if (node?.model?.trim()) {
    return { ...base, model: node.model.trim() };
  }

  // 2. React stage model override. Resolve the complete model reference from
  // the selected model's provider; changing only `model` would send the React
  // model to the decomposition provider/account and can yield model_not_found.
  if (workflow.harness.separateStageModels && stageType === "react") {
    const reactModel = workflow.harness.reactModel?.trim();
    if (reactModel) {
      const providerId = workflow.harness.reactProviderId;
      const selected = workflow.selectedModels.find((item) =>
        (providerId ? item.providerId === providerId : true) &&
        (item.id === reactModel || item.name === reactModel),
      ) ?? workflow.selectedModels.find((item) =>
        item.id === reactModel || item.name === reactModel,
      );
      const resolvedProviderId = providerId ?? selected?.providerId;
      const provider = workflow.providers.find((item) => item.id === resolvedProviderId);
      if (provider && selected) {
        return {
          baseUrl: provider.baseUrl,
          model: selected.name,
          providerId: provider.id,
          apiKey: provider.apiKey,
          apiFormat: resolveApiFormat({ apiFormat: provider.apiFormat, baseUrl: provider.baseUrl }),
        };
      }
      // Keep old configurations working when the saved value is a model name
      // but no matching selectedModels entry remains.
      return { ...base, model: reactModel };
    }
  }

  // 3. Default workflow model (including the decomposer).
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
