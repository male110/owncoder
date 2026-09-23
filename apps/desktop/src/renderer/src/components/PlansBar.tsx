import { useState } from "react";
import type { PlanInfoDto } from "../../../preload/index";
import { useI18n } from "../i18n";

interface Props {
  plans: PlanInfoDto[];
  activePlanPath: string | null;
  busy?: boolean;
  onApprovePlan: (path?: string) => void;
  onReadPlan: (path: string) => Promise<string>;
  onOpenFile?: (path: string) => void;
}

/** Inline collapsible plans bar shown above the composer.
 * Only visible while plans await approval; once a plan is approved
 * (activePlanPath set) execution runs autonomously and the bar hides. */
export function PlansBar({
  plans,
  activePlanPath,
  busy,
  onApprovePlan,
  onReadPlan,
  onOpenFile,
}: Props) {
  const [open, setOpen] = useState(false);
  const [planPreview, setPlanPreview] = useState<{ path: string; body: string; kind: "plan" | "document" } | null>(null);
  const { t } = useI18n();

  if (activePlanPath) return null;
  if (plans.length === 0) return null;

  const openPlan = async (path: string) => {
    const body = await onReadPlan(path);
    const kind = plans.find((p) => p.path === path)?.kind ?? "plan";
    setPlanPreview({ path, body, kind });
  };

  return (
    <section className={open ? "review-bar open" : "review-bar"}>
      <div className="review-bar-head">
        <button type="button" className="review-bar-toggle" onClick={() => setOpen((v) => !v)}>
          <span className="activity-chev">{open ? "▾" : "▸"}</span>
          <span className="review-bar-title">{t("计划")}</span>
          {plans.length ? <span className="review-bar-count">{plans.length}</span> : null}
        </button>
      </div>
      {open ? (
        <div className="plans-body">
          <div className="plans-list">
            {plans.map((p) => (
              <div key={p.path} className="plan-row">
                <button type="button" className="plan-row-main" onClick={() => void openPlan(p.path)}>
                  <span className="plan-title">{p.title}</span>
                  <span className="plan-path">{p.path}</span>
                </button>
                {onOpenFile ? (
                  <button
                    type="button"
                    className="ghost tiny"
                    disabled={busy}
                    onClick={() => onOpenFile(p.path)}
                    title={t("在编辑器中打开")}
                  >
                    {t("打开")}
                  </button>
                ) : null}
                {p.kind === "document" ? (
                  <span className="plan-kind-tag" title={t("文档交付物，无需批准")}>{t("文档")}</span>
                ) : (
                  <button
                    type="button"
                    className="ghost tiny accent"
                    disabled={busy}
                    onClick={() => {
                      onApprovePlan(p.path);
                      if (planPreview?.path === p.path) setPlanPreview(null);
                    }}
                  >
                    {t("批准")}
                  </button>
                )}
              </div>
            ))}
          </div>
          {planPreview ? (
            <div className="plan-preview">
              <div className="prompt-toolbar">
                <strong>{planPreview.path}</strong>
                <div className="plan-preview-actions">
                  {onOpenFile ? (
                    <button
                      type="button"
                      className="ghost tiny"
                      onClick={() => onOpenFile(planPreview.path)}
                    >
                      {t("在编辑器中打开")}
                    </button>
                  ) : null}
                  <button type="button" className="ghost tiny" onClick={() => setPlanPreview(null)}>
                    {t("关闭预览")}
                  </button>
                </div>
              </div>
              <pre className="plan-preview-body">{planPreview.body}</pre>
              {planPreview.kind === "document" ? (
                <span className="plan-kind-note">{t("文档交付物 · 无需批准（如需执行请生成实施计划）")}</span>
              ) : (
                <button
                  type="button"
                  className="ghost accent"
                  disabled={busy}
                  onClick={() => {
                    onApprovePlan(planPreview.path);
                    setPlanPreview(null);
                  }}
                >
                  {t("批准此计划并自动执行")}
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
