/**
 * IPC handlers: settings, secrets, LLM auth, model list, prompt translation.
 */
import { dialog, ipcMain } from "electron";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import {
  BUILTIN_SENSITIVE_FILES,
  ModelSettingsSchema,
  SystemWorkflowConfigSchema,
  WorkflowOverlaySchema,
  getActiveModelRef,
  type SystemWorkflowConfig,
  type WorkflowOverlay,
} from "@owncoder/settings";
import { isRedactionEnabled, isSensitiveFile, redactSecrets } from "@owncoder/core";
import {
  getCodec,
  isLikelyLocalLlm,
  resolveApiFormat,
  resolveApiKey,
  type ApiFormat,
} from "@owncoder/llm";
import type { IpcContext } from "./types";
import { mt } from "../i18n";

function findRedactionRulePath(
  filePath: string,
  workspaceRoot: string | null,
  patterns: readonly string[],
): string | null {
  const candidates: string[] = [];
  if (workspaceRoot) {
    const workspaceRelative = relative(workspaceRoot, filePath);
    if (workspaceRelative && !workspaceRelative.startsWith("..") && !isAbsolute(workspaceRelative)) {
      candidates.push(workspaceRelative);
    }
  }

  // For files outside the workspace, try path suffixes so rules such as
  // "config/production.json" still work without treating the absolute path as
  // a project-relative rule path.
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    candidates.push(segments.slice(i).join("/"));
  }

  for (const candidate of [...new Set(candidates)]) {
    if (isSensitiveFile(candidate, patterns)) return candidate;
  }
  return null;
}

const MAX_REDACTION_TEST_BYTES = 10 * 1024 * 1024;
const MAX_REDACTION_PREVIEW_CHARS = 80 * 1024;

