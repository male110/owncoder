import type { RefObject } from "react";
import type { AgentMode } from "@owncoder/shared";
import { useI18n } from "../../i18n";
import type { AttachmentItem } from "./types";
import type { CtxMenuApi } from "./useContextMenu";
import type { MentionApi } from "./useMention";

interface ComposerInputProps {
  draft: string;
  onDraft: (v: string) => void;
  mode: AgentMode;
  /** 项目切换中 / 输入区禁用 */
  disabled: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  mention: MentionApi;
  ctx: CtxMenuApi;
  attachments: AttachmentItem[];
  attachmentImageSrc: (item: AttachmentItem) => string | null;
  onRemoveAttachment: (item: AttachmentItem) => void;
  onRetryUpload: (file: File) => void;
  onPreviewAttachment: (src: string) => void;
  onNewSession: () => void;
}

/** composer 输入区：附件缩略图行 + textarea（@提及、右键菜单）+ 两个浮层。 */
export function ComposerInput({
  draft,
  onDraft,
  mode,
  disabled,
  textareaRef,
  mention,
  ctx,
  attachments,
  attachmentImageSrc,
  onRemoveAttachment,
  onRetryUpload,
  onPreviewAttachment,
  onNewSession,
}: ComposerInputProps) {
  const { t } = useI18n();
  const placeholder =
    mode === "spec" ? t("描述一个功能需求，生成 spec → design → tasks…") : t("提出一个问题或描述一个任务…");

  return (
    <div className="composer-input-wrap">
      {attachments.length > 0 ? (
        <div className="composer-attachments">
          {attachments.map((item) => {
            const src = attachmentImageSrc(item);
            return (
              <div key={`${item.file.name}-${item.file.lastModified}`} className={`attachment-thumb ${item.status} ${src ? "is-image" : ""}`}>
                {src ? (
                  <button
                    type="button"
                    className="attachment-preview-btn"
                    title={t("点击预览")}
                    onClick={() => onPreviewAttachment(src)}
                  >
                    <img src={src} alt={item.file.name} />
                    {item.status === "uploading" ? <span className="attachment-loading" aria-hidden /> : null}
                  </button>
                ) : (
                  <span className="attachment-file-label">{item.status === "uploading" ? t("上传中") : t("文件")}</span>
                )}
                {item.status === "error" ? (
                  <button type="button" className="attachment-action" title={t("重试")} onClick={() => void onRetryUpload(item.file)}>
                    ↻
                  </button>
                ) : null}
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={t("移除附件")}
                  title={t("移除附件")}
                  onClick={() => onRemoveAttachment(item)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => {
          onDraft(e.target.value);
          mention.syncMention(e.target.value, e.target.selectionStart);
        }}
        onClick={(e) => mention.syncMention(draft, e.currentTarget.selectionStart)}
        onKeyUp={(e) => mention.syncMention(draft, e.currentTarget.selectionStart)}
        placeholder={placeholder}
        rows={3}
        disabled={disabled}
        aria-label={placeholder}
        onKeyDown={(e) => {
          if (mention.handleKeyDown(e)) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            // Route keyboard sends through the form submit handler so Enter
            // and the send button cannot invoke onSend through two paths.
            e.currentTarget.form?.requestSubmit();
          }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
            e.preventDefault();
            onNewSession();
          }
        }}
        onContextMenu={ctx.openCtxMenu}
      />
      {mention.isOpen ? (
        <ul className="mention-menu" role="listbox">
          {mention.mentionHits.map((path, i) => (
            <li key={path}>
              <button
                type="button"
                role="option"
                aria-selected={i === mention.mentionIndex}
                className={i === mention.mentionIndex ? "selected" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  mention.insertMention(path);
                }}
              >
                {path}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {ctx.ctxMenu ? (
        <div
          ref={ctx.ctxMenuRef}
          className="ctx-menu"
          role="menu"
          style={{ left: ctx.ctxMenu.x, top: ctx.ctxMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button type="button" role="menuitem" disabled={!ctx.ctxMenu.hasSelection} onClick={() => ctx.execCtxAction("cut")}>
            <span>{t("剪切")}</span>
            <span className="ctx-menu-key">Ctrl+X</span>
          </button>
          <button type="button" role="menuitem" disabled={!ctx.ctxMenu.hasSelection} onClick={() => ctx.execCtxAction("copy")}>
            <span>{t("复制")}</span>
            <span className="ctx-menu-key">Ctrl+C</span>
          </button>
          <button type="button" role="menuitem" onClick={() => ctx.execCtxAction("paste")}>
            <span>{t("粘贴")}</span>
            <span className="ctx-menu-key">Ctrl+V</span>
          </button>
          <div className="ctx-menu-sep" aria-hidden />
          <button type="button" role="menuitem" disabled={!draft.length} onClick={() => ctx.execCtxAction("selectAll")}>
            <span>{t("全选")}</span>
            <span className="ctx-menu-key">Ctrl+A</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
