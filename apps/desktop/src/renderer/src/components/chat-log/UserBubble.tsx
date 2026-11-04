import { useState, memo } from "react";
import type { ChatTurnDto } from "../../../../preload/index";
import { Markdown } from "../Markdown";
import { useI18n } from "../../i18n";

// ── Bubbles ───────────────────────────────────────────────────────────────────

function UserBubbleImpl({
  turn,
  stopping = false,
  onDelete,
  onDiscardInflight,
}: {
  turn: ChatTurnDto;
  /** 「正在停止…」窗口：乐观行无 turnId，需要单独放开删除入口。 */
  stopping?: boolean;
  onDelete?: (turnId: string) => void;
  onDiscardInflight?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { t } = useI18n();

  // 已落盘（有 turnId）走整轮删除；停止窗口里的乐观行（无 turnId）走本地丢弃。
  const canDeletePersisted = Boolean(turn.turnId) && Boolean(onDelete);
  const canDiscardOptimistic = !turn.turnId && stopping && Boolean(onDiscardInflight);

  const isCompressed = turn.isCompressed === true;
  const compressionRatio = turn.originalLength && turn.content.length
    ? Math.round((turn.content.length / turn.originalLength) * 100)
    : null;
  const hasImportantSnippets = turn.importantSnippets && turn.importantSnippets.length > 0;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(turn.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className={`msg user ${isCompressed ? "compressed" : ""}`}>
      <div className="user-bubble-wrap">
        <div className="msg-bubble">
          <Markdown content={turn.content} />
          {isCompressed && (
            <div className="compression-indicator">
              <span className="compression-icon" title={t("已压缩内容")}>🗜️</span>
              {compressionRatio && (
                <span className="compression-ratio">{t("压缩{{percent}}%", { percent: compressionRatio })}</span>
              )}
              {hasImportantSnippets && (
                <div className="important-snippets-tooltip">
                  <strong>{t("保留的重要片段：")}</strong>
                  <ul>
                    {turn.importantSnippets!.slice(0, 3).map((snippet, i) => (
                      <li key={`${snippet}-${i}`}>{snippet}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="msg-actions">
          <button type="button" className="msg-action-btn" onClick={() => void onCopy()} title={t("复制")}>
            {copied ? t("已复制") : t("复制")}
          </button>
          {canDeletePersisted || canDiscardOptimistic ? (
            confirming ? (
              <>
                <button
                  type="button"
                  className="msg-action-btn danger"
                  onClick={() => {
                    // 已落盘轮走整轮删除；停止窗口的乐观行走本地丢弃。
                    if (canDeletePersisted) onDelete!(turn.turnId!);
                    else onDiscardInflight!();
                    setConfirming(false);
                  }}
                  title={t("确认删除")}
                >
                  {t("确认删除该输入及回复？")}
                </button>
                <button
                  type="button"
                  className="msg-action-btn"
                  onClick={() => setConfirming(false)}
                >
                  {t("取消")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="msg-action-btn"
                onClick={() => setConfirming(true)}
                title={t("删除该输入及对应回复")}
              >
                {t("删除")}
              </button>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const UserBubble = memo(UserBubbleImpl, (prev, next) =>
  (prev.turn === next.turn ||
    (prev.turn.id === next.turn.id &&
      prev.turn.content === next.turn.content &&
      prev.turn.isCompressed === next.turn.isCompressed &&
      prev.turn.originalLength === next.turn.originalLength)) &&
  prev.onDelete === next.onDelete
);
