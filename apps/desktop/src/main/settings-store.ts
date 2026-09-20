import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {

  BUILTIN_WORKFLOW,
  ModelSettingsOverlaySchema,
  WorkflowOverlaySchema,
  mergeWorkflow,
  workflowFingerprint,
  migrateLegacyModels,
  migratePipeline,
  LEGACY_PIPELINE_TYPES,
  splitConfigForPersistence,
  type ModelSettingsOverlay,
  type SystemWorkflowConfig,
  type WorkflowOverlay,
} from "@owncoder/settings";

/** console.{warn,info} can throw EPIPE when the Electron process is launched
 *  without a console (stdout/stderr pipes are closed). This wrapper suppresses
 *  those errors so the app doesn't crash on startup. */
function safeLog(method: "warn" | "info", ...args: unknown[]): void {
	try {
		console[method](...args);
	} catch {
		// EPIPE or similar — the output stream is gone, nothing to do
	}
}

export interface SettingsSnapshot {
  effective: SystemWorkflowConfig;
  builtin: SystemWorkflowConfig;
  userOverlay: WorkflowOverlay | null;
  modelOverlay: ModelSettingsOverlay | null;
  fingerprint: string;
  paths: {
    userDir: string;
    userWorkflow: string;
    userModels: string;
  };
  hasUserOverride: boolean;
  matchesBuiltin: boolean;
}

/** Remove deprecated pipeline node types (e.g. "think", "intent") before schema validation.
 *  When removing a node, reconnect its incoming edges to its outgoing edges so the chain stays connected. */
function stripDeprecatedNodes(data: Record<string, unknown>): Record<string, unknown> {
  const deprecated = new Set(["think", "intent"]);
  const modes = data.modes as Record<string, unknown> | undefined;
  if (!modes) return data;
  for (const modeKey of ["plan", "agent"]) {
    const mode = modes[modeKey] as Record<string, unknown> | undefined;
    const pipeline = mode?.pipeline as Record<string, unknown> | undefined;
    const nodes = pipeline?.nodes as Array<Record<string, unknown>> | undefined;
    const edges = pipeline?.edges as Array<Record<string, unknown>> | undefined;
    if (!nodes || !pipeline) continue;
    const removedIds = new Set<string>();
    const filteredNodes = nodes.filter((n) => {
      if (typeof n.type === "string" && deprecated.has(n.type)) {
        if (typeof n.id === "string") removedIds.add(n.id);
        return false;
      }
      return true;
    });
    pipeline.nodes = filteredNodes;
    if (edges && removedIds.size > 0) {
      // For each removed node, reconnect predecessors → successors
      for (const removedId of removedIds) {
        const predecessors = edges
          .filter((e) => e.to === removedId)
          .map((e) => e.from as string);
        const successors = edges
          .filter((e) => e.from === removedId)
          .map((e) => e.to as string);
        for (const pred of predecessors) {
          for (const succ of successors) {
            // Add bypass edge if it doesn't already exist
            const exists = edges.some(
              (e) => e.from === pred && e.to === succ,
            );
            if (!exists) {
              edges.push({ id: `bypass_${pred}_${succ}`, from: pred, to: succ });
            }
          }
        }
      }
      // Remove all edges touching deprecated nodes
      pipeline.edges = edges.filter(
        (e) =>
          typeof e.from === "string" &&
          typeof e.to === "string" &&
          !removedIds.has(e.from) &&
          !removedIds.has(e.to),
      );
    }
  }
  return data;
}

function readOverlay(file: string): WorkflowOverlay | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const stripped = stripDeprecatedNodes(raw as Record<string, unknown>);
    const migrated = migrateLegacyModels(stripped);
    return WorkflowOverlaySchema.parse(migrated);
  } catch (e) {
    safeLog("warn", `[settings] failed to parse ${file}:`, e);
    return null;
  }
}

function readModelOverlay(file: string): ModelSettingsOverlay | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const migrated = migrateLegacyModels(raw as Record<string, unknown>);
    return ModelSettingsOverlaySchema.parse(migrated);
  } catch (e) {
    safeLog("warn", `[settings] failed to parse ${file}:`, e);
    return null;
  }
}

/** Migrate legacy pipeline nodes (load_anchors/draft_plan/save_plan and the two
 *  removed intent routers) in effective config after merge. Surfaces a report via
 *  console so drops are not silent (spec 5.4). */
