import { z } from "zod";
import type { WritePolicy } from "@owncoder/shared";
import type { ModelRef } from "@owncoder/llm/browser";
import { resolveApiFormat } from "@owncoder/llm/browser";
import {
  BUILTIN_AGENT_PROMPT,
  BUILTIN_PLAN_PROMPT,
  ensureWebSearchGuidance,
  looksLikeChinese,
} from "./builtin-prompts.js";

import {
  ModePipelineSchema,
  builtinAgentPipeline,
  builtinPlanPipeline,
  findPipelineNode,
  hydratePipelinesFromLegacy,
  syncLegacyPromptsFromPipelines,
  type ModePipeline,
  type PipelineNode,
} from "./pipeline.js";


export {
  NODE_TYPE_LABELS,
  NODE_TYPE_HINTS,
  NODE_TYPE_PALETTE,
  ADDABLE_PIPELINE_TYPES,
  ModePipelineSchema,
  NODE_TYPE_REGISTRY,
  resolveNodeType,
  builtinPlanPipeline,
  builtinAgentPipeline,
  walkLinearNodes,
  findPipelineNode,
  positionConstraintsOf,
  isFixedPipelineNode,
  addPipelineNode,
  removePipelineNode,
  movePipelineNode,
  createPipelineNode,
  type PipelineNode,
  type PipelineNodeType,
  type ModePipeline,
  type NodeTypePositionConstraints,
  REACT_STEP_METAS,
  defaultReactSteps,
  reactStepMeta,
  type ReactStepConfig,
} from "./pipeline.js";
export {
  BUILTIN_SENSITIVE_FILES,
  BUILTIN_VALUE_REDACTION_FILES,
  BUILTIN_WHOLE_FILE_REDACTION_FILES,
  SENSITIVE_FILE_ALLOWLIST,
  SECURITY_STACK_COVERAGE,
  STRICT_WRITABLE_EXTENSIONS,
  STRICT_WRITABLE_FILENAMES,
} from "./security-defaults.js";
export {
  BUILTIN_AGENT_PROMPT,
  BUILTIN_PLAN_PROMPT,
  looksLikeChinese,
} from "./builtin-prompts.js";

export {
  VERIFICATION_COMMON,
  VERIFICATION_GUIDELINES,
  ERROR_RECOVERY_MATRIX,
  SAFETY_BOUNDARIES,
  CONTEXT_REFERENCE_GUIDE,
} from "./builtin-verification.js";

export { migratePipeline, LEGACY_PIPELINE_TYPES } from "./pipeline-migrator.js";
export {
  BUILTIN_TASK_DECOMPOSE_PROMPT,
} from "./task-decompose-prompt.js";


/** A single platform/provider configuration. */
const ProviderSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  baseUrl: z.string(),
  apiKey: z.string().default(""),
  /** Wire format. Keep unknown values for forward compatibility with newer protocols. */
  apiFormat: z.string().optional(),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
  })).default([]),
});

/** A model that can be selected for use. */
const AvailableModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerId: z.string(),
});

