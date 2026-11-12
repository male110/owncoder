import { z } from "zod";

import type { ListedModel, ModelRef } from "@owncoder/llm/browser";
import { resolveApiFormat } from "@owncoder/llm/browser";
import {
  BUILTIN_AGENT_PROMPT,
  BUILTIN_SPEC_PROMPT,
} from "./builtin-prompts.js";

import {
  ModePipelineSchema,
  builtinAgentPipeline,
  builtinSpecPipeline,
  findPipelineNode,
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
  builtinSpecPipeline,
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

} from "./security-defaults.js";
export {
  BUILTIN_AGENT_PROMPT,
  BUILTIN_SPEC_PROMPT,
} from "./builtin-prompts.js";

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
    /** 用户自定义展示名；仅用于界面，`name` 仍是发给服务端的模型标识。 */
    displayName: z.string().optional(),
  })).default([]),
});

/** A model that can be selected for use. */
const AvailableModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerId: z.string(),
  /** 用户自定义展示名；仅用于界面，`name` 仍是发给服务端的模型标识。 */
  displayName: z.string().optional(),
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
  modes: z.object({
    spec: z.object({
      bash: z.enum(["deny", "readonly"]).default("deny"),
      allowSpecFiles: z.boolean().default(true),
      pipeline: ModePipelineSchema.default(() => builtinSpecPipeline()),
    }),
    agent: z.object({
      dangerousBashConfirm: z.boolean().default(true),
      /** 勾选后所有 bash 命令（含危险命令）不再弹出确认，直接执行。 */
      autoApproveBash: z.boolean().default(false),
      pipeline: ModePipelineSchema.default(() => builtinAgentPipeline()),
    }),
  }),
  context: z.object({

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
    /** bash 搜索命令（grep/rg/find/ls -R）自动排除的目录名列表。
     *  默认 [".owncoder"]；传空数组可关闭注入。 */
    searchExclusions: z.array(z.string()).default([".owncoder"]),
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
  skills: z
    .object({
      /** Master switch for the skills feature (catalog injection + use_skill tool). */
      enabled: z.boolean().default(true),
      /** Skill ids (`scope:name`) the user switched off; enabled skills are not persisted. */
      disabled: z.array(z.string()).default([]),
    })
    .default({ enabled: true, disabled: [] }),
});

export type SystemWorkflowConfig = z.infer<typeof SystemWorkflowConfigSchema>;
export type ContextConfig = SystemWorkflowConfig["context"];
export type SegmentRatios = ContextConfig["segments"];
export type Provider = z.infer<typeof ProviderSchema>;
export type AvailableModel = z.infer<typeof AvailableModelSchema>;
export type { ThinkingEffort, ModelRef, ApiFormat, ListedModel } from "@owncoder/llm/browser";
export { resolveApiFormat, API_FORMATS, isApiFormat, isOfficialAnthropicHost } from "@owncoder/llm/browser";

/** 界面展示名：用户自定义 displayName（或协议返回的 display_name）优先，其次 name。
 *  注意：`name` 才是发给服务端的模型标识，展示名仅影响界面显示。
 *  永不回落到 id：id 是内部/请求标识，不是给人看的名称；name 缺失时返回空串，
 *  由调用方决定降级展示（如分组场景归入空键组），避免把 id 当展示名泄漏到界面。 */
export function modelDisplayName(
  model: { name: string; displayName?: string; display_name?: string } | null | undefined,
): string {
  if (!model) return "";
  const custom = model.displayName?.trim() || model.display_name?.trim();
  return custom || model.name || "";
}

/** 模型能力分类；用于「获取所有模型」弹窗的分类浏览。 */
export type ModelCategory = "text" | "image" | "video" | "audio" | "embedding" | "other";

export const MODEL_CATEGORIES: readonly ModelCategory[] = [
  "text",
  "image",
  "video",
  "audio",
  "embedding",
  "other",
] as const;

/** 协议列表项 → 可持久化模型条目：`name` 固定为请求用的模型 id，
 *  展示名（display_name / 协议的 name）落到 displayName，避免把展示名发给服务端。 */
