import { useState } from "react";
import { deserializeError, ErrorCode, type AppError } from "@owncoder/shared";

interface Props {
  error: AppError;
  onDismiss: () => void;
  onOpenSettings?: () => void;
}

export function ErrorBanner({ error, onDismiss, onOpenSettings }: Props) {
  const [showDetail, setShowDetail] = useState(false);

  const needsSettings =
    error.code === ErrorCode.AUTH_MISSING_KEY ||
    error.code === ErrorCode.AUTH_INVALID_KEY ||
    error.code === ErrorCode.NET_UNREACHABLE;

  const title = needsSettings ? "需要配置模型" : "出错了";

  return (
    <div className="error-banner" role="alert">
      <div className="error-banner-icon" aria-hidden>
        ⚠
      </div>
      <div className="error-banner-body">
        <strong>{title}</strong>
        <p>{error.message}</p>
        {error.detail && showDetail ? <pre className="error-detail">{error.detail}</pre> : null}
        {error.detail ? (
          <button
            type="button"
            className="error-detail-toggle"
            onClick={() => setShowDetail((v) => !v)}
          >
            {showDetail ? "隐藏详情" : "查看技术详情"}
          </button>
        ) : null}
      </div>
      <div className="error-banner-actions">
        {needsSettings && onOpenSettings ? (
          <button type="button" className="ghost accent" onClick={onOpenSettings}>
            打开设置
          </button>
        ) : null}
        <button type="button" className="ghost" onClick={onDismiss}>
          关闭
        </button>
      </div>
    </div>
  );
}

// ── Helpers consumed by App.tsx / hooks ──────────────────────────────────────

/** 验证门禁失败：只在 LLM 正文区提示，不走顶部 ErrorBanner。 */
export function isVerificationGateError(raw: unknown): boolean {
  if (raw == null) return false;
  const texts: string[] = [];
  if (typeof raw === "string") {
    texts.push(raw);
  } else if (raw instanceof Error) {
    texts.push(raw.message);
  } else if (typeof raw === "object") {
    const obj = raw as { message?: unknown; detail?: unknown };
    if (typeof obj.message === "string") texts.push(obj.message);
    if (typeof obj.detail === "string") texts.push(obj.detail);
    try {
      texts.push(JSON.stringify(raw));
    } catch {
      /* ignore */
    }
  } else {
    texts.push(String(raw));
  }
  return texts.some(
    (text) =>
      text.includes("验证门禁未通过") ||
      text.includes("无法报告成功") ||
      text.includes("成功门禁未通过"),
  );
}

/** Convert any raw error (string, Error, AppError JSON) to AppError. */
export function toAppError(raw: unknown): AppError {
  if (typeof raw === "object" && raw !== null && "code" in raw && "message" in raw) {
    return raw as AppError;
  }
  const text = raw instanceof Error ? raw.message : String(raw ?? "Unknown error");
  return deserializeError(text);
}

/** Extract an AppError from the last assistant "Error:…" turn (if any). */
export function extractHistoryError(
  turns: { role: string; content: string }[],
): AppError | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t?.role === "assistant" && t.content.startsWith("Error:")) {
      const err = toAppError(t.content.replace(/^Error:\s*/, ""));
      if (isVerificationGateError(err) || isVerificationGateError(t.content)) return null;
      return err;
    }
  }
  return null;
}

// Back-compat shim so any surviving call-sites still compile during migration.
/** @deprecated Use toAppError() instead */
export function friendlyErrorMessage(raw: string): {
  message: string;
  showSettings: boolean;
  detail?: string;
} {
  const err = toAppError(raw);
  return {
    message: err.message,
    showSettings:
      err.code === ErrorCode.AUTH_MISSING_KEY ||
      err.code === ErrorCode.AUTH_INVALID_KEY ||
      err.code === ErrorCode.NET_UNREACHABLE,
    detail: err.detail,
  };
}