export const SystemWorkflowConfigSchema = z.object({
  version: z.literal(2),
  providers: z.array(ProviderSchema).default([]),
  selectedModels: z.array(AvailableModelSchema).default([]),
  // Legacy compatibility — converted to providers on load
  models: z.object({
    default: z.object({
      baseUrl: z.string().default("http://127.0.0.1:11434/v1"),
      apiKeyEnv: z.string().optional(),
      model: z.string().default("default"),
    }).optional(),
    plan: z.object({
      baseUrl: z.string().default("http://127.0.0.1:11434/v1"),
      apiKeyEnv: z.string().optional(),
      model: z.string().default("default"),
    }).optional(),
    agent: z.object({
      baseUrl: z.string().default("http://127.0.0.1:11434/v1"),
      apiKeyEnv: z.string().optional(),
      model: z.string().default("default"),
    }).optional(),
  }).optional(),
  prompts: z.object({
    /** English — used at runtime. */
    plan: z.string().default(""),
    agent: z.string().default(""),
    /** Chinese — UI display/edit layer. */
    planZh: z.string().default(""),
    agentZh: z.string().default(""),
    /** Which language the settings UI shows for prompts. */
    displayLang: z.enum(["zh", "en"]).default("en"),
  }),
  modes: z.object({
    plan: z.object({
      bash: z.enum(["deny", "readonly"]).default("deny"),
      allowPlanFiles: z.boolean().default(true),
      pipeline: ModePipelineSchema.default(() => builtinPlanPipeline()),
    }),
    agent: z.object({
      dangerousBashConfirm: z.boolean().default(true),
      pipeline: ModePipelineSchema.default(() => builtinAgentPipeline()),
    }),
  }),
  context: z.object({
    writePolicy: z
      .enum(["balanced", "strict", "loose"])
      .default("loose" satisfies WritePolicy),
    /** Total context window size in tokens. Presets: 64K/128K/256K/1M.
     *  Supports suffixes: K = ×1024, M = ×1024². */
    contextWindow: z.number().int().min(1024).default(131072),
    /** Percentage of contextWindow reserved for input (1-99). */
    inputRatio: z.number().int().min(1).max(99).default(80),
    /** Segment allocation ratios within the input budget. Must sum to 1.0. */
    segments: z.object({
      historyRatio: z.number().min(0).max(1).default(0.3),
      toolResultRatio: z.number().min(0).max(1).default(0.65),
      techStackRatio: z.number().min(0).max(1).default(0.05),
    }).default({}).superRefine((seg, ctx) => {
      const sum = seg.historyRatio + seg.toolResultRatio + seg.techStackRatio;
      if (sum < 0.01) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "At least one segment ratio must be > 0. All ratios are effectively zero.",
          path: [],
        });
      }
    }),
    mapTokens: z.number().int().min(0).default(2000),
  }),
  /** 思考强度控制 */
  thinking: z.object({
    /** 
     * 默认思考强度级别
     * - undefined: 不传参数，使用模型默认行为
     * - 'none'/'off'/'disabled': 关闭思考模式
     * - 'low'/'minimal': 轻量思考，速度快
     * - 'medium': 中等思考（部分模型支持）
     * - 'high': 深度思考（推荐）
     * - 'max': 最大思考强度
     */
    defaultEffort: z.enum(['none', 'off', 'disabled', 'low', 'minimal', 'medium', 'high', 'max']).default('high'),
  }).default({ defaultEffort: 'high' }),
  index: z.object({
    // Symbol index is always enabled; `enabled` was removed as a setting.
    extraIgnore: z.array(z.string()).default([]),
  }),
  harness: z.object({
    patchFirst: z.literal(true).default(true),
    /** Max chars for file-read tool output. ~2000 lines × 12 chars avg = 24000.
     *  Aligns with Claude Code's 2000-line page budget. */
    toolOutputMaxChars: z.number().int().min(512).default(24000),
    /** Soft max chars for the in-memory history payload sent to the model.
     *  Used by compactNow() and the manual /compact command. */
    historyMaxChars: z.number().int().default(24000),
    /** Max chars kept for a single tool output when compacting older turns.
     *  Matches Claude Code's ~2KB per-tool-turn compaction target. */
    compactionToolMaxChars: z.number().int().default(2000),
    /** Max chars for bash / type_check / lsp_diagnostics output.
     *  Claude Code caps bash output at ~8KB; 10000 gives a small buffer. */
    bashMaxChars: z.number().int().default(10000),
    checkpoint: z.boolean().default(true),
    /** UI + LLM reply language: follow OS, Chinese, or English. */
    locale: z.enum(["system", "zh", "en"]).default("system"),
    /** 执行阶段单独配置：开启后 React 循环使用单独的模型和思考强度 */
    separateStageModels: z.boolean().default(false),
    /** React 循环阶段模型名称（开启 separateStageModels 时生效，否则使用 selectedModels[0]） */
    reactModel: z.string().optional(),
    /** React 循环阶段模型所属 provider；旧配置缺失时按模型 id/name 自动推断。 */
    reactProviderId: z.string().optional(),
    /** React 循环阶段思考强度（开启 separateStageModels 时生效，否则使用 thinking.defaultEffort） */
    reactThinkingEffort: z.enum(["none", "off", "disabled", "low", "minimal", "medium", "high", "max"]).optional(),
  }),
  mcp: z
    .object({
      servers: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().optional(),
            command: z.string().min(1),
            args: z.array(z.string()).default([]),
            env: z.record(z.string()).optional(),
            enabled: z.boolean().default(true),
          }),
        )
        .default([]),
    })
    .default({ servers: [] }),
  secrets: z
    .object({
      /** Enable secret redaction before sending to LLM. */
      enabled: z.boolean().default(true),
      /** User-defined sensitive file glob patterns (added to built-in list). */
      sensitiveFiles: z.array(z.string()).default([]),
      /** User-defined regex patterns for detecting sensitive values. */
      patterns: z.array(z.string()).default([]),
    })
    .default({ enabled: true, sensitiveFiles: [], patterns: [] }),
});