export function listedModelToEntry(
  model: ListedModel,
): { id: string; name: string; displayName?: string } {
  const fallback = model.display_name?.trim() || (model.name && model.name !== model.id ? model.name : "");
  return { id: model.id, name: model.id, ...(fallback ? { displayName: fallback } : {}) };
}

/** 分类判定顺序：越具体的能力越先匹配，未命中者归入文本。
 *  embedding 必须早于 image/audio：`text-image-embedding-3` 这类 id 同时含 image 关键词。 */
const CATEGORY_KEYWORDS: Array<[ModelCategory, string[]]> = [
  ["video", ["video", "sora", "kling", "veo", "wan2", "hailuo", "seedance", "animat"]],
  ["embedding", ["embed", "embedding", "bge", "gte-", "ada-002", "rerank", "reranker"]],
  ["image", ["image", "dall", "flux", "sd3", "sdxl", "stable-diffusion", "seedream", "imagen", "midjourney", "photon"]],
  ["audio", ["audio", "tts", "asr", "whisper", "speech", "voice", "sound", "music", "transcribe"]],
];

/** 按模型 id / 请求名的关键词推断能力分类。
 *  展示名（displayName / display_name）不参与判定：它可由用户自定义，且厂商常写成
 *  "Gemini 2.5 Flash (text, image & video input)" 这类描述，会把纯文本模型误归到视频页签。 */
export function modelCategory(
  model: { id: string; name: string; displayName?: string; display_name?: string },
): ModelCategory {
  const haystack = `${model.id} ${model.name}`.toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((k) => haystack.includes(k))) return category;
  }
  // 纯数字/版本号的 id 无法判断能力，归入其它；其余默认文本（对话）模型。
  return /^[\d.\-_]+$/.test(model.id) ? "other" : "text";
}

/** 模型系列（厂商）分组键，如 `deepseek-chat` / `DeepSeek-V4-Pro` → `deepseek`。
 *  扫描来源为展示名回落结果（display_name/displayName → name，永不回落到 id）：旧格式迁移条目
 *  （id 为 `model_<providerId>_<raw>`、name 为裸 raw）若直接扫 id，首段字母 `model`
 *  会被误当作系列词，导致所有迁移条目并入 "Model" 组；无 displayName 时取 name
 *  （如 `atria-dawn`）才能得到正确的系列键。
 *  来源可能带供应商/命名空间前缀（如 `atria/kimi-k2.7-code`），此时首段字母只是
 *  供应商名，会把不同系列的模型误并成一组；因此当含命名空间分隔符（`/` 或 `:`）
 *  时剥离首段，再取段首连续字母 ≥3 的系列词（`qwen3` → `qwen`），
 *  确保 `atria/kimi-k2.7-code` → `kimi` 而非 `atria`。 */
export function modelSeriesKey(
  model: { id: string; name: string; displayName?: string; display_name?: string },
): string {
  // 真实数据 id 可能带前导/尾随空格（服务端返回或手动输入带入），不 trim 会让
  // 首段字母匹配失败（" kimi" 的 /^[a-z]+/ 锚定段首落空）而误落到后续段（如 code），
  // 或把带空格的整段当作键，导致同一 kimi 系列被拆成不同分组。
  const id = modelDisplayName(model).trim().toLowerCase();
  // 命名空间分隔符（/ 或 :）明确区分供应商与系列；连字符/下划线/点不剥离，避免误伤裸 id。
  const nsMatch = id.match(/^([a-z]+)[\/:](.+)$/);
  const scanTarget = (nsMatch ? nsMatch[2]! : id).trim();
  const parts = scanTarget.split(/[-_./:]/);
  for (const part of parts) {
    const lead = part.match(/^[a-z]+/)?.[0] ?? "";
    if (lead.length >= 3) return lead;
  }
  // 无合格片段时回退到首个含字母的段（保留旧行为，如 "1.5-v2" → "v2"）。
  const found = parts.find((part) => /[a-z]/.test(part));
  if (found) return found;
  // 无字母片段（如纯数字 name "1234"）时返回空串：该条目没有可识别的系列词，
  // 归入空键组（组标签为空串），绝不回落到 id——id 不是展示名来源。
  return id.match(/[a-z]+/)?.[0] ?? "";
}

