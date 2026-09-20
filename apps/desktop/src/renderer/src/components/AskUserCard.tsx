import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../store/chat-store";
import { getFocusSessionId } from "../store/focus-session";

/**
 * Inline ask-user card shown above the composer for each session.
 *
 * Mirrors DangerousCommandBar's per-session routing: the active session's
 * pending ask_user prompts are queued in chat-store; this component shows the
 * head of the queue and returns the user's answer (a chosen option's value or
 * free text) to the main process. The agent turn blocks until that answer
 * arrives, so only one prompt is visible at a time.
 */
export function AskUserCard() {
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const askRequests = useChatStore((s) => s.askRequests);
  const [freeText, setFreeText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const current = askRequests[0] ?? null;
  const hasOptions = current ? current.options.length > 0 : false;

  useEffect(() => {
    setFreeText("");
    // 只在没有选项时才聚焦输入框（避免与按钮的 autoFocus 冲突）
    if (current?.allowFreeText && !hasOptions) {
      inputRef.current?.focus();
    }
  }, [current?.requestId, hasOptions]);

  const respond = (answer: string) => {
    if (!current) return;
    const sid = getFocusSessionId() ?? activeSessionId ?? undefined;
    useChatStore.getState().removeAskRequest(current.requestId, sid);
    window.owncoder.respondAskUser(current.requestId, answer);
  };

  useEffect(() => {
    if (!current) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        respond("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.requestId]);

  if (!current) return null;

  const queuedCount = askRequests.length - 1;

  return (
    <div className="ask-user-card" role="dialog" aria-live="assertive">
      <div className="ask-user-card-header">
        <span className="ask-user-card-icon" aria-hidden>?</span>
        <div className="ask-user-card-title-wrap">
          <p className="ask-user-card-eyebrow">Agent 需要你确认</p>
          <p className="ask-user-card-question">{current.question}</p>
        </div>
      </div>

      {hasOptions && (
        <div className="ask-user-card-options">
          {current.options.map((opt, index) => (
            <button
              key={opt.value}
              type="button"
              className="ask-user-card-option"
              onClick={() => respond(opt.value)}
              autoFocus={index === 0}
            >
              <span className="ask-user-card-option-label">
                <span className="ask-user-card-option-icon" aria-hidden="true">✓</span>
                {opt.label}
              </span>
              {opt.description && (
                <span className="ask-user-card-option-desc">{opt.description}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {current.allowFreeText && (
        <>
          {hasOptions && (
            <div className="ask-user-card-divider">
              <span>或</span>
            </div>
          )}
          <form
            className="ask-user-card-freetext"
            onSubmit={(e) => {
              e.preventDefault();
              respond(freeText.trim());
            }}
          >
            <input
              ref={inputRef}
              type="text"
              className="ask-user-card-input"
              placeholder={current.placeholder ?? "输入你的回答…"}
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              autoFocus={!hasOptions}
            />
            <button type="submit" className="ask-user-card-submit" disabled={!freeText.trim()}>
              提交
            </button>
          </form>
        </>
      )}

      <div className="ask-user-card-footer">
        <span className="ask-user-card-hint">
          {queuedCount > 0 ? `还有 ${queuedCount} 个问题等待` : "按 Esc 取消（按未作答处理）"}
        </span>
        <button type="button" className="ask-user-card-cancel" onClick={() => respond("")}>
          取消
          <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}