export type SystemWorkflowConfig = z.infer<typeof SystemWorkflowConfigSchema>;
export type ContextConfig = SystemWorkflowConfig["context"];
export type SegmentRatios = ContextConfig["segments"];
export type Provider = z.infer<typeof ProviderSchema>;
export type AvailableModel = z.infer<typeof AvailableModelSchema>;
export type { ThinkingEffort, ModelRef, ApiFormat } from "@owncoder/llm/browser";
export { resolveApiFormat, API_FORMATS, isApiFormat, isOfficialAnthropicHost } from "@owncoder/llm/browser";

/** Model settings stored in a dedicated `models.json` (providers + selected models,
 *  plus the legacy `models` field for v1 migration). Kept separate from workflow
 *  so "restore factory" can reset pipelines/prompts without wiping model config. */
export const ModelSettingsSchema = SystemWorkflowConfigSchema.pick({
  providers: true,
  selectedModels: true,
  models: true,
});
export const ModelSettingsOverlaySchema = ModelSettingsSchema.deepPartial().extend({
  version: z.union([z.literal(1), z.literal(2)]).optional(),
});
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;
export type ModelSettingsOverlay = z.infer<typeof ModelSettingsOverlaySchema>;
export const BUILTIN_MODEL_SETTINGS: ModelSettings = ModelSettingsSchema.parse({
  providers: [],
  selectedModels: [],
});

/** Deep-partial overlay for the workflow.json file. Excludes model settings
 *  (providers/selectedModels/legacy models), which live in models.json. */
export const WorkflowOverlaySchema = SystemWorkflowConfigSchema
  .omit({ providers: true, selectedModels: true, models: true })
  .deepPartial()
  .extend({ version: z.union([z.literal(1), z.literal(2)]).optional() });
export type WorkflowOverlay = z.infer<typeof WorkflowOverlaySchema>;

const BUILTIN_PROMPTS = {
  plan: BUILTIN_PLAN_PROMPT.trim(),
  agent: BUILTIN_AGENT_PROMPT.trim(),
  planZh: "",
  agentZh: "",
} as const;

export const BUILTIN_WORKFLOW: SystemWorkflowConfig = SystemWorkflowConfigSchema.parse({
  version: 2,
  providers: [],
  selectedModels: [],
  prompts: {
    plan: BUILTIN_PROMPTS.plan,
    agent: BUILTIN_PROMPTS.agent,
    planZh: BUILTIN_PROMPTS.planZh,
    agentZh: BUILTIN_PROMPTS.agentZh,
    displayLang: "en",
  },
  modes: {
    plan: {
      bash: "deny",
      allowPlanFiles: true,
      pipeline: builtinPlanPipeline(),
    },
    agent: {
      dangerousBashConfirm: true,
      pipeline: builtinAgentPipeline(),
    },
  },
  context: {
    writePolicy: "loose",
    contextWindow: 131072,
    inputRatio: 80,
    segments: {
      historyRatio: 0.3,
      toolResultRatio: 0.65,
      techStackRatio: 0.05,
    },
    mapTokens: 2000,
  },
  thinking: { defaultEffort: "high" },
  index: { extraIgnore: [] },
  harness: {
    patchFirst: true,
    toolOutputMaxChars: 24000,
    historyMaxChars: 24000,
    compactionToolMaxChars: 2000,
    bashMaxChars: 10000,
    checkpoint: true,
    locale: "system",
  },
  mcp: { servers: [] },
});