/** 分组键 → 展示用的系列名（首字母大写）。 */
export function modelSeriesLabel(key: string): string {
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : key;
}

/** 从展示名中提取系列前缀并保留原始大小写（如 "DeepSeek V4 Flash" → "DeepSeek"）。
 *  取首个空白分隔词，再取其中首个连续字母段；无字母或与分组键不一致时（如展示名回落
 *  到带供应商前缀的 name "atria/kimi-k2.7-code" 首词为 "atria"）回落为小写键首字母大写。 */
function seriesLabelFromDisplayName(displayName: string, key: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) return modelSeriesLabel(key);
  // "DeepSeek V4 Flash" → "DeepSeek"；"DeepSeek-V4-Pro" → "DeepSeek"；"glm-4" → "glm"。
  const seg = trimmed.split(/\s+/)[0].match(/[A-Za-z]+/)?.[0];
  // 展示名首词系列与分组键不一致时，以分组键为准，避免供应商前缀污染组名。
  if (!seg || seg.toLowerCase() !== key) return modelSeriesLabel(key);
  return seg;
}

/** 按系列分组并按组标签（分组名称）升序排序，组内模型按展示名排序。
 *  组显示标签取该组代表模型（组内展示名排序首个）展示名中的系列前缀，
 *  保留 display_name/name 的原始大小写（如 "DeepSeek" 而非 "DEEPSEEK"/"Deepseek"）。
 *  组间排序按标签的 localeCompare 升序（标签相同时回落键名升序）；空标签组
 *  （无可识别系列词的条目）排最后，避免空名组占据列表顶部。 */
export function groupModelsBySeries<
  T extends { id: string; name: string; displayName?: string; display_name?: string },
>(
  models: T[],
): Array<{ key: string; label: string; models: T[] }> {
  const map = new Map<string, T[]>();
  for (const m of models) {
    const key = modelSeriesKey(m);
    const list = map.get(key);
    if (list) list.push(m);
    else map.set(key, [m]);
  }
  return [...map.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => {
        const byName = modelDisplayName(a).localeCompare(modelDisplayName(b));
        return byName !== 0 ? byName : a.id.localeCompare(b.id);
      });
      return {
        key,
        label: seriesLabelFromDisplayName(modelDisplayName(sorted[0]), key),
        models: sorted,
      };
    })
    .sort((a, b) => {
      // 组间按分组名称（标签）升序；空标签组（""）排最后。
      const aEmpty = a.label ? 0 : 1;
      const bEmpty = b.label ? 0 : 1;
      if (aEmpty !== bEmpty) return aEmpty - bEmpty;
      return a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
    });
}

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

