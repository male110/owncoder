import {
  ModePipelineSchema,
  walkLinearNodes,
  rebuildLinearEdges,
  type ModePipeline,
  type PipelineNodeType,
  type PipelineNode,
} from "./pipeline.js";

export interface MigrationMove {
  fromType: PipelineNodeType;
  fromId: string;
  toType: PipelineNodeType;
  toId: string;
  paramMap: Record<string, string>;
}

export interface MigrationDrop {
  fromType: PipelineNodeType;
  fromId: string;
  reason: string;
}

export interface MigrationReport {
  moved: MigrationMove[];
  dropped: MigrationDrop[];
}

export const LEGACY_PIPELINE_TYPES: ReadonlySet<PipelineNodeType> = new Set([
  "load_anchors",
  "draft_plan",
  "save_plan",
  "document_intent_router",
  "agent_intent_router",
]);

const LEGACY_TYPES = LEGACY_PIPELINE_TYPES;

/**
 * Migrate legacy pipeline nodes (load_anchors / draft_plan / save_plan) into
 * their successor nodes' params, then remove them. Produces a report so the
 * editor can surface what was moved (spec 5.4 — no silent drops).
 *
 *   load_anchors           → context_gather.injectAnchors
 *   draft_plan             → explore_tools/execute_tools.prompt(+Zh)
 *   save_plan              → explore_tools/execute_tools.allowPlanFiles
 *   agent_intent_router    → task_decompose (understanding merged into its prompt)
 *   document_intent_router → dropped (handled by the Plan system prompt)
 */
export function migratePipeline(
  oldPipeline: ModePipeline,
): { newPipeline: ModePipeline; report: MigrationReport } {
  const report: MigrationReport = { moved: [], dropped: [] };
  const byId = new Map(
    oldPipeline.nodes.map((n) => [n.id, { ...n, params: { ...n.params } } as PipelineNode]),
  );
  const linear = walkLinearNodes(oldPipeline);

  const findType = (type: PipelineNodeType): PipelineNode | undefined =>
    linear.find((n) => n.type === type);

  // load_anchors → context_gather.injectAnchors
  for (const la of linear.filter((n) => n.type === "load_anchors")) {
    const ctx = findType("context_gather");
    if (ctx) {
      if (la.enabled !== false) {
        const ctxNode = byId.get(ctx.id)!;
        ctxNode.params = { ...ctxNode.params, injectAnchors: true };
      }
      report.moved.push({
        fromType: "load_anchors",
        fromId: la.id,
        toType: "context_gather",
        toId: ctx.id,
        paramMap: { enabled: "injectAnchors" },
      });
    } else {
      report.dropped.push({
        fromType: "load_anchors",
        fromId: la.id,
        reason: "无 context_gather 节点承接",
      });
    }
  }

  // draft_plan → explore_tools/execute_tools.prompt
  for (const dp of linear.filter((n) => n.type === "draft_plan")) {
    const target = findType("explore_tools") ?? findType("execute_tools");
    if (target) {
      const tgtNode = byId.get(target.id)!;
      const paramMap: Record<string, string> = {};
      if (!tgtNode.prompt?.trim() && dp.prompt?.trim()) {
        tgtNode.prompt = dp.prompt;
        paramMap.prompt = "prompt";
      }
      report.moved.push({
        fromType: "draft_plan",
        fromId: dp.id,
        toType: target.type,
        toId: target.id,
        paramMap,
      });
    } else {
      report.dropped.push({
        fromType: "draft_plan",
        fromId: dp.id,
        reason: "无调用模型节点承接",
      });
    }
  }

  // save_plan → explore_tools/execute_tools.allowPlanFiles
  for (const sp of linear.filter((n) => n.type === "save_plan")) {
    const target = findType("explore_tools") ?? findType("execute_tools");
    if (target) {
      const tgtNode = byId.get(target.id)!;
      tgtNode.params = { ...tgtNode.params, allowPlanFiles: sp.enabled !== false };
      report.moved.push({
        fromType: "save_plan",
        fromId: sp.id,
        toType: target.type,
        toId: target.id,
        paramMap: { enabled: "allowPlanFiles" },
      });
    } else {
      report.dropped.push({
        fromType: "save_plan",
        fromId: sp.id,
        reason: "无调用模型节点承接",
      });
    }
  }

  // The intent routers are simply removed. Their behaviour did not need a home of
  // its own: understanding the request moved into the task_decompose prompt (one
  // call that reads the conversation, then decomposes), and the PRD/TDD
  // confirmation moved into the Plan system prompt. Both read state that
  // context_gather now injects, so nothing has to be carried over here — only
  // reported, so the removal is not silent.
  for (const router of linear.filter(
    (n) => n.type === "document_intent_router" || n.type === "agent_intent_router",
  )) {
    const target = router.type === "agent_intent_router" ? findType("task_decompose") : undefined;
    if (target) {
      report.moved.push({
        fromType: router.type,
        fromId: router.id,
        toType: target.type,
        toId: target.id,
        paramMap: {},
      });
    } else {
      report.dropped.push({
        fromType: router.type,
        fromId: router.id,
        reason:
          router.type === "document_intent_router"
            ? "文档确认判断已并入 Plan 模式「调用模型」提示词"
            : "意图理解已并入「理解与任务分解」，但当前管线无该节点承接",
      });
    }
  }

  // Drop legacy nodes, preserve order, rebuild edges.
  const keptLinear = linear
    .filter((n) => !LEGACY_TYPES.has(n.type))
    .map((n) => byId.get(n.id)!);

  const newPipeline = ModePipelineSchema.parse({
    nodes: keptLinear,
    edges: rebuildLinearEdges(keptLinear.map((n) => n.id)),
    removed: oldPipeline.removed ?? [],
  });

  return { newPipeline, report };
}