import { z } from "zod";
import {
  BUILTIN_AGENT_PROMPT,
  BUILTIN_SPEC_PROMPT,
} from "./builtin-prompts.js";
import {
  BUILTIN_SPEC_TASK_DECOMPOSE_PROMPT,
  BUILTIN_TASK_DECOMPOSE_PROMPT,
} from "./task-decompose-prompt.js";

export const PipelineNodeTypeSchema = z.enum([
  "agent_planner",
  "start",
  "context_gather",
  "history_compact", // deprecated: no-op under 方案A, handler removed; kept so old saved pipelines degrade gracefully
  "document_intent_router",
  "agent_intent_router",
  "task_decompose",
  "explore_tools",
  "draft_plan",
  "save_plan",
  "load_anchors",
  "execute_tools",
  "verify",
  "post_verify",
  "present_changes",
  "end",
]);

export type PipelineNodeType = z.infer<typeof PipelineNodeTypeSchema>;

// ── Node Type Registry (single source of node metadata) ─────────

export interface NodeTypePositionConstraints {
  deletable: boolean;
  repeatable: boolean;
  slot?: "pre-model" | "mid" | "post-model";
}

export interface NodeTypeDescriptor {
  type: PipelineNodeType;
  label: string;
  fixed?: boolean;
  /** Filled in T11. */
  positionConstraints?: NodeTypePositionConstraints;
}

export const NODE_TYPE_REGISTRY: ReadonlyArray<NodeTypeDescriptor> = [
  { type: "start", label: "开始", fixed: true, positionConstraints: { deletable: false, repeatable: false } },
  { type: "context_gather", label: "收集上下文", fixed: true, positionConstraints: { deletable: false, repeatable: false, slot: "pre-model" } },
  { type: "history_compact", label: "压缩历史", positionConstraints: { deletable: true, repeatable: false, slot: "pre-model" } },
  { type: "document_intent_router", label: "文档意图识别", positionConstraints: { deletable: true, repeatable: false, slot: "pre-model" } },
  { type: "agent_intent_router", label: "Agent 意图识别", positionConstraints: { deletable: true, repeatable: false, slot: "pre-model" } },
  { type: "task_decompose", label: "理解与任务分解", fixed: true, positionConstraints: { deletable: false, repeatable: false, slot: "pre-model" } },
  { type: "explore_tools", label: "调用模型", positionConstraints: { deletable: true, repeatable: true, slot: "mid" } },
  { type: "draft_plan", label: "计划提示词", positionConstraints: { deletable: true, repeatable: false } },
  { type: "save_plan", label: "保存计划", positionConstraints: { deletable: true, repeatable: false } },
  { type: "load_anchors", label: "活动计划/TODO", positionConstraints: { deletable: true, repeatable: false } },
  { type: "execute_tools", label: "调用模型", positionConstraints: { deletable: false, repeatable: false, slot: "mid" } },
  { type: "verify", label: "检验", positionConstraints: { deletable: true, repeatable: true, slot: "post-model" } },
  { type: "post_verify", label: "执行验证", positionConstraints: { deletable: true, repeatable: false, slot: "post-model" } },
  { type: "present_changes", label: "变更审阅", positionConstraints: { deletable: true, repeatable: false, slot: "post-model" } },
  { type: "end", label: "结束", fixed: true, positionConstraints: { deletable: false, repeatable: false } },
];

export function resolveNodeType(type: PipelineNodeType): NodeTypeDescriptor | undefined {
  return NODE_TYPE_REGISTRY.find((d) => d.type === type);
}

/** Look up the position constraints for a node type (T11). Returns undefined for unknown types. */
export function positionConstraintsOf(
  type: PipelineNodeType,
): NodeTypePositionConstraints | undefined {
  return resolveNodeType(type)?.positionConstraints;
}

// ── ReAct Loop Steps ────────────────────────────────────────────
// Runtime defaults and supported tuning parameters for the fixed ReAct loop.

export const ReactStepIdSchema = z.enum([
  "abort_check",
  "budget_check",
  "llm_call",
  "parse_response",
  "stuck_detect",
  "tool_cap",
  "git_snapshot",
  "tool_exec",
  "doc_deliverable",
  "auto_fix",
  "state_machine",  // 新增：状态机控制
]);

export type ReactStepId = z.infer<typeof ReactStepIdSchema>;