export function registerSettingsHandlers(ctx: IpcContext): void {
  const { session, settingsStore, secretsStore } = ctx;

  // ── Settings ──────────────────────────────────────────────────────────────

  ipcMain.handle("settings:get", () => settingsStore.snapshot());

  ipcMain.handle("settings:save", (_e, config: SystemWorkflowConfig) => {
    const parsed = SystemWorkflowConfigSchema.parse(config);
    const effective = settingsStore.saveEffectiveAsUser(parsed);
    session.setWorkflow(effective);
    return settingsStore.snapshot();
  });

  ipcMain.handle("settings:saveOverlay", (_e, overlay: WorkflowOverlay) => {
    const parsed = WorkflowOverlaySchema.parse(overlay);
    const effective = settingsStore.saveUserOverlay(parsed);
    session.setWorkflow(effective);
    return settingsStore.snapshot();
  });

  ipcMain.handle("settings:exportModels", async () => {
    const selection = await dialog.showSaveDialog({
      title: mt("导出模型设置"),
      defaultPath: "owncoder-model-settings.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (selection.canceled || !selection.filePath) return { status: "cancelled" as const };
    const current = settingsStore.getEffective();
    const payload = {
      type: "owncoder-model-settings",
      version: 1,
      providers: current.providers ?? [],
      selectedModels: current.selectedModels ?? [],
    };
    await writeFile(selection.filePath, JSON.stringify(payload, null, 2), "utf8");
    return { status: "success" as const, filePath: selection.filePath, count: payload.selectedModels.length };
  });

  ipcMain.handle("settings:importModels", async () => {
    const selection = await dialog.showOpenDialog({
      title: mt("导入模型设置"),
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (selection.canceled || selection.filePaths.length === 0) return { status: "cancelled" as const };

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(selection.filePaths[0]!, "utf8"));
      const input = parsed as Record<string, unknown>;
      if (input.type !== "owncoder-model-settings") throw new Error("Invalid model settings file");
      const imported = ModelSettingsSchema.parse({
        providers: input.providers,
        selectedModels: input.selectedModels,
      });
      const current = settingsStore.getEffective();
      const providers = structuredClone(current.providers ?? []);
      const selectedModels = structuredClone(current.selectedModels ?? []);
      const providerIds = new Set(providers.map((provider) => provider.id));
      const modelKeys = new Set(selectedModels.map((model) => `${model.providerId}\u0000${model.id}`));
      let added = 0;
      let skipped = 0;
      for (const provider of imported.providers) {
        const existingProvider = providers.find((item) => item.id === provider.id);
        if (!existingProvider) {
          providers.push(provider);
          providerIds.add(provider.id);
          continue;
        }
        const existingModelIds = new Set((existingProvider.models ?? []).map((model) => model.id));
        for (const model of provider.models ?? []) {
          if (!existingModelIds.has(model.id)) {
            existingProvider.models = [...(existingProvider.models ?? []), model];
            existingModelIds.add(model.id);
          }
        }
      }
      for (const model of imported.selectedModels) {
        const key = `${model.providerId}\u0000${model.id}`;
        if (modelKeys.has(key)) {
          skipped++;
          continue;
        }
        selectedModels.push(model);
        modelKeys.add(key);
        added++;
      }
      const effective = settingsStore.saveEffectiveAsUser({ ...current, providers, selectedModels });
      session.setWorkflow(effective);
      return { status: "success" as const, added, skipped, invalid: 0, snapshot: settingsStore.snapshot() };
    } catch (error) {
      return {
        status: "error" as const,
        added: 0,
        skipped: 0,
        invalid: 1,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle("settings:restoreFactory", () => {
    const effective = settingsStore.restoreFactory();
    session.setWorkflow(effective);
    return settingsStore.snapshot();
  });

  ipcMain.handle("settings:restorePipeline", (_e, mode: unknown) => {
    if (mode !== "plan" && mode !== "agent") {
      throw new Error("Invalid pipeline mode");
    }
    const effective = settingsStore.restoreUserPipeline(mode);
    session.setWorkflow(effective);
    return settingsStore.snapshot();
  });

  // ── Secrets ───────────────────────────────────────────────────────────────

  ipcMain.handle("secrets:get", () => secretsStore.load());

  ipcMain.handle("secrets:setLlmApiKey", (_e, apiKey: string | null) => {
    const next = secretsStore.save({ llmApiKey: apiKey });
    session.setLlmApiKey(next.llmApiKey);
    return next;
  });

  ipcMain.handle("security:pickAndPreview", async () => {
    const selection = await dialog.showOpenDialog({
      title: mt("选择要测试脱敏的文件"),
      properties: ["openFile"],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return { status: "cancelled" as const };
    }

    const filePath = selection.filePaths[0]!;
    const workflow = settingsStore.getEffective();
    const sensitiveFiles = [
      ...BUILTIN_SENSITIVE_FILES,
      ...(workflow.secrets?.sensitiveFiles ?? []),
    ];
    const rulePath = findRedactionRulePath(
      filePath,
      session.getState().workspace?.root ?? null,
      sensitiveFiles,
    );

    if (!isRedactionEnabled(workflow)) {
      return {
        status: "error" as const,
        message: mt("当前未启用敏感信息脱敏，请先启用后再测试。"),
      };
    }

    try {
      const fileInfo = await stat(filePath);
      if (fileInfo.size > MAX_REDACTION_TEST_BYTES) {
        return {
          status: "error" as const,
          message: mt("文件过大，脱敏测试仅支持 10 MB 以内的文件。"),
        };
      }
      const source = await readFile(filePath, "utf8");
      const previewPath = rulePath ?? basename(filePath);
      const wholeFilePatterns = [
        ...BUILTIN_SENSITIVE_FILES,
        ...(workflow.secrets?.sensitiveFiles ?? []),
      ];
      const preview = redactSecrets(source, previewPath, {
        sensitiveFiles: workflow.secrets?.sensitiveFiles,
        patterns: workflow.secrets?.patterns,
      });
      const truncated = preview.text.length > MAX_REDACTION_PREVIEW_CHARS;
      return {
        status: "success" as const,
        fileName: basename(filePath),
        filePath: previewPath,
        content: truncated ? preview.text.slice(0, MAX_REDACTION_PREVIEW_CHARS) : preview.text,
        reasons: preview.reasons,
        redacted: preview.redacted,
        redactionScope: isSensitiveFile(previewPath, wholeFilePatterns) ? "whole-file" as const : "value-only" as const,
        fileRuleMatched: rulePath !== null,
        truncated,
      };
    } catch (e) {
      return {
        status: "error" as const,
        message: mt("读取文件失败：{{msg}}", { msg: e instanceof Error ? e.message : String(e) }),
      };
    }
  });

  // ── LLM auth & model list ─────────────────────────────────────────────────

  ipcMain.handle("llm:authStatus", () => {
    const wf = settingsStore.getEffective();
    const model = getActiveModelRef(wf);
    const local = isLikelyLocalLlm(model.baseUrl);
    const key = resolveApiKey(model, secretsStore.load().llmApiKey);
    return { configured: local || Boolean(key), local };
  });

  ipcMain.handle(
    "models:fetchList",
    async (_e, baseUrl: string, apiKey?: string, apiFormat?: ApiFormat) => {
      try {
        const codec = getCodec(resolveApiFormat({ apiFormat, baseUrl }));
        const url = codec.listModelsUrl(baseUrl);
        const headers = codec.listModelsHeaders(apiKey);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        const res = await fetch(url, { headers, signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
        const data = await res.json();
        return { ok: true as const, models: codec.parseModelList(data) };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );
}