function pipelineFingerprint(p: ModePipeline): unknown {
  return {
    edges: p.edges.map((e) => `${e.from}->${e.to}`),
    removed: [...(p.removed ?? [])].sort(),
    nodes: p.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      enabled: n.enabled !== false,
      promptLen: n.prompt?.length ?? 0,
      promptHead: (n.prompt ?? "").slice(0, 48),
      model: n.model ?? "",
      params: n.params ?? {},
    })),
  };
}

export function mergeWorkflow(
  builtin: SystemWorkflowConfig,
  workflowOverlay?: WorkflowOverlay | null,
  modelOverlay?: ModelSettingsOverlay | null,
  // Kept only for source compatibility with older callers. All workflow
  // settings are user-level and must never be changed by a workspace file.
  _project?: WorkflowOverlay | null,
): SystemWorkflowConfig {
  // Build without spreading to avoid legacy `models` field contamination.
  // A workspace may contain rules and project memories, but never workflow
  // settings (especially provider credentials and selected models).
  const merged: SystemWorkflowConfig = {
    version: 2 as const,
    providers: modelOverlay?.providers ?? builtin.providers,
    selectedModels: modelOverlay?.selectedModels ?? builtin.selectedModels,
    prompts: {
      plan: workflowOverlay?.prompts?.plan ?? builtin.prompts.plan,
      agent: workflowOverlay?.prompts?.agent ?? builtin.prompts.agent,
      planZh: workflowOverlay?.prompts?.planZh ?? builtin.prompts.planZh,
      agentZh: workflowOverlay?.prompts?.agentZh ?? builtin.prompts.agentZh,
      displayLang: workflowOverlay?.prompts?.displayLang ?? builtin.prompts.displayLang ?? "en",
    },
    modes: {
      plan: {
        ...builtin.modes.plan,
        ...workflowOverlay?.modes?.plan,
        pipeline: builtinPlanPipeline(),
      },
      agent: {
        ...builtin.modes.agent,
        ...workflowOverlay?.modes?.agent,
        pipeline: builtinAgentPipeline(),
      },
    },
    context: {
      ...builtin.context,
      ...workflowOverlay?.context,
      segments: {
        ...builtin.context.segments,
        ...workflowOverlay?.context?.segments,
      },
    },
    thinking: {
      ...builtin.thinking,
      ...workflowOverlay?.thinking,
    },
    index: {
      ...builtin.index,
      ...workflowOverlay?.index,
      extraIgnore: workflowOverlay?.index?.extraIgnore ?? builtin.index.extraIgnore,
    },
    harness: {
      ...builtin.harness,
      ...workflowOverlay?.harness,
      patchFirst: true as const,
      // Checkpoints are no longer user-configurable (UI entry removed);
      // pin the effective behavior to the default (enabled) while the
      // schema keeps accepting `false` in existing workflow.json files.
      checkpoint: true as const,
    },
    mcp: {
      servers: workflowOverlay?.mcp?.servers ?? builtin.mcp.servers,
    },
    secrets: {
      enabled: workflowOverlay?.secrets?.enabled ?? builtin.secrets.enabled,
      sensitiveFiles: workflowOverlay?.secrets?.sensitiveFiles ?? builtin.secrets.sensitiveFiles,
      patterns: workflowOverlay?.secrets?.patterns ?? builtin.secrets.patterns,
    },
  };

  merged.modes.plan.bash = workflowOverlay?.modes?.plan?.bash ?? builtin.modes.plan.bash;
  merged.modes.agent.dangerousBashConfirm =
    workflowOverlay?.modes?.agent?.dangerousBashConfirm ?? builtin.modes.agent.dangerousBashConfirm;

  // Chinese display layer is no longer shipped; keep empty when missing.
  if (!merged.prompts.planZh?.trim()) {
    merged.prompts.planZh = "";
  }
  if (!merged.prompts.agentZh?.trim()) {
    merged.prompts.agentZh = "";
  }
  merged.prompts.plan = ensureWebSearchGuidance(merged.prompts.plan);
  merged.prompts.agent = ensureWebSearchGuidance(merged.prompts.agent);
  merged.prompts.planZh = ensureWebSearchGuidance(merged.prompts.planZh, "zh");
  merged.prompts.agentZh = ensureWebSearchGuidance(merged.prompts.agentZh, "zh");
  // Product path is the builtin graph only; saved pipeline overlays are ignored.
  hydratePipelinesFromLegacy(merged);
  syncLegacyPromptsFromPipelines(merged);

  // save_plan / allowPlanFiles sync
  const save = findPipelineNode(merged.modes.plan.pipeline, "save_plan");
  if (save && merged.modes.plan.allowPlanFiles === false) {
    save.enabled = false;
  }
  const planLlm = findPipelineNode(merged.modes.plan.pipeline, "explore_tools");
  if (planLlm && merged.modes.plan.allowPlanFiles === false) {
    planLlm.params = { ...planLlm.params, allowPlanFiles: false };
  }

  return SystemWorkflowConfigSchema.parse(merged);
}

