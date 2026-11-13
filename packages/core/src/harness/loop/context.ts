import type { ChatMessage } from "@owncoder/llm";
import type { PipelineNode } from "@owncoder/settings";
import { extractPathsFromPlan } from "../../plans.ts";
import { extractMentionPaths, formatMentionsBlock, loadMentionedFiles } from "../../mentions.ts";
import { contextBudgets, computeContextBudget, type ContextBudget, type FixedSegments } from "../budget.ts";
import { estimateTokens, PerformanceTimer } from "../observability.ts";
import { IS_WINDOWS, OS_RELEASE, PLATFORM } from "../tools/shared.ts";
import type { MemoryManager } from "../memory.ts";
import { documentIntentContext } from "./document-workflow.ts";
import { detectProjectEcosystem } from "./project-ecosystem.ts";
import {
  inferTaskIntent,
  planMinimumContext,
  resolveMinimumContextConfig,
  summarizeMinimumContextPlan,
  type ContextCandidate,
} from "./minimum-context.ts";
import { emitStage } from "./stages.ts";
import { ContextControlState, resolveContextControlConfig } from "./context-control.ts";
import { queryIndexNavigation, renderNavigationBlock } from "../index-navigation.ts";
import type { AgentLoopOpts } from "./types.ts";

export interface BuildContextArgs {
  opts: AgentLoopOpts;
  memory: MemoryManager;
  /** @deprecated Use tokenBudget when available. Kept for backward compat. */
  budgets: ReturnType<typeof contextBudgets>;
  /** Token-based budget (computed internally in buildInitialContext). */
  tokenBudget?: ContextBudget;
  systemPrompt: string;
  contextNode: PipelineNode | undefined;
  anchorsNode: PipelineNode | undefined;
  messages: ChatMessage[];
}

export interface BuildContextResult {
  budgetUsed: number;
  /** Ephemeral controls shared with the later ReAct stage in this turn. */
  contextControl: ContextControlState;
  /** Fixed segment sizes measured during context assembly. */
  fixedSegments: FixedSegments;
  /** Token-based context budget computed from fixed segments. */
  tokenBudget: ContextBudget;
}

/**
 * Translate a character-oriented context bucket into a token capacity using the
 * actual language mix of the blocks being considered. This avoids assuming the
 * English-only 4-char approximation for Chinese/code-heavy prompts.
 */
function proportionalTokenCapacity(
  characterBudget: number,
  knownCharacters: number,
  knownTokens: number,
): number {
  if (characterBudget <= 0 || knownCharacters <= 0 || knownTokens <= 0) return 0;
  return Math.max(0, Math.floor(knownTokens * Math.min(1, characterBudget / knownCharacters)));
}

/**
 * 索引导航候选（index-navigation）：从用户消息提取标识符查 ftsSearch，
 * 渲染成有界导航块。失败 / 空结果一律 undefined（调用方跳过入池）。
 * 导出仅为单测；生产唯一消费方是 buildInitialContext。
 */
export async function buildIndexNavigationCandidate(
  index: AgentLoopOpts["index"],
  userMessage: string,
): Promise<Omit<ContextCandidate, "id" | "estimatedTokens"> | undefined> {
  try {
    const hits = await queryIndexNavigation(index, userMessage);
    if (!hits || hits.length === 0) return undefined;
    return {
      source: "index-navigation",
      content: renderNavigationBlock("## Index navigation starting points", hits),
      path: hits[0]!.path,
      provenance: "index ftsSearch",
      freshness: "indexed",
    };
  } catch {
    return undefined;
  }
}

/**
 * Assemble initial context into `messages`.
 *
 * Sources are collected with the existing parallel I/O pattern, then an
 * independent, deterministic policy chooses the smallest sufficient set of
 * optional blocks. Rules, explicit mentions, active work state, and document
 * workflow context remain mandatory; indexed search snippets navigate the
 * model to the right files.
 */