/** Runtime configuration for a step in the fixed ReAct loop. */
export const ReactStepConfigSchema = z.object({
  id: ReactStepIdSchema,
  enabled: z.boolean().default(true),
  /** Step-level parameters (numbers/booleans). */
  params: z.record(z.union([z.number(), z.boolean(), z.string()])).default({}),
});

export type ReactStepConfig = z.infer<typeof ReactStepConfigSchema>;

/** UI metadata for a ReAct step — label, description, editable param fields. */
export interface ReactParamField {
  key: string;
  label: string;
  type: "number" | "boolean";
  min?: number;
  max?: number;
}

export interface ReactStepMeta {
  id: ReactStepId;
  label: string;
  labelZh: string;
  description: string;
  descriptionZh: string;
  /** When this step only runs under certain conditions. */
  conditional?: string;
  conditionalZh?: string;
  /** Editable parameter fields for the inspector. */
  paramFields?: ReactParamField[];
}

export const REACT_STEP_METAS: ReactStepMeta[] = [
  {
    id: "abort_check",
    label: "Abort Check",
    labelZh: "中断检查",
    description: "Check AbortSignal; exit loop if cancelled.",
    descriptionZh: "检查中止信号，已取消则退出循环。",
  },
  {
    id: "budget_check",
    label: "Context Budget",
    labelZh: "上下文预算检查",
    description: "Compress conversation history when it exceeds the budget.",
    descriptionZh: "对话历史超预算时压缩。",
    conditional: "iter ≥ startIter, every interval",
    conditionalZh: "iter ≥ startIter，每 interval 轮",
    paramFields: [
      { key: "startIter", label: "起始轮", type: "number", min: 0, max: 32 },
      { key: "interval", label: "间隔", type: "number", min: 1, max: 10 },
      { key: "maxChars", label: "预算上限", type: "number", min: 1000, max: 200000 },
    ],
  },
  {
    id: "llm_call",
    label: "LLM Call",
    labelZh: "LLM 调用",
    description: "Streaming request to the model; retry on failure.",
    descriptionZh: "流式请求大模型，失败时重试。",
    paramFields: [
      { key: "maxRetries", label: "重试次数", type: "number", min: 0, max: 5 },
    ],
  },
  {
    id: "parse_response",
    label: "Parse Response",
    labelZh: "解析响应",
    description: "Extract text content + tool calls from assistant response.",
    descriptionZh: "从助手响应中提取文本内容与工具调用。",
  },
  {
    id: "stuck_detect",
    label: "Stuck Detection",
    labelZh: "卡顿检测",
    description: "Detect repeated tool fingerprints, consecutive read-only, or same-file re-reads.",
    descriptionZh: "检测重复工具指纹、连续只读、同文件重复读取。",
    paramFields: [
      { key: "maxRepeat", label: "重复工具上限", type: "number", min: 1, max: 50 },
      { key: "maxReadCount", label: "同文件读取上限", type: "number", min: 1, max: 10 },
      { key: "maxReadonlyIters", label: "连续只读上限", type: "number", min: 1, max: 200 },
      { key: "maxPagesPerFile", label: "单文件分页上限", type: "number", min: 1, max: 100 },
    ],
  },
  {
    id: "tool_cap",
    label: "Tool Cap",
    labelZh: "工具上限检查",
    description: "Force-stop if total tool invocations exceed the cap.",
    descriptionZh: "累计工具调用超上限则强制退出。",
    paramFields: [
      { key: "maxTotal", label: "总上限", type: "number", min: 1, max: 100 },
    ],
  },
  {
    id: "git_snapshot",
    label: "Git Snapshot",
    labelZh: "Git 自动快照",
    description: "Checkpoint before file-modifying tools execute.",
    descriptionZh: "文件修改工具执行前做检查点。",
    conditional: "has file-modifying tool & not Plan",
    conditionalZh: "含文件修改工具且非 Plan 模式",
  },
  {
    id: "tool_exec",
    label: "Tool Execution",
    labelZh: "工具执行",
    description: "Run tool calls; parallel-safe tools run concurrently, writes/bash sequential.",
    descriptionZh: "执行工具调用；并行安全工具并发，写/bash 串行。",
    paramFields: [
      { key: "parallel", label: "并行安全工具", type: "boolean" },
    ],
  },
  {
    id: "doc_deliverable",
    label: "Doc Deliverable",
    labelZh: "文档交付物检测",
    description: "Stop after writing PRD/TDD etc., wait for user confirmation.",
    descriptionZh: "写入 PRD/TDD 等后停止，等待确认。",
    conditional: "Spec mode",
    conditionalZh: "Plan 模式",
  },
  {
    id: "auto_fix",
    label: "Auto Fix",
    labelZh: "自动修复",
    description: "Type-check after file modifications; auto-correct errors.",
    descriptionZh: "文件修改后 type-check 并自动纠错。",
    conditional: "has file modifications & not Plan",
    conditionalZh: "有文件修改且非 Plan 模式",
    paramFields: [
      { key: "maxAttempts", label: "修复次数", type: "number", min: 0, max: 10 },
    ],
  },
  {
    id: "state_machine",
    label: "State Machine",
    labelZh: "状态机控制",
    description: "Use state machine for loop control instead of finish_reason. Improves robustness with weak models.",
    descriptionZh: "使用状态机替代 finish_reason 进行循环控制，提高弱模型的鲁棒性。",
    paramFields: [
      { key: "enabled", label: "启用状态机", type: "boolean" },
      { key: "minGatheringIterations", label: "最小探索轮次", type: "number", min: 1, max: 10 },
      { key: "completionConfidenceThreshold", label: "完成度置信阈值", type: "number", min: 0.5, max: 1.0 },
      { key: "maxConsecutiveNoToolTurns", label: "连续无工具上限", type: "number", min: 1, max: 10 },
      { key: "weakModelDetection", label: "弱模型检测", type: "boolean" },
    ],
  },
];