export const BUILTIN_WORKFLOW: SystemWorkflowConfig = SystemWorkflowConfigSchema.parse({
  version: 2,
  providers: [],
  selectedModels: [],
  modes: {
    spec: {
      bash: "deny",
      allowSpecFiles: true,
      pipeline: builtinSpecPipeline(),
    },
    agent: {
      dangerousBashConfirm: true,
      autoApproveBash: false,
      pipeline: builtinAgentPipeline(),
    },
  },
  context: {
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
    searchExclusions: [".owncoder"],
  },
  mcp: { servers: [] },
  skills: { enabled: true, disabled: [] },
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

/**
 * Legacy workflow.json files name the read-only mode "plan". The overlay type no
 * longer carries it, so reach in untyped to reuse its settings for "spec".
 */
function readLegacyPlanMode(
  overlay: WorkflowOverlay | null | undefined,
): Partial<SystemWorkflowConfig["modes"]["spec"]> | undefined {
  const plan = (overlay as { modes?: { plan?: Record<string, unknown> } } | null | undefined)
    ?.modes?.plan;
  if (!plan) return undefined;
  const { allowPlanFiles, ...rest } = plan;
  return { ...rest, ...(typeof allowPlanFiles === "boolean" ? { allowSpecFiles: allowPlanFiles } : {}) };
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
    modes: {
      spec: {
        ...builtin.modes.spec,
        // Legacy workflow.json files call this mode "plan" — migrate on load.
        ...(workflowOverlay?.modes?.spec ??
          readLegacyPlanMode(workflowOverlay)),
        pipeline: builtinSpecPipeline(),
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
    skills: {
      enabled: workflowOverlay?.skills?.enabled ?? builtin.skills.enabled,
      disabled: workflowOverlay?.skills?.disabled ?? builtin.skills.disabled,
    },
  };

  merged.modes.spec.bash =
    workflowOverlay?.modes?.spec?.bash ??
    readLegacyPlanMode(workflowOverlay)?.bash ??
    builtin.modes.spec.bash;
  merged.modes.agent.dangerousBashConfirm =
    workflowOverlay?.modes?.agent?.dangerousBashConfirm ?? builtin.modes.agent.dangerousBashConfirm;
  merged.modes.agent.autoApproveBash =
    workflowOverlay?.modes?.agent?.autoApproveBash ?? builtin.modes.agent.autoApproveBash;

  // allowSpecFiles sync into the spec-mode model node
  const specLlm = findPipelineNode(merged.modes.spec.pipeline, "explore_tools");
  if (specLlm && merged.modes.spec.allowSpecFiles === false) {
    specLlm.params = { ...specLlm.params, allowSpecFiles: false };
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
  spec: string;
  agent: string;
} {
  // Prompts are baked into the builtin pipeline nodes; there is no longer a
  // separate user-overridable `config.prompts` layer. The constants remain as
  // a defensive fallback if a node is ever missing.
  const specLlm = findPipelineNode(config.modes.spec.pipeline, "explore_tools");
  const draft = findPipelineNode(config.modes.spec.pipeline, "draft_plan");
  const exec = findPipelineNode(config.modes.agent.pipeline, "execute_tools");
  return {
    spec: (specLlm?.prompt || draft?.prompt || "").trim() || BUILTIN_SPEC_PROMPT.trim(),
    agent: (exec?.prompt || "").trim() || BUILTIN_AGENT_PROMPT.trim(),
  };
}

/**
 * Product runtime graph. After mergeWorkflow, saved overlays are discarded so
 * this is always the builtin pipeline (with hydrated prompts/params).
 */
export function modePipeline(config: SystemWorkflowConfig, mode: "spec" | "agent"): ModePipeline {
  return mode === "spec" ? config.modes.spec.pipeline : config.modes.agent.pipeline;
}

export function workflowFingerprint(config: SystemWorkflowConfig): string {
  const payload = JSON.stringify({
    providers: (config.providers ?? []).map((p: Provider) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl })),
    selectedModels: config.selectedModels ?? [],
    modes: {
      spec: {
        bash: config.modes.spec.bash,
        allowSpecFiles: config.modes.spec.allowSpecFiles,
        pipeline: pipelineFingerprint(config.modes.spec.pipeline),
      },
      agent: {
        dangerousBashConfirm: config.modes.agent.dangerousBashConfirm,
        autoApproveBash: config.modes.agent.autoApproveBash,
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
  mode: "spec" | "agent",
  nodeId: string,
  patch: Partial<PipelineNode>,
): SystemWorkflowConfig {
  const next = structuredClone(config);
  const pipe = mode === "spec" ? next.modes.spec.pipeline : next.modes.agent.pipeline;
  const idx = pipe.nodes.findIndex((n) => n.id === nodeId);
  if (idx < 0) return config;
  const prev = pipe.nodes[idx]!;
  pipe.nodes[idx] = {
    ...prev,
    ...patch,
    params: { ...prev.params, ...patch.params },
  };
  const t = pipe.nodes[idx]!.type;
  if (t === "explore_tools" && patch.params?.allowSpecFiles !== undefined) {
    next.modes.spec.allowSpecFiles = patch.params.allowSpecFiles;
  }
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