export async function buildInitialContext(args: BuildContextArgs): Promise<BuildContextResult> {
  const { opts, memory, budgets, systemPrompt, contextNode, anchorsNode, messages } = args;
  const timer = new PerformanceTimer();
  const log = (step: string, detail?: Record<string, unknown>) => {
    console.log(`[context] ${step} +${timer.elapsedFormatted()}`, detail ?? "");
    timer.reset();
  };

  const ctxEnabled = !contextNode || contextNode.enabled !== false;
  const ctxParams = (contextNode?.params ?? {}) as Record<string, unknown>;
  const contextControl = new ContextControlState(
    opts.workspaceRoot,
    resolveContextControlConfig(ctxParams.contextControl),
  );
  const anchorsEnabled =
    opts.mode === "agent" &&
    (anchorsNode ? anchorsNode.enabled !== false : ctxParams.injectAnchors !== false);
  const mentionPaths = extractMentionPaths(opts.userMessage);
  const activePaths = opts.activePlan ? extractPathsFromPlan(opts.activePlan.content) : [];
  const selectionMode = resolveMinimumContextConfig(ctxParams.contextSelection, 0).mode;

  if (contextNode && ctxEnabled) emitStage(opts.onEvent, "start", contextNode);
  log("stage_start emitted");

  const basePromptTokens = estimateTokens(systemPrompt);
  let budgetUsed = basePromptTokens;
  let contextCharsUsed = systemPrompt.length;
  // Preserve the pre-selection high-water behavior for `off` and `observe`.
  // It intentionally tracks only the old optional memory sources.
  let legacyOptionalBudgetUsed = basePromptTokens;
  
  // Track platform info separately as a fixed segment
  let platformInfoTokens = 0;

  // Import message tagging utilities for semantic content wrapping
  const {
    tagPlatformInfo,
    tagProjectContext,
    tagMemory,
  } = await import("../message-tags.js");
  
  // Track which semantic sections we're building
  const projectContextParts: string[] = [];
  
  const pushSystem = (content: string, tag?: "platform" | "project" | "memory"): void => {
    if (!content.trim()) return;
    
    // If a semantic tag is specified, collect it for later wrapping
    if (tag === "project") {
      projectContextParts.push(content);
      budgetUsed += estimateTokens(content);
      contextCharsUsed += content.length;
      return;
    }
    
    // For other tags, wrap immediately
    let wrappedContent = content;
    if (tag === "platform") {
      wrappedContent = tagPlatformInfo(content);
      platformInfoTokens += estimateTokens(content);
    } else if (tag === "memory") {
      wrappedContent = tagMemory(content);
    }
    
    messages.push({ role: "system", content: wrappedContent });
    budgetUsed += estimateTokens(content); // Use original content for token counting
    contextCharsUsed += content.length;
  };

  pushSystem(buildPlatformInfo(), "platform");

  // Tech stack, project size, and project rules are now candidates (truncatable).
  // They will be added to the candidate pool later.
  
  const mentionPromise =
    ctxEnabled && ctxParams.injectMentions !== false
      ? loadMentionedFiles(opts.workspaceRoot, mentionPaths)
      : Promise.resolve([]);

  const candidates: ContextCandidate[] = [];
  let candidateNumber = 0;
  const addCandidate = (
    candidate: Omit<ContextCandidate, "id" | "estimatedTokens"> & { id?: string },
  ): void => {
    const content = candidate.content.trim();
    if (!content) return;
    candidates.push({
      ...candidate,
      content,
      id: candidate.id ?? `${candidate.source}:${candidateNumber}`,
      estimatedTokens: estimateTokens(content),
    });
    candidateNumber += 1;
  };

  // ── Add tech stack as truncatable candidate ──
  if (ctxEnabled) {
    try {
      const idxStatus = opts.index.status();
      const techStackLines: string[] = [];
      if (idxStatus.root) {
        techStackLines.push(`- Workspace root: \`${idxStatus.root}\``);
      }
      if (typeof idxStatus.fileCount === "number" && idxStatus.fileCount > 0) {
        techStackLines.push(`- Indexed source files: ${idxStatus.fileCount}`);
      }
      if (typeof idxStatus.tagCount === "number" && idxStatus.tagCount > 0) {
        techStackLines.push(`- Indexed symbols: ${idxStatus.tagCount}`);
      }
      // Note: idxStatus.kind is the index build state (idle/building/ready/error),
      // not the project kind, so it is deliberately not surfaced here.
      const ecosystems = await detectProjectEcosystem(opts.workspaceRoot);
      if (ecosystems.length > 0) {
        techStackLines.push(`- Detected project stack: ${ecosystems.join("; ")}`);
      } else {
        techStackLines.push(
          "- Detected project stack: unknown (no recognized manifest such as pom.xml, build.gradle, package.json or Cargo.toml found at the workspace root).",
        );
      }
      if (techStackLines.length > 0) {
        addCandidate({
          source: "tech-stack",
          content: [
            "## Project Tech Stack",
            ...techStackLines,
            "- Use `repo_map` / `read_file` for deeper structure on demand, and the `glob` tool (not shell `ls`/`find`) for file listings — the summary above is intentionally compact.",
          ].join("\n"),
          provenance: "project tech stack",
          freshness: "current",
          mandatory: false, // Truncatable
        });
      }
    } catch {
      // Index not ready or unavailable — skip silently
    }
  }

  // ── Add project size as truncatable candidate ──
  if (ctxEnabled) {
    try {
      const idxStatus = opts.index.status();
      if (typeof idxStatus.fileCount === "number" && idxStatus.fileCount > 0) {
        const isLarge = idxStatus.fileCount >= 1500;
        addCandidate({
          source: "project-size",
          content: [
            "## Project Size",
            `- Indexed source files: ${idxStatus.fileCount}`,
            isLarge
              ? "- This is a **large project** (≥1500 source files). Do NOT run full build commands (mvn compile, mvn verify, mvn package, gradle build, cargo build, npm run build, etc.). Use targeted checks only (type_check, lsp_diagnostics, or bash for specific commands)."
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
          provenance: "project size information",
          freshness: "current",
          mandatory: false, // Truncatable
        });
      }
    } catch {
      // Index not ready or unavailable — skip silently
    }
  }

  // ── Add project rules as truncatable candidate ──
  if (ctxEnabled && ctxParams.injectRules !== false && opts.projectRules?.trim()) {
    addCandidate({
      source: "rules",
      content: `## Project rules\nFollow these project-specific rules unless the user explicitly overrides them.\n\n${opts.projectRules.trim()}`,
      provenance: "project-specific rules",
      freshness: "current",
      mandatory: false, // Truncatable
    });
  }

  // ── Available skills catalog (mandatory: the model must know skills exist
  // to invoke use_skill; the catalog is name/description only, bodies load
  // on demand via the tool) ──
  if (ctxEnabled && ctxParams.injectSkills !== false && opts.skillsCatalog?.trim()) {
    addCandidate({
      source: "skills",
      content: opts.skillsCatalog.trim(),
      provenance: "available skills catalog",
      freshness: "current",
      mandatory: true,
    });
  }

  if (ctxEnabled && ctxParams.injectMemories !== false && opts.memoriesBlock?.trim()) {
    addCandidate({
      source: "memory",
      content: opts.memoriesBlock,
      provenance: "saved user preferences",
      freshness: "current",
      mandatory: true,
    });
  }

  const knowledgeCtx = memory.getKnowledgeContext(opts.userMessage);
  if (
    ctxEnabled &&
    knowledgeCtx.trim() &&
    (selectionMode === "apply" || legacyOptionalBudgetUsed < budgets.total * 0.7)
  ) {
    const cap = Math.min(
      Math.floor(budgets.system * 0.2),
      Math.floor((budgets.total - legacyOptionalBudgetUsed) * 0.5),
    );
    if (cap > 100) {
      const content = knowledgeCtx;
      addCandidate({
        source: "knowledge",
        content,
        provenance: "session knowledge",
        freshness: "unknown",
      });
      legacyOptionalBudgetUsed += estimateTokens(content);
    }
  }

  const shortTermCtx = memory.getShortTermContext();
  if (
    ctxEnabled &&
    shortTermCtx.trim() &&
    opts.history.length > 2 &&
    (selectionMode === "apply" || legacyOptionalBudgetUsed < budgets.total * 0.75)
  ) {
    const cap = Math.min(
      Math.floor(budgets.system * 0.15),
      Math.floor((budgets.total - legacyOptionalBudgetUsed) * 0.4),
    );
    if (cap > 100) {
      const content = shortTermCtx;
      addCandidate({
        source: "short-term",
        content,
        provenance: "recent working memory",
        freshness: "unknown",
      });
      legacyOptionalBudgetUsed += estimateTokens(content);
    }
  }

  const mentionFiles = await mentionPromise;
  log("mentions loaded", { count: mentionFiles.length });
  if (ctxEnabled && ctxParams.injectMentions !== false) {
    const mentionsBlock = formatMentionsBlock(mentionFiles);
    if (mentionsBlock.trim()) {
      addCandidate({
        source: "mention",
        content: mentionsBlock,
        provenance: "explicit user @ mention",
        freshness: "current",
        mandatory: true,
      });
    }
  }

  if (anchorsEnabled) {
    if (anchorsNode) emitStage(opts.onEvent, "start", anchorsNode);
    if (opts.activePlan) {
      const planBody = opts.activePlan.content;
      addCandidate({
        source: "spec",
        path: opts.activePlan.path,
        content: [
          "## ACTIVE PLAN",
          `Path: ${opts.activePlan.path}`,
          activePaths.length ? `Hint writable files: ${activePaths.slice(0, 20).join(", ")}` : "",
          "",
          planBody,
        ].filter(Boolean).join("\n"),
        provenance: "active plan",
        freshness: "current",
        mandatory: true,
      });
    } else if (opts.todoAnchor?.trim()) {
      addCandidate({
        source: "todo",
        content: `## ACTIVE TODO\n${opts.todoAnchor.trim()}`,
        provenance: "active todo",
        freshness: "current",
        mandatory: true,
      });
    }
    if (anchorsNode) emitStage(opts.onEvent, "done", anchorsNode);
  }

  if (opts.documentWorkflow) {
    addCandidate({
      source: "workflow",
      content: `## DOCUMENT WORKFLOW\n${documentIntentContext(opts.documentWorkflow)}`,
      provenance: "document workflow state",
      freshness: "current",
      mandatory: true,
    });
  }

  // 索引导航候选（检索优先的探索起点）：用户消息 → 标识符 → ftsSearch
  // 召回 → 按文件聚合。freshness=indexed 用于
  // registerIndexedCandidates 溯源（读取记账 / 失效跟踪）。
  // best-effort：索引不可用 / 空结果 / 抛错 → 不入池，行为与现状一致。
  if (ctxEnabled && opts.requestRoute?.mode !== "precise_single_file" && opts.requestRoute?.mode !== "simple_direct") {
    const navCandidate = await buildIndexNavigationCandidate(opts.index, opts.userMessage);
    if (navCandidate) addCandidate(navCandidate);
  }

  // Knowledge graph population (index → memory). Repo map / deps are
  // available on demand via `repo_map` / `project_deps` tools.
  if (ctxEnabled && !opts.disableKnowledgeGraph) {
    try {
      await memory.populateFromIndex(opts.index, opts.workspaceRoot);
      log("knowledge graph populated");
    } catch {
      /* knowledge graph population is best effort */
    }
  }

  // ── Compute token-based budget ──
  // Use new token-based budget system alongside legacy budgets for transition.
  // Fixed segments separate platform info from optional content (tech stack,
  // project size, rules moved to candidates).
  const fixedSegments: FixedSegments = {
    systemPrompt: basePromptTokens, // Built-in prompt and fixed tool guidance
    platformInfo: platformInfoTokens,      // Platform information (OS, shell, etc)
    toolDefs: 0,                          // @reserved — currently included in systemPrompt
    userInput: estimateTokens(opts.userMessage),
    taskDecomposition: 0,                 // @reserved — no independent task decomposition step yet
    activePlan: opts.activePlan ? estimateTokens(opts.activePlan.content) : 0,
    documentWorkflow: 0,                  // @reserved — tracked separately when workflow is active
  };
  const tokenBudget = computeContextBudget(opts.workflow.context, fixedSegments);

  // Emit overCapacity warning if fixed segments exceed input budget
  if (tokenBudget.overCapacity) {
    opts.onEvent?.({
      type: "context_warning",
      message: `Fixed segments (${tokenBudget.fixedTotal} tokens) exceed input budget (${tokenBudget.inputBudget} tokens). Consider increasing contextWindow.`,
      fixedTotal: tokenBudget.fixedTotal,
      inputBudget: tokenBudget.inputBudget,
    });
    console.warn("[context] overCapacity:", {
      fixedTotal: tokenBudget.fixedTotal,
      inputBudget: tokenBudget.inputBudget,
    });
  }

  const candidateCharacters = candidates.reduce((total, candidate) => total + candidate.content.length, 0);
  const candidateTokens = candidates.reduce((total, candidate) => total + candidate.estimatedTokens, 0);
  // Use token budget for capacity when available, with legacy fallback
  const promptTokenCapacity = proportionalTokenCapacity(
    tokenBudget.inputBudget,
    contextCharsUsed + candidateCharacters,
    budgetUsed + candidateTokens,
  );
  const defaultSelectionTokenBudget = proportionalTokenCapacity(
    tokenBudget.segments.toolResults + tokenBudget.segments.techStack,
    candidateCharacters,
    candidateTokens,
  );
  const requestedSelectionConfig = resolveMinimumContextConfig(
    ctxParams.contextSelection,
    defaultSelectionTokenBudget,
  );
  const availableCandidateTokens = Math.max(0, promptTokenCapacity - budgetUsed);
  const selectionConfig = requestedSelectionConfig.mode === "off"
    ? requestedSelectionConfig
    : {
        ...requestedSelectionConfig,
        tokenBudget: Math.min(requestedSelectionConfig.tokenBudget, availableCandidateTokens),
      };

  const contextPlan = planMinimumContext({
    task: {
      mode: opts.mode,
      intent: inferTaskIntent(opts.userMessage, opts.mode),
      query: opts.userMessage,
      explicitPaths: mentionPaths,
      activePaths,
    },
    candidates,
    config: selectionConfig,
  });
  // Apply mode is the production guardrail: only planner-selected candidates
  // enter the model context. Observe/off intentionally preserve the legacy full
  // projection so operators can compare decisions without changing behavior.
  const materialized = selectionConfig.mode === "apply"
    ? contextPlan.selected
    : candidates;

  // Register only index-derived file labels, never their excerpts. Omitted
  // candidates are retained too so a later focused current-source read has a
  // complete, per-turn provenance trail without needing to materialize content.
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  contextControl.registerIndexedCandidates([
    ...contextPlan.selected
      .filter((candidate) => candidate.freshness === "indexed" && Boolean(candidate.path))
      .map((candidate) => ({
        path: candidate.path!,
        source: candidate.source,
        selection: "selected" as const,
      })),
    ...contextPlan.omitted.flatMap((omitted) => {
      const candidate = candidateById.get(omitted.id);
      return candidate?.freshness === "indexed" && candidate.path
        ? [{ path: candidate.path, source: candidate.source, selection: "omitted" as const }]
        : [];
    }),
  ]);

  if (selectionConfig.mode === "observe" || selectionConfig.emitDecisionTrace) {
    console.log("[minimum-context]", JSON.stringify({
      ...summarizeMinimumContextPlan(contextPlan),
      promptTokenCapacity,
      availableCandidateTokens,
      materializedCandidateCount: materialized.length,
    }));
  }

  for (const candidate of materialized) {
    // Tag content based on its source type
    switch (candidate.source) {
      case "memory":
      case "knowledge":
      case "short-term":
        pushSystem(candidate.content, "memory");
        break;
      case "tech-stack":
      case "project-size":
      case "rules":
        // These are project context candidates (truncatable)
        pushSystem(candidate.content, "project");
        break;
      default:
        pushSystem(candidate.content);
    }
  }
  
  // Wrap all collected project context parts with semantic tag.
  // 工具选择规则已在内置系统提示词中，这里只放真正的项目上下文；空则不占一条消息。
  const wrappedProjectContext = tagProjectContext(projectContextParts.join("\n\n"));
  if (wrappedProjectContext) messages.push({ role: "system", content: wrappedProjectContext });

  if (contextNode && ctxEnabled) emitStage(opts.onEvent, "done", contextNode);
  log("stage_done emitted", {
    budgetUsed,
    promptTokenCapacity,
    overCapacity: budgetUsed > promptTokenCapacity,
    selected: contextPlan.selected.length,
    omitted: contextPlan.omitted.length,
    mode: selectionConfig.mode,
  });

  if (contextControl.telemetryEnabled) {
    opts.onEvent?.({
      type: "minimum_context_decision",
      selectionMode: selectionConfig.mode,
      selectedCandidates: contextPlan.selected.length,
      omittedCandidates: contextPlan.omitted.length,
      materializedCandidates: materialized.length,
      indexedPaths: contextControl.indexedPathCount,
      budgetUsed,
      tokenBudget: contextPlan.tokenBudget,
    });
  }

  return { budgetUsed, contextControl, fixedSegments, tokenBudget };
}

// ── Platform Info ────────────────────────────────────────────

function buildPlatformInfo(): string {
  let osName: string;
  let pathSep: string;
  let shellHint: string;

  if (IS_WINDOWS) {
    osName = "Windows";
    pathSep = "\\";
    shellHint = "The current runtime environment is Windows. **Terminal commands are executed with PowerShell semantics; please use PowerShell syntax.**";
  } else if (PLATFORM === "darwin") {
    osName = "macOS";
    pathSep = "/";
    shellHint = "You are running on **macOS** with a Unix shell. Standard Unix commands are safe to use.";
  } else {
    osName = "Linux";
    pathSep = "/";
    shellHint = "You are running on **Linux** with a Unix shell. Standard Unix commands are safe to use.";
  }

  return [
    "## Platform Info",
    `- OS: ${osName} (${PLATFORM})`,
    `- Release: ${OS_RELEASE}`,
    `- Path separator: \`${pathSep}\``,
    `- ${shellHint}`,
    "",
  ].join("\n");
}