/** Factory defaults — mirrors the hardcoded behavior in react.ts. */
export function defaultReactSteps(): ReactStepConfig[] {
  return [
    { id: "abort_check", enabled: true, params: {} },
    { id: "budget_check", enabled: true, params: { startIter: 6, interval: 3, maxChars: 24000 } },
    { id: "llm_call", enabled: true, params: { maxRetries: 2 } },
    { id: "parse_response", enabled: true, params: {} },
    // maxReadonlyIters / maxReadCount 默认 0 = 不限制读取。
    // 读取是收集证据的手段，不应在任务中途掐断；失控保护交给 maxRepeat（相同指纹）。
    { id: "stuck_detect", enabled: true, params: { maxRepeat: 2, maxReadCount: 0, maxReadonlyIters: 0 } },
    { id: "tool_cap", enabled: true, params: { maxTotal: 200 } },
    { id: "git_snapshot", enabled: true, params: {} },
    { id: "tool_exec", enabled: true, params: { parallel: true } },
    { id: "doc_deliverable", enabled: true, params: {} },
    { id: "auto_fix", enabled: true, params: { maxAttempts: 3 } },
    { id: "state_machine", enabled: true, params: { 
      enabled: true,
      minGatheringIterations: 2,
      completionConfidenceThreshold: 0.85,
      maxConsecutiveNoToolTurns: 3,
      weakModelDetection: true,
    } },
  ];
}

/** Look up a step's metadata by id. */
export function reactStepMeta(id: ReactStepId): ReactStepMeta | undefined {
  return REACT_STEP_METAS.find((m) => m.id === id);
}

