import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { ComposerProps } from "./composer/types";
import { useComposerTextarea } from "./composer/useComposerTextarea";
import { useGroupedModels } from "./composer/useGroupedModels";
import { useAttachments } from "./composer/useAttachments";
import { useMention } from "./composer/useMention";
import { useContextMenu } from "./composer/useContextMenu";
import { WorkspacePicker } from "./composer/WorkspacePicker";
import { ModePicker } from "./composer/ModePicker";
import { ModelPicker } from "./composer/ModelPicker";
import { ThinkingPicker } from "./composer/ThinkingPicker";
import { ComposerInput } from "./composer/ComposerInput";

function ComposerImpl({
  mode,
  activeSessionId,
  draft,
  sending,
  modelLabel,
  availableModels,
  providers,
  thinkingEffort,

  separateStageModels,
  reactModelId,
  reactProviderId,
  reactThinkingEffort,

  workspaceName,
  workspaceRoot,
  projects,
  gitStatus,
  isEmptySession,
  pendingNewSession,
  modeMenuOpen,
  onDraft,
  onSend,
  onCancel,
  onNewSession,
  onMode,
  onModeMenuOpen,
  onSelectModel,
  onOpenSettings,
  onSelectThinkingEffort,
  onSelectProject,
  onAddProject,
  onSelectReactModel,
  onSelectReactThinkingEffort,
}: ComposerProps) {
  const { t } = useI18n();
  const textareaRef = useComposerTextarea(activeSessionId, draft);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [reactMenuOpen, setReactMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [reactThinkingMenuOpen, setReactThinkingMenuOpen] = useState(false);
  const [projectSwitching, setProjectSwitching] = useState(false);

  // 超时保护：防止 projectSwitching 异常卡死导致 UI 永久禁用
  useEffect(() => {
    if (!projectSwitching) return;
    const timeout = setTimeout(() => {
      console.warn('[Composer] projectSwitching 超时，强制重置');
      setProjectSwitching(false);
    }, 15000);
    return () => clearTimeout(timeout);
  }, [projectSwitching]);

  const groupedModels = useGroupedModels(availableModels, providers);
  const {
    attachments,
    uploadStatus,
    uploadFile,
    onFileSelected,
    attachmentImageSrc,
    previewUrl,
    setPreviewUrl,
    removeAttachment,
    clearAttachments,
  } = useAttachments(availableModels, providers);
  const mention = useMention(draft, onDraft, textareaRef);
  const ctx = useContextMenu(draft, onDraft, textareaRef);

  const handleSelectProject = useCallback(
    (root: string) => {
      setProjectSwitching(true);
      return onSelectProject(root)
        .catch((error) => {
          console.error('[Composer] 项目切换失败:', error);
        })
        .finally(() => {
          setProjectSwitching(false);
        });
    },
    [onSelectProject],
  );

  const reactSelectedModel =
    availableModels.find((m) => m.providerId === reactProviderId && (m.name === reactModelId || m.id === reactModelId)) ?? null;

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        console.log("[Composer] form submitted, projectSwitching=", projectSwitching, "draft=", JSON.stringify(draft));
        if (projectSwitching || uploadStatus === "uploading") return;
        if (mention.isOpen) {
          mention.insertMention(mention.mentionHits[mention.mentionIndex]!);
          return;
        }
        console.log("[Composer] calling onSend()");
        const ready = attachments.filter((item) => item.status === "success").map((item) => item.result!);
        onSend(ready);
        clearAttachments();
      }}
    >
      {(isEmptySession || pendingNewSession) ? (
        <WorkspacePicker
          workspaceName={workspaceName}
          workspaceRoot={workspaceRoot}
          projects={projects}
          gitStatus={gitStatus}
          onSelectProject={handleSelectProject}
          onAddProject={onAddProject}
        />
      ) : null}

      <ComposerInput
        draft={draft}
        onDraft={onDraft}
        mode={mode}
        disabled={projectSwitching}
        textareaRef={textareaRef}
        mention={mention}
        ctx={ctx}
        attachments={attachments}
        attachmentImageSrc={attachmentImageSrc}
        onRemoveAttachment={removeAttachment}
        onRetryUpload={uploadFile}
        onPreviewAttachment={setPreviewUrl}
        onNewSession={onNewSession}
      />

      <div className="composer-bar">
        <input ref={fileInputRef} className="composer-file-input" type="file" multiple onChange={onFileSelected} />
        <button
          type="button"
          className="upload-trigger"
          aria-label={t("上传文件")}
          title={t("上传图片或文件")}
          disabled={projectSwitching}
          onClick={() => fileInputRef.current?.click()}
        >
          ＋
        </button>

        <ModePicker mode={mode} open={modeMenuOpen} onOpenChange={onModeMenuOpen} onMode={onMode} />

        {/* 所有设置项在同一行；模型与思考等级成对贴近，共用圆弧边框像一个整体 */}
        <div className="composer-settings-row">
          {/* 任务分解：模型 + 思考等级（分阶段和非分阶段都显示） */}
          <div className="model-group model-group-decomposer">
            <ModelPicker
              open={modelMenuOpen}
              onOpenChange={setModelMenuOpen}
              groupedModels={groupedModels}
              availableModels={availableModels}
              label={modelLabel}
              variant="decomposer"
              stageIndicator={separateStageModels}
              isSelected={(m) => m.providerId === availableModels[0]?.providerId && m.id === availableModels[0]?.id}
              onSelect={(m) => onSelectModel(m.id, m.providerId)}
              onOpenSettings={onOpenSettings}
            />
            <ThinkingPicker
              open={thinkingMenuOpen}
              onOpenChange={setThinkingMenuOpen}
              effort={thinkingEffort}
              onSelect={onSelectThinkingEffort}
              variant="decomposer"
              stageIndicator={separateStageModels}
            />
          </div>

          {/* 循环执行：模型 + 思考等级（仅分阶段模式显示） */}
          {separateStageModels ? (
            <div className="model-group model-group-react">
              <ModelPicker
                open={reactMenuOpen}
                onOpenChange={setReactMenuOpen}
                groupedModels={groupedModels}
                availableModels={availableModels}
                label={reactSelectedModel?.name || t("选择模型")}
                variant="react"
                initialProviderId={reactProviderId}
                isSelected={(m) => m.providerId === reactProviderId && (m.name === reactModelId || m.id === reactModelId)}
                onSelect={(m) => onSelectReactModel(m.name, m.providerId)}
                onOpenSettings={onOpenSettings}
              />
              <ThinkingPicker
                open={reactThinkingMenuOpen}
                onOpenChange={setReactThinkingMenuOpen}
                effort={reactThinkingEffort}
                onSelect={onSelectReactThinkingEffort}
                variant="react"
              />
            </div>
          ) : null}
        </div>

        <div className="composer-actions">
          {sending ? (
            <button type="button" className="stop-btn" onClick={onCancel}>
              {t("停止")}
            </button>
          ) : null}
          <button
            type="submit"
            className="send"
            disabled={!draft.trim() || projectSwitching}
            aria-label={t("发送")}
            title={
              projectSwitching
                ? t("正在切换项目，请稍候...")
                : !draft.trim()
                  ? t("请输入消息")
                  : t("发送消息")
            }
          >
            ↑
          </button>
        </div>
      </div>

      {previewUrl ? (
        <div className="attachment-lightbox" role="dialog" aria-label={t("图片预览")} onClick={() => setPreviewUrl(null)}>
          <img src={previewUrl} alt={t("图片预览")} onClick={(e) => e.stopPropagation()} />
          <button type="button" className="attachment-lightbox-close" aria-label={t("关闭预览")} onClick={() => setPreviewUrl(null)}>
            ×
          </button>
        </div>
      ) : null}
    </form>
  );
}

export const Composer = memo(ComposerImpl);