/** Merge builtin model settings with a user/model overlay (from models.json). */
export function mergeModelSettings(
  builtin: ModelSettings,
  overlay?: ModelSettingsOverlay | null,
): ModelSettings {
  return ModelSettingsSchema.parse({
    providers: overlay?.providers ?? builtin.providers,
    selectedModels: overlay?.selectedModels ?? builtin.selectedModels,
  });
}

/** Split a v2 config (or migrated raw object) into model-settings and
 *  workflow-overlay halves for persistence to models.json / workflow.json. */
export function splitConfigForPersistence(
  config: SystemWorkflowConfig,
): { model: ModelSettingsOverlay; workflow: WorkflowOverlay } {
  const { version: _v, providers, selectedModels, models: _models, ...rest } = config;
  return {
    model: { version: 2, providers, selectedModels },
    workflow: { version: 2, ...rest } as WorkflowOverlay,
  };
}

export function resolvePrompts(config: SystemWorkflowConfig): {
  plan: string;
  agent: string;
} {
  const planLlm = findPipelineNode(config.modes.plan.pipeline, "explore_tools");
  const draft = findPipelineNode(config.modes.plan.pipeline, "draft_plan");
  const exec = findPipelineNode(config.modes.agent.pipeline, "execute_tools");
  return {
    plan:
      (planLlm?.prompt || draft?.prompt || config.prompts.plan).trim() ||
      BUILTIN_PROMPTS.plan,
    agent: (exec?.prompt || config.prompts.agent).trim() || BUILTIN_PROMPTS.agent,
  };
}

/**
 * Product runtime graph. After mergeWorkflow, saved overlays are discarded so
 * this is always the builtin pipeline (with hydrated prompts/params).
 */
export function modePipeline(config: SystemWorkflowConfig, mode: "plan" | "agent"): ModePipeline {
  return mode === "plan" ? config.modes.plan.pipeline : config.modes.agent.pipeline;
}

export function workflowFingerprint(config: SystemWorkflowConfig): string {
  const payload = JSON.stringify({
    providers: (config.providers ?? []).map((p: Provider) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl })),
    selectedModels: config.selectedModels ?? [],
    prompts: {
      planLen: config.prompts.plan.length,
      agentLen: config.prompts.agent.length,
      planHead: config.prompts.plan.slice(0, 64),
      agentHead: config.prompts.agent.slice(0, 64),
    },
    modes: {
      plan: {
        bash: config.modes.plan.bash,
        allowPlanFiles: config.modes.plan.allowPlanFiles,
        pipeline: pipelineFingerprint(config.modes.plan.pipeline),
      },
      agent: {
        dangerousBashConfirm: config.modes.agent.dangerousBashConfirm,
        pipeline: pipelineFingerprint(config.modes.agent.pipeline),
      },
    },
    context: config.context,
    index: config.index,
    harness: config.harness,
    mcp: { serverIds: config.mcp.servers.map((s) => s.id) },
  });
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    hash = (hash * 31 + payload.charCodeAt(i)) | 0;
  }
  return `wf_${(hash >>> 0).toString(16)}`;
}