export const PipelineNodeParamsSchema = z
  .object({
    maxIterations: z.number().int().min(1).max(500).optional(),
    /** Loop termination thresholds (consumed in T6/T7); defaults applied at consumption site. */
    maxRepeatToolCalls: z.number().int().min(1).optional(),
    maxTotalToolCalls: z.number().int().min(1).optional(),
    maxSameFileReads: z.number().int().min(1).optional(),
    maxConsecutiveReadonlyIters: z.number().int().min(1).optional(),
    maxEmptyResponses: z.number().int().min(1).optional(),
    /** Max distinct pages (different offsets) per file before stuck detection fires. */
    maxPagesPerFile: z.number().int().min(1).optional(),
    /** Max redundant reads of ranges that are already fully covered for one file. */
    maxRedundantRangesPerFile: z.number().int().min(1).optional(),
    /** Loop strategy name; default "react". Multi-task work remains sequential in the same ReAct context. */
    loopStrategy: z.string().optional(),
    /** State machine configuration for improved loop control */
    stateMachine: z.object({
      /** Enable state machine-based loop control (recommended for weak models) */
      enabled: z.boolean().optional(),
      /** Minimum iterations in GATHERING state before transitioning to PROCESSING */
      minGatheringIterations: z.number().int().min(1).max(20).optional(),
      /** Confidence threshold for task completion (0.0-1.0) */
      completionConfidenceThreshold: z.number().min(0.5).max(1.0).optional(),
      /** Max consecutive iterations with no tool calls before termination */
      maxConsecutiveNoToolTurns: z.number().int().min(1).max(10).optional(),
      /** Detect and handle weak model behavior patterns */
      weakModelDetection: z.boolean().optional(),
      /** Ignore finish_reason="stop" for weak models in GATHERING state */
      ignoreEarlyStopForWeakModel: z.boolean().optional(),
    }).optional(),
    injectRules: z.boolean().optional(),
    injectMentions: z.boolean().optional(),
    /** @deprecated Dependencies are no longer injected; use the `project_deps` tool on demand. */
    injectDeps: z.boolean().optional(),
    /** Agent: inject ACTIVE PLAN / TODO before the model call. */
    injectAnchors: z.boolean().optional(),
    /** Spec: allow spec write tools during the model+tools loop. */
    allowSpecFiles: z.boolean().optional(),
    autoKeepChanges: z.boolean().optional(),
    /** Inject user preference memories (global, cross-project) into context. */
    injectMemories: z.boolean().optional(),
    /**
     * Choose the smallest task-relevant set of already collected context blocks.
     * Missing config defaults to apply mode for built-in workflows; `off` preserves
     * the unfiltered context assembly, while `observe` records a decision only.
     */
    contextSelection: z.union([
      z.literal(false),
      z.object({
        mode: z.enum(["off", "observe", "apply"]).optional(),
        tokenBudget: z.number().int().min(0).max(200_000).optional(),
        maxCandidates: z.number().int().min(1).max(100).optional(),
        emitDecisionTrace: z.boolean().optional(),
      }),
    ]).optional(),
    /**
     * Per-turn controls for indexed-context freshness receipts and
     * model-visible tool-output projection. Source compression defaults to
     * observe at the runtime boundary.
     *
     * historyFilter: Task-aware filtering of recent conversation history before
     * ReAct loops, reducing token usage while preserving relevant context.
     */
    contextControl: z.object({
      freshnessTracking: z.boolean().optional(),
      emitTelemetry: z.boolean().optional(),
      sourceCompression: z.object({
        mode: z.enum(["off", "observe", "apply"]).optional(),
        maxChars: z.number().int().min(512).max(100_000).optional(),
      }).optional(),
      historyFilter: z.object({
        /** Enable task-aware history filtering (default: true) */
        enabled: z.boolean().optional(),
        /** Minimum history size (chars) to trigger filtering (default: 15000) */
        minHistoryChars: z.number().int().min(5000).max(100_000).optional(),
        /** Use two-stage filtering (rule + LLM) vs rule-only (default: true) */
        useLLMPrecisionFilter: z.boolean().optional(),
        /** Temperature for filter LLM (default: 0 for deterministic) */
        filterTemperature: z.number().min(0).max(1).optional(),
      }).optional(),
    }).optional(),
    /** ReAct loop sub-steps — editable in the pipeline editor. */
    reactSteps: z.array(ReactStepConfigSchema).optional(),
  })
  .default({});

export const PipelineNodeSchema = z.object({
  id: z.string().min(1),
  type: PipelineNodeTypeSchema,
  label: z.string().optional(),
  /** English prompt used at runtime (canonical). */
  prompt: z.string().optional(),
  /** Optional model name override for this stage (empty = mode/default model). */
  model: z.string().optional(),
  params: PipelineNodeParamsSchema.optional(),
  /** Canvas position for the ReactFlow visual editor. Ignored at runtime. */
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});

export const PipelineEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

export const ModePipelineSchema = z.object({
  nodes: z.array(PipelineNodeSchema).min(2),
  edges: z.array(PipelineEdgeSchema),
  /**
   * Nodes the user explicitly deleted, as namespaced keys: `id:<nodeId>` or
   * `type:<nodeType>`.
   *
   * `mergePipeline` unions the saved overlay with the factory pipeline by node
   * id, so without this list a deleted factory node (e.g. the intent node) would
   * be resurrected on the next load. Re-adding a type clears its type entry.
   *
   * The two namespaces are kept distinct so a node id that happens to equal a
   * type name cannot suppress unrelated factory nodes.
   */
  removed: z.array(z.string()).default([]),
});

