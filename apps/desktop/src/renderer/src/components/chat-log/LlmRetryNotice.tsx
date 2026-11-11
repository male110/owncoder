import { useEffect, useState } from "react";
import type { LlmRetryState } from "../../store/chat-store";
import { useI18n, type I18n } from "../../i18n";

interface Props {
  retry: LlmRetryState;
}

/** 剩余秒数向上取整：刚发出重试事件时显示完整等待秒数，归零即表示已发起。 */
export function remainingSeconds(retryAt: number, now: number): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

/** 把底层 reason（timeout / network / http_503 / 原始报错）压成一句可读说明。 */
export function describeRetryReason(reason: string, t: I18n["t"]): string {
  if (reason === "timeout") return t("模型长时间无响应");
  if (reason === "network") return t("网络连接失败");
  const http = /^http_(\d+)$/.exec(reason);
  if (http) return t("服务返回 {{status}}", { status: http[1]! });
  return reason.length > 80 ? `${reason.slice(0, 80)}…` : reason;
}

function useReasonLabel(reason: string): string {
  const { t } = useI18n();
  return describeRetryReason(reason, t);
}

/**
 * LLM 调用失败后的重试提示：显示失败原因、第几次重试以及倒计时。
 * 没有它时重试等待期间界面只有「思考中…」，用户无法判断是卡死还是在重试。
 */
export function LlmRetryNotice({ retry }: Props) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const reason = useReasonLabel(retry.reason);

  useEffect(() => {
    setNow(Date.now());
    // 250ms 轮询让秒数在真实边界翻转，避免 1s 定时器累积漂移导致跳秒。
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [retry.retryAt, retry.attempt]);

  const seconds = remainingSeconds(retry.retryAt, now);
  const title =
    seconds > 0
      ? t("{{seconds}} 秒后重试", { seconds })
      : t("正在重试…");

  return (
    <div className="llm-retry-notice" role="status" aria-live="polite">
      <span className="tool-spinner" aria-hidden />
      <div className="llm-retry-body">
        <div className="llm-retry-title">
          <span>{title}</span>
          <span className="llm-retry-attempt">
            {t("第 {{attempt}}/{{max}} 次", { attempt: retry.attempt, max: retry.maxRetries })}
          </span>
        </div>
        <div className="llm-retry-reason">{reason}</div>
      </div>
    </div>
  );
}