/** Patch a pipeline node in-place on a cloned config (UI helper). */
export function updatePipelineNode(
  config: SystemWorkflowConfig,
  mode: "plan" | "agent",
  nodeId: string,
  patch: Partial<PipelineNode>,
): SystemWorkflowConfig {
  const next = structuredClone(config);
  const pipe = mode === "plan" ? next.modes.plan.pipeline : next.modes.agent.pipeline;
  const idx = pipe.nodes.findIndex((n) => n.id === nodeId);
  if (idx < 0) return config;
  const prev = pipe.nodes[idx]!;
  pipe.nodes[idx] = {
    ...prev,
    ...patch,
    params: { ...prev.params, ...patch.params },
  };
  const t = pipe.nodes[idx]!.type;
  if ((t === "draft_plan" || t === "explore_tools") && patch.prompt !== undefined) {
    next.prompts.plan = patch.prompt;
  }
  if ((t === "draft_plan" || t === "explore_tools") && patch.promptZh !== undefined) {
    next.prompts.planZh = patch.promptZh;
  }
  if (t === "execute_tools" && patch.prompt !== undefined) {
    next.prompts.agent = patch.prompt;
  }
  if (t === "execute_tools" && patch.promptZh !== undefined) {
    next.prompts.agentZh = patch.promptZh;
  }
  if (t === "save_plan" && patch.enabled !== undefined) {
    next.modes.plan.allowPlanFiles = patch.enabled;
  }
  if (t === "explore_tools" && patch.params?.allowPlanFiles !== undefined) {
    next.modes.plan.allowPlanFiles = patch.params.allowPlanFiles;
  }
  syncLegacyPromptsFromPipelines(next);
  return SystemWorkflowConfigSchema.parse(next);
}

/**
 * Materialize bilingual prompts before persist:
 * - Chinese side changed (English didn't) → translate zh→en (runtime prompt).
 * - English side changed (Chinese didn't) → translate en→zh (display prompt).
 * Only the edited side is translated. If both sides changed (e.g. factory
 * restore) or neither changed, nothing is translated. `translate(text, target)`
 * picks the direction.
 */
export async function materializeEnglishPrompts(
  config: SystemWorkflowConfig,
  translate: (text: string, target: "en" | "zh") => Promise<string>,
  baseline?: SystemWorkflowConfig | null,
): Promise<SystemWorkflowConfig> {
  const next = structuredClone(config);

  const toEn = async (text: string): Promise<string> => {
    const t = text.trim();
    if (!t) return "";
    if (!looksLikeChinese(t)) return t;
    return (await translate(t, "en")).trim();
  };
  const toZh = async (text: string): Promise<string> => {
    const t = text.trim();
    if (!t) return "";
    return (await translate(t, "zh")).trim();
  };

  // Legacy plan/agent prompt pairs
  for (const mode of ["plan", "agent"] as const) {
    const zhKey = mode === "plan" ? "planZh" : "agentZh";
    const enKey = mode === "plan" ? "plan" : "agent";
    const zhChanged = !baseline || next.prompts[zhKey] !== baseline.prompts[zhKey];
    const enChanged = !baseline || next.prompts[enKey] !== baseline.prompts[enKey];
    if (zhChanged && !enChanged) {
      if (next.prompts[zhKey].trim()) next.prompts[enKey] = await toEn(next.prompts[zhKey]);
    } else if (enChanged && !zhChanged) {
      if (next.prompts[enKey].trim()) next.prompts[zhKey] = await toZh(next.prompts[enKey]);
    }
  }

  for (const mode of ["plan", "agent"] as const) {
    const pipe = mode === "plan" ? next.modes.plan.pipeline : next.modes.agent.pipeline;
    const basePipe = baseline
      ? mode === "plan"
        ? baseline.modes.plan.pipeline
        : baseline.modes.agent.pipeline
      : null;
    for (const node of pipe.nodes) {
      const baseNode = basePipe?.nodes.find((n) => n.id === node.id);
      const zhChanged = !baseline || !baseNode || node.promptZh !== baseNode.promptZh;
      const enChanged = !baseline || !baseNode || node.prompt !== baseNode.prompt;
      if (zhChanged && !enChanged) {
        if (node.promptZh && node.promptZh.trim()) node.prompt = await toEn(node.promptZh);
      } else if (enChanged && !zhChanged) {
        if (node.prompt && node.prompt.trim()) node.promptZh = await toZh(node.prompt);
      }
    }
  }

  hydratePipelinesFromLegacy(next);
  syncLegacyPromptsFromPipelines(next);
  return SystemWorkflowConfigSchema.parse(next);
}