const REMOVED_ID = "id:";
const REMOVED_TYPE = "type:";

/** Build the `removed` key for a deleted node id. */
function removedIdKey(nodeId: string): string {
  return `${REMOVED_ID}${nodeId}`;
}

/** Build the `removed` key for a fully deleted node type. */
function removedTypeKey(type: PipelineNodeType): string {
  return `${REMOVED_TYPE}${type}`;
}

/**
 * Whether a factory node is suppressed by the user's `removed` list.
 * Fixed spine nodes are never suppressible, so a hand-edited workflow.json
 * cannot break the pipeline. Bare (un-namespaced) entries are read as ids for
 * compatibility with the first revision of this field.
 */
function isRemovedNode(
  removed: ReadonlySet<string>,
  node: { id: string; type: PipelineNodeType },
): boolean {
  if (removed.size === 0) return false;
  if (FIXED_PIPELINE_TYPES.has(node.type)) return false;
  return (
    removed.has(removedIdKey(node.id)) ||
    removed.has(removedTypeKey(node.type)) ||
    removed.has(node.id)
  );
}

export type PipelineNode = z.infer<typeof PipelineNodeSchema>;
export type ModePipeline = z.infer<typeof ModePipelineSchema>;

/** Node labels — derived from NODE_TYPE_REGISTRY. */
export const NODE_TYPE_LABELS: Record<PipelineNodeType, string> = Object.fromEntries(
  NODE_TYPE_REGISTRY.map((d) => [d.type, d.label]),
) as Record<PipelineNodeType, string>;

/**
 * Spec = context → dedicated decomposition (shared task JSON) → dedicated ReAct → end.
 */
export function builtinSpecPipeline(): ModePipeline {
  return ModePipelineSchema.parse({
    nodes: [
      { id: "start",   type: "start",         label: "开始",     position: { x: 300, y: 40 } },
      {
        id: "context", type: "context_gather", label: "收集上下文",
        position: { x: 300, y: 170 },
        params: { injectRules: true, injectMentions: true },
      },
      {
        id: "decompose", type: "task_decompose", label: "理解与任务分解",
        position: { x: 300, y: 300 },
        prompt: BUILTIN_SPEC_TASK_DECOMPOSE_PROMPT.trim(),
      },
      {
        id: "llm",     type: "explore_tools",  label: "调用模型",
        position: { x: 300, y: 430 },
        prompt: BUILTIN_SPEC_PROMPT.trim(),
        params: { maxIterations: 200, allowSpecFiles: true },
      },
      { id: "end",     type: "end",            label: "结束",     position: { x: 300, y: 560 } },
    ],
    edges: [
      { id: "e1", from: "start",     to: "context" },
      { id: "e2", from: "context",   to: "decompose" },
      { id: "e3", from: "decompose", to: "llm" },
      { id: "e4", from: "llm",       to: "end" },
    ],
  });
}

/**
 * Agent = context → decompose (optional native planner tool and approval) → ReAct loop → post-verify → review writes.
 * This is a fixed product workflow; user pipeline overlays do not alter its stages.
 */
export function builtinAgentPipeline(): ModePipeline {
  return ModePipelineSchema.parse({
    nodes: [
      { id: "start",      type: "start",           label: "开始",     position: { x: 300, y: 40  } },
      {
        id: "context",    type: "context_gather",   label: "收集上下文",
        position: { x: 300, y: 170 },
        params: { injectRules: true, injectMentions: true, injectAnchors: true },
      },
      {
        id: "decompose",  type: "task_decompose",   label: "理解与任务分解",
        position: { x: 300, y: 300 },
        prompt: BUILTIN_TASK_DECOMPOSE_PROMPT.trim(),
      },
      {
        id: "llm",        type: "execute_tools",    label: "调用模型",
        position: { x: 300, y: 690 },
        prompt: BUILTIN_AGENT_PROMPT.trim(),
        params: { maxIterations: 200 },
      },
      { id: "postverify", type: "post_verify",      label: "执行验证", position: { x: 300, y: 820 } },
      {
        id: "present",    type: "present_changes",  label: "变更审阅",
        position: { x: 300, y: 950 },
        params: { autoKeepChanges: false },
      },
      { id: "end",        type: "end",              label: "结束",     position: { x: 300, y: 1080 } },
    ],
    edges: [
      { id: "e1",  from: "start",      to: "context"    },
      { id: "e2",  from: "context",    to: "decompose"  },
      { id: "e3",  from: "decompose",  to: "llm" },
      { id: "e3b", from: "llm",        to: "postverify" },
      { id: "e4",  from: "postverify", to: "present"    },
      { id: "e5",  from: "present",    to: "end"        },
    ],
  });
}

