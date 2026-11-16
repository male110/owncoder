import { useCallback, useEffect, useState } from "react";
import type { PlanInfoDto } from "../../../preload/index";
import { useI18n } from "../i18n";
import { Markdown } from "./Markdown";

export function PlanWindow() {
  const { t } = useI18n();
  const [data, setData] = useState<{ plan: PlanInfoDto; content: string; approved: boolean } | null>(null);
  const [error, setError] = useState("");
  const [approving, setApproving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setData(await window.owncoder.getPlanWindowData());
      setError("");
    } catch (reason) {
      setData(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  useEffect(() => {
    document.title = data?.plan.title && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?:\.md)?$/i.test(data.plan.title)
      ? data.plan.title : t("已生成计划");
  }, [data?.plan.title, t]);

  const approve = async () => {
    if (approving || !data || data.plan.kind !== "plan" || data.approved) return;
    setApproving(true);
    try {
      await window.owncoder.approvePlanInWindow();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApproving(false);
    }
  };

  return (
    <main className="plan-window">
      <header className="plan-window-header">
        <h1>{data?.plan.title && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?:\.md)?$/i.test(data.plan.title)
          ? data.plan.title : t("已生成计划")}</h1>
      </header>
      {error && <p className="plan-window-error" role="alert">{error}</p>}
      {data && (
        <>
          <article className="plan-window-content"><Markdown content={data.content} /></article>
          <footer className="plan-window-footer">
            {data.plan.kind === "document" ? (
              <span className="plan-kind-note">{t("文档交付物 · 无需批准（如需执行请生成实施计划）")}</span>
            ) : data.approved ? (
              <span className="plan-kind-note">{t("已批准")}</span>
            ) : (
              <button type="button" className="plan-approve-cta" disabled={approving} onClick={() => void approve()}>
                {approving ? t("批准中…") : t("批准此计划并自动执行")}
              </button>
            )}
          </footer>
        </>
      )}
    </main>
  );
}