function migratePipelines(config: SystemWorkflowConfig): SystemWorkflowConfig {
  for (const modeKey of ["plan", "agent"] as const) {
    const pipeline = config.modes[modeKey].pipeline;
    const hasLegacy = pipeline.nodes.some((n) => LEGACY_PIPELINE_TYPES.has(n.type));
    if (hasLegacy) {
      const { newPipeline, report } = migratePipeline(pipeline);
      config.modes[modeKey].pipeline = newPipeline;
      const moves = report.moved.map((m) => `${m.fromType}(${m.fromId})→${m.toType}(${m.toId})`);
      const drops = report.dropped.map((d) => `${d.fromType}(${d.fromId}): ${d.reason}`);
      safeLog("warn",
        `[settings] ${modeKey} pipeline migrated: moved [${moves.join(", ")}] dropped [${drops.join(", ")}]`,
      );
    }
  }
  return config;
}

/** Read a raw JSON object from disk, or null when missing/unreadable. */
function readRawJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    safeLog("warn", `[settings] failed to read ${file}:`, e);
    return null;
  }
}

export class SettingsStore {
  private userDir: string;
  private cached: SystemWorkflowConfig = BUILTIN_WORKFLOW;
  private migrationChecked = false;
  private currentRoot: string | null = null;

  constructor(userDataDir: string) {
    this.userDir = join(userDataDir, "owncoder");
    mkdirSync(this.userDir, { recursive: true });
  }

  get userWorkflowPath(): string {
    return join(this.userDir, "workflow.json");
  }

  get userModelsPath(): string {
    return join(this.userDir, "models.json");
  }

  /** Directory used for global user data (memories, etc.). */
  get memoriesDir(): string {
    return this.userDir;
  }

  /**
   * One-time migration: older versions kept providers/selectedModels/legacy
   * `models` inside workflow.json. Move the model half into models.json and
   * trim workflow.json to workflow-only fields. Idempotent.
   */
  private ensureMigrated(): void {
    if (this.migrationChecked) return;
    this.migrationChecked = true;
    const raw = readRawJson(this.userWorkflowPath);
    if (!raw) return;
    const hasModelFields =
      "providers" in raw || "selectedModels" in raw || "models" in raw || raw.version === 1;
    if (!hasModelFields) return;
    try {
      const migrated = migrateLegacyModels(raw);
      const providers = (migrated.providers ?? []) as unknown[];
      const selectedModels = (migrated.selectedModels ?? []) as unknown[];
      const { providers: _p, selectedModels: _s, models: _m, ...workflowPart } = migrated;
      // Don't overwrite an existing models.json (user may have already created one).
      if (!existsSync(this.userModelsPath)) {
        writeFileSync(
          this.userModelsPath,
          JSON.stringify({ version: 2, providers, selectedModels }, null, 2),
          "utf8",
        );
      }
      writeFileSync(
        this.userWorkflowPath,
        JSON.stringify({ ...workflowPart, version: 2 }, null, 2),
        "utf8",
      );
      safeLog("info", "[settings] split providers/selectedModels out of workflow.json into models.json");
    } catch (e) {
      safeLog("warn", "[settings] workflow→models split migration failed:", e);
    }
  }

  /**
   * Imports a pre-global settings file only when this computer has no global
   * configuration yet. It preserves existing users' preferences and ensures
   * the migrated values survive deleting the workspace's .owncoder directory.
   */
  setProjectRoot(root: string | null): void {
    if (root === this.currentRoot) return;
    if (!existsSync(this.userWorkflowPath) && !existsSync(this.userModelsPath) && root) {
      const legacyWorkflowPath = join(root, ".owncoder", "workflow.json");
      const legacy = readRawJson(legacyWorkflowPath);
      if (legacy) {
        try {
          const migrated = migrateLegacyModels(legacy);
          const providers = (migrated.providers ?? []) as unknown[];
          const selectedModels = (migrated.selectedModels ?? []) as unknown[];
          const { providers: _p, selectedModels: _s, models: _m, ...workflowPart } = migrated;
          writeFileSync(
            this.userModelsPath,
            JSON.stringify({ version: 2, providers, selectedModels }, null, 2),
            "utf8",
          );
          writeFileSync(
            this.userWorkflowPath,
            JSON.stringify({ ...workflowPart, version: 2 }, null, 2),
            "utf8",
          );
          safeLog("info", `[settings] migrated legacy workspace settings to ${this.userDir}`);
        } catch (e) {
          safeLog("warn", "[settings] legacy workspace migration failed:", e);
        }
      }
    }
    this.migrationChecked = false;
    this.ensureMigrated();
    this.reload();
    this.currentRoot = root;
  }

  reload(): SystemWorkflowConfig {
    this.ensureMigrated();
    const user = readOverlay(this.userWorkflowPath);
    const model = readModelOverlay(this.userModelsPath);
    this.cached = migratePipelines(mergeWorkflow(BUILTIN_WORKFLOW, user, model));
    return this.cached;
  }

  getEffective(): SystemWorkflowConfig {
    return this.cached;
  }