/** Fixed spine — derived from NODE_TYPE_REGISTRY (fixed === true). */
export const FIXED_PIPELINE_TYPES = new Set<PipelineNodeType>(
  NODE_TYPE_REGISTRY.filter((d) => d.fixed === true).map((d) => d.type),
);

export function isFixedPipelineNode(node: PipelineNode): boolean {
  return FIXED_PIPELINE_TYPES.has(node.type);
}

/** Full linear walk from start (includes disabled), excludes nothing except cycles. */
export function walkLinearNodes(pipeline: ModePipeline): PipelineNode[] {
  const byId = new Map(pipeline.nodes.map((n) => [n.id, n]));
  const outs = new Map<string, string[]>();
  for (const e of pipeline.edges) {
    const list = outs.get(e.from) ?? [];
    list.push(e.to);
    outs.set(e.from, list);
  }
  const start = pipeline.nodes.find((n) => n.type === "start");
  if (!start) return [...pipeline.nodes];
  const ordered: PipelineNode[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = start.id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) break;
    ordered.push(node);
    cur = (outs.get(cur) ?? [])[0];
  }
  for (const n of pipeline.nodes) {
    if (!seen.has(n.id)) ordered.push(n);
  }
  return ordered;
}

export function rebuildLinearEdges(nodeIds: string[]): ModePipeline["edges"] {
  const edges: ModePipeline["edges"] = [];
  for (let i = 0; i < nodeIds.length - 1; i++) {
    edges.push({
      id: `e_${nodeIds[i]}_${nodeIds[i + 1]}_${i}`,
      from: nodeIds[i]!,
      to: nodeIds[i + 1]!,
    });
  }
  return edges;
}

export function removePipelineNode(pipeline: ModePipeline, nodeId: string): ModePipeline {
  const node = pipeline.nodes.find((n) => n.id === nodeId);
  if (!node) return pipeline;
  if (isFixedPipelineNode(node)) {
    throw new Error(`cannot remove fixed node: ${node.type}`);
  }
  // T12: reject removal of non-deletable nodes.
  const constraints = positionConstraintsOf(node.type);
  if (constraints && !constraints.deletable) {
    throw new Error(`节点「${NODE_TYPE_LABELS[node.type]}」不可删除：属于固定骨架节点`);
  }
  const linear = walkLinearNodes(pipeline).filter((n) => n.id !== nodeId);
  // Ensure spine still has start/context/end
  if (!linear.some((n) => n.type === "start") || !linear.some((n) => n.type === "end")) {
    throw new Error("pipeline spine broken");
  }
  if (!linear.some((n) => n.type === "context_gather")) {
    throw new Error("context_gather is required");
  }
  // Deleting the last model-calling node would silently downgrade the mode to a
  // plain completion with no tools. Before deletions were persisted the factory
  // node came back on reload; now it would not, so guard it here.
  const isModelNode = (n: PipelineNode) =>
    n.type === "explore_tools" || n.type === "execute_tools";
  if (isModelNode(node) && !linear.some(isModelNode)) {
    throw new Error(
      `不能删除最后一个「${NODE_TYPE_LABELS[node.type]}」节点：流程至少需要一次模型调用`,
    );
  }
  // Record the deletion so the factory node is not merged back in on reload.
  // The type is only suppressed once no instance of it survives (repeatable
  // types such as 调用模型 may still have siblings).
  const removed = new Set(pipeline.removed ?? []);
  removed.add(removedIdKey(nodeId));
  if (!linear.some((n) => n.type === node.type)) removed.add(removedTypeKey(node.type));
  return ModePipelineSchema.parse({
    nodes: linear,
    edges: rebuildLinearEdges(linear.map((n) => n.id)),
    removed: [...removed],
  });
}

/** T12: slot ordering helper — returns -1 when the node has no slot constraint. */
function slotOrder(slot?: NodeTypePositionConstraints["slot"]): number {
  if (slot === "pre-model") return 0;
  if (slot === "mid") return 1;
  if (slot === "post-model") return 2;
  return -1;
}

