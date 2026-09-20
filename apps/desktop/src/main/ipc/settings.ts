/**
 * IPC handlers: settings, secrets, LLM auth, model list, prompt translation.
 */
import { dialog, ipcMain } from "electron";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import {
  BUILTIN_SENSITIVE_FILES,
  SystemWorkflowConfigSchema,
  WorkflowOverlaySchema,
  getActiveModelRef,
  type SystemWorkflowConfig,
  type WorkflowOverlay,
} from "@owncoder/settings";
import { isRedactionEnabled, isSensitiveFile, redactSecrets } from "@owncoder/core";
import {
  assertLlmAuth,
  chatCompletion,
  getCodec,
  isLikelyLocalLlm,
  resolveApiFormat,
  resolveApiKey,
  type ApiFormat,
} from "@owncoder/llm";
import type { IpcContext } from "./types";

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
      title: "选择要测试脱敏的文件",
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
        message: "当前未启用敏感信息脱敏，请先启用后再测试。",
      };
    }

    try {
      const fileInfo = await stat(filePath);
      if (fileInfo.size > MAX_REDACTION_TEST_BYTES) {
        return {
          status: "error" as const,
          message: "文件过大，脱敏测试仅支持 10 MB 以内的文件。",
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
        message: `读取文件失败：${e instanceof Error ? e.message : String(e)}`,
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

  // ── Prompt translation ────────────────────────────────────────────────────

  ipcMain.handle("llm:translatePrompt", async (_e, text: string, target?: "en" | "zh") => {
    const src = String(text || "").trim();
    if (!src) return "";
    const workflow = settingsStore.getEffective();
    const model = getActiveModelRef(workflow);
    const apiKey = secretsStore.load().llmApiKey;
    assertLlmAuth(model, apiKey);
    const toZh = target === "zh";
    const system = toZh
      ? "You translate AI coding-agent system prompts into clear, natural Simplified Chinese. " +
        "Preserve markdown headings, bullet structure, tool names " +
        "(save_plan, apply_patch, read_file, etc.), paths, and constraints " +
        "verbatim in their original form. " +
        "Output ONLY the Chinese prompt text \u2014 no preface or commentary."
      : "You translate AI coding-agent system prompts into clear English. " +
        "Preserve markdown headings, bullet structure, tool names " +
        "(save_plan, apply_patch, read_file, etc.), paths, and constraints. " +
        "Output ONLY the English prompt text \u2014 no preface or commentary.";
    const response = await chatCompletion(
      model,
      [
        { role: "system", content: system },
        { role: "user", content: src },
      ],
      { 
        apiKey, 
        temperature: 0.1,
        thinking: { effort: workflow.thinking?.defaultEffort },
      },
    );
    return (response.choices[0]?.message.content ?? "").trim();
  });
}