  snapshot(): SettingsSnapshot {
    this.ensureMigrated();
    const user = readOverlay(this.userWorkflowPath);
    const model = readModelOverlay(this.userModelsPath);
    const effective = migratePipelines(mergeWorkflow(BUILTIN_WORKFLOW, user, model));
    this.cached = effective;
    const fingerprint = workflowFingerprint(effective);
    const builtinFp = workflowFingerprint(BUILTIN_WORKFLOW);
    return {
      effective,
      builtin: BUILTIN_WORKFLOW,
      userOverlay: user,
      modelOverlay: model,
      fingerprint,
      paths: {
        userDir: this.userDir,
        userWorkflow: this.userWorkflowPath,
        userModels: this.userModelsPath,
      },
      hasUserOverride: user !== null || model !== null,
      matchesBuiltin: fingerprint === builtinFp,
    };
  }

  private writeWorkflowOverlay(overlay: WorkflowOverlay): void {
    const parsed = WorkflowOverlaySchema.parse({ ...overlay, version: overlay.version ?? 2 });
    // Always persist patchFirst true — hard harness rule.
    if (parsed.harness) {
      parsed.harness = { ...parsed.harness, patchFirst: true };
    }
    writeFileSync(this.userWorkflowPath, JSON.stringify(parsed, null, 2), "utf8");
  }

  private writeModelOverlay(overlay: ModelSettingsOverlay): void {
    const parsed = ModelSettingsOverlaySchema.parse({ ...overlay, version: 2 });
    writeFileSync(this.userModelsPath, JSON.stringify(parsed, null, 2), "utf8");
  }

  /** Replace user overlay with a full (or partial) workflow and re-merge. */
  saveUserOverlay(overlay: WorkflowOverlay): SystemWorkflowConfig {
    this.writeWorkflowOverlay(overlay);
    return this.reload();
  }

  /** Save the current settings while retaining pipeline overrides unless that mode changed.
   *  Model settings (providers/selectedModels) are persisted to models.json; the rest to workflow.json. */
  saveEffectiveAsUser(config: SystemWorkflowConfig): SystemWorkflowConfig {
    const migrated = migrateLegacyModels(config as unknown as Record<string, unknown>) as unknown as SystemWorkflowConfig;
    const { model, workflow } = splitConfigForPersistence(migrated);

    // Persist the model half to models.json.
    this.writeModelOverlay(model);

    // Build the workflow overlay, preserving untouched builtin pipelines.
    const overlay = workflow;
    const existing = readOverlay(this.userWorkflowPath);
    for (const mode of ["plan", "agent"] as const) {
      if (JSON.stringify(migrated.modes[mode].pipeline) !== JSON.stringify(this.cached.modes[mode].pipeline)) {
        continue;
      }
      const modeOverlay = overlay.modes?.[mode];
      if (!modeOverlay || !overlay.modes) continue;
      const existingPipeline = existing?.modes?.[mode]?.pipeline;
      if (existingPipeline) {
        overlay.modes[mode] = { ...modeOverlay, pipeline: structuredClone(existingPipeline) };
      } else {
        const { pipeline: _pipeline, ...withoutPipeline } = modeOverlay;
        overlay.modes[mode] = withoutPipeline;
      }
    }

    this.writeWorkflowOverlay(overlay);
    return this.reload();
  }

  /** Remove only one global pipeline override so the current builtin graph is used. */
  restoreUserPipeline(mode: "plan" | "agent"): SystemWorkflowConfig {
    const existing = readOverlay(this.userWorkflowPath);
    if (!existing?.modes?.[mode]?.pipeline) return this.reload();

    const next = structuredClone(existing);
    const modeOverlay = next.modes?.[mode];
    if (next.modes && modeOverlay) {
      const { pipeline: _pipeline, ...withoutPipeline } = modeOverlay;
      if (Object.keys(withoutPipeline).length > 0) {
        next.modes[mode] = withoutPipeline;
      } else {
        delete next.modes[mode];
      }
      if (Object.keys(next.modes).length === 0) delete next.modes;
    }
    return this.saveUserOverlay(next);
  }

  /** Restore factory workflow defaults (prompts/pipelines/context/harness/…).
   *  Model settings (providers/selectedModels in models.json) and API keys are preserved. */
  restoreFactory(): SystemWorkflowConfig {
    if (existsSync(this.userWorkflowPath)) {
      rmSync(this.userWorkflowPath, { force: true });
    }
    // Also clear optional prompt override files if present
    for (const name of ["plan.system.md", "agent.system.md"]) {
      const p = join(this.userDir, "prompts", name);
      if (existsSync(p)) rmSync(p, { force: true });
    }
    // Reload merges builtin workflow with the preserved models.json.
    this.migrationChecked = true;
    return this.reload();
  }
}