export function findPipelineNode(
  pipeline: ModePipeline,
  type: PipelineNodeType,
): PipelineNode | undefined {
  return pipeline.nodes.find((n) => n.type === type);
}
/**
 * Merge overlay pipeline onto base by node id.
 * When overlay provides edges, orphaned nodes (present in merged nodes but not
 * connected by overlay edges — e.g. newly added base nodes) are automatically
 * inserted at their canonical position from the base edge order.
 */
export function mergePipeline(
  base: ModePipeline,
  overlay?: Partial<ModePipeline> | null,
): ModePipeline {
  if (!overlay) return ModePipelineSchema.parse(base);
  // Nodes the user deleted must not be re-introduced from the factory pipeline.
  // Only base nodes are filtered — anything the overlay still lists is kept.
  const removed = new Set(overlay.removed ?? base.removed ?? []);
  const byId = new Map(
    base.nodes.filter((n) => !isRemovedNode(removed, n)).map((n) => [n.id, { ...n }]),
  );
  if (overlay.nodes) {
    for (const on of overlay.nodes) {
      const prev = byId.get(on.id);
      if (prev) {
        byId.set(on.id, {
          ...prev,
          ...on,
          params: { ...prev.params, ...on.params },
        });
      } else {
        byId.set(on.id, on as PipelineNode);
      }
    }
  }
  const nodes = [...byId.values()];
  const edges = overlay.edges ?? base.edges;

  // Detect orphaned nodes: exist in merged set but not connected by overlay edges.
  // This happens when the base adds new nodes that the saved overlay doesn't know about.
  if (overlay.edges) {
    const connectedIds = new Set<string>();
    for (const e of edges) {
      connectedIds.add(e.from);
      connectedIds.add(e.to);
    }
    const mergedIds = new Set(nodes.map((n) => n.id));
    const orphans = [...mergedIds].filter((id) => !connectedIds.has(id));

    if (orphans.length > 0) {
      // Start from the order the user saved, then splice each base-only node in
      // after the nearest preceding factory node that survived. This preserves
      // user reordering and user-added nodes while adopting new factory nodes.
      const baseOrder = walkLinearNodes(base).map((n) => n.id);
      const ordered = walkLinearNodes({ nodes, edges, removed: [] })
        .map((n) => n.id)
        .filter((id) => mergedIds.has(id) && !orphans.includes(id));
      const slotOf = (id: string) =>
        slotOrder(positionConstraintsOf(byId.get(id)?.type ?? "start")?.slot);
      for (const id of baseOrder) {
        if (!mergedIds.has(id) || ordered.includes(id)) continue;
        const bi = baseOrder.indexOf(id);
        // Earliest legal slot: right after the nearest preceding factory node.
        let lo = 0;
        for (let j = bi - 1; j >= 0; j--) {
          const k = ordered.indexOf(baseOrder[j]!);
          if (k >= 0) { lo = k + 1; break; }
        }
        // Latest legal slot: right before the nearest following factory node.
        let hi = ordered.length;
        for (let j = bi + 1; j < baseOrder.length; j++) {
          const k = ordered.indexOf(baseOrder[j]!);
          if (k >= 0) { hi = k; break; }
        }
        hi = Math.max(lo, hi);
        // Within that range take the earliest position that keeps slot order
        // intact: stop before the first node whose slot is at or after ours.
        // A node must run before the stages it configures (the intent node sets
        // skipTaskDecompose, so it cannot land after 任务分解), while still
        // staying behind earlier-slot nodes the user added.
        const mySlot = slotOf(id);
        let at = hi;
        for (let i = lo; i < hi; i++) {
          if (mySlot >= 0 && slotOf(ordered[i]!) >= mySlot) { at = i; break; }
        }
        ordered.splice(at, 0, id);
      }
      // Keep the fixed spine intact: start first, end last.
      const spine = (type: PipelineNodeType) =>
        nodes.find((n) => n.type === type)?.id;
      const startId = spine("start");
      const endId = spine("end");
      const normalized = ordered.filter((id) => id !== startId && id !== endId);
      if (startId) normalized.unshift(startId);
      if (endId) normalized.push(endId);
      return ModePipelineSchema.parse({
        nodes,
        edges: rebuildLinearEdges(normalized),
        removed: [...removed],
      });
    }
  }

  return ModePipelineSchema.parse({ nodes, edges, removed: [...removed] });
}