/** Migrate legacy v1 models.default/plan/agent → v2 providers + selectedModels */
export function migrateLegacyModels(config: Record<string, unknown>): Record<string, unknown> {
  if (config.version === 2) return config;

  const models = config.models as Record<string, unknown> | undefined;
  if (!models) {
    // If the config already carries v2 fields (providers/selectedModels), it was
    // incorrectly saved as v1 — just upgrade the version without data loss.
    if (config.providers || config.selectedModels) {
      return { ...config, version: 2 };
    }
    return { ...config, version: 2, providers: [], selectedModels: [] };
  }

  const providers: Array<Record<string, unknown>> = [];
  const selectedModels: Array<Record<string, unknown>> = [];

  const defaultModel = models.default as { baseUrl?: string; model?: string; apiKeyEnv?: string } | undefined;
  const planModel = models.plan as { baseUrl?: string; model?: string; apiKeyEnv?: string } | undefined;
  const agentModel = models.agent as { baseUrl?: string; model?: string; apiKeyEnv?: string } | undefined;

  // Collect unique baseUrls
  const baseUrlSet = new Map<string, { baseUrl: string; apiKeyEnv?: string }>();
  for (const m of [defaultModel, planModel, agentModel]) {
    if (m?.baseUrl) {
      const key = m.baseUrl;
      if (!baseUrlSet.has(key)) {
        baseUrlSet.set(key, { baseUrl: m.baseUrl, apiKeyEnv: m.apiKeyEnv });
      }
    }
  }

  // Create providers from unique baseUrls
  let pi = 0;
  for (const [, info] of baseUrlSet) {
    const providerId = `provider_${pi}`;
    const providerModels: Array<{ id: string; name: string }> = [];

    // Add models from this baseUrl
    for (const m of [defaultModel, planModel, agentModel]) {
      if (m?.baseUrl === info.baseUrl && m?.model) {
        const modelId = `model_${providerId}_${m.model}`;
        if (!providerModels.some((pm) => pm.id === modelId)) {
          providerModels.push({ id: modelId, name: m.model });
        }
      }
    }

    const name = info.baseUrl.includes("openai") ? "OpenAI"
      : info.baseUrl.includes("ollama") || info.baseUrl.includes("11434") ? "Ollama"
      : info.baseUrl.includes("anthropic") ? "Anthropic"
      : info.baseUrl.includes("deepseek") ? "DeepSeek"
      : `平台 ${pi + 1}`;

    providers.push({
      id: providerId,
      name,
      baseUrl: info.baseUrl,
      apiKey: info.apiKeyEnv ?? "",
      models: providerModels,
    });

    // Add to selectedModels
    for (const pm of providerModels) {
      selectedModels.push({
        id: pm.id,
        name: pm.name,
        providerId,
      });
    }

    pi++;
  }

  const result = { ...config, version: 2, providers, selectedModels } as Record<string, unknown>;
  delete result.models;
  return result;
}

/** Build ModelRef from selected models for LLM calls.
 *  Returns the first selected model, or a fallback. */
export function getActiveModelRef(config: SystemWorkflowConfig): ModelRef {
  const sel = config.selectedModels ?? [];
  const providers = config.providers ?? [];

  if (sel.length > 0) {
    const first = sel[0]!;
    const provider = providers.find((p: Provider) => p.id === first.providerId);
    const baseUrl = provider?.baseUrl ?? "http://127.0.0.1:11434/v1";
    return {
      baseUrl,
      model: first.name,
      providerId: first.providerId,
      apiKey: provider?.apiKey,
      apiFormat: resolveApiFormat({ apiFormat: provider?.apiFormat, baseUrl }),
    };
  }

  const fallbackUrl = "http://127.0.0.1:11434/v1";
  return {
    baseUrl: fallbackUrl,
    model: "default",
    apiFormat: resolveApiFormat({ baseUrl: fallbackUrl }),
  };
}

