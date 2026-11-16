import { useState } from "react";
import type { PlanInfoDto } from "../../../preload/index";
import { useI18n } from "../i18n";

interface Props {
  plans: PlanInfoDto[];
  activePlanPath: string | null;
  busy?: boolean;
  onApprovePlan: (path?: string) => void;
  sessionId: string;
}

/** Compact list of plans awaiting approval; the content opens in a separate window. */
export function PlansBar({ plans, activePlanPath, busy, onApprovePlan, sessionId }: Props) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  if (activePlanPath || plans.length === 0) return null;

  return (
    <section className={open ? "review-bar open" : "review-bar"}>
      <div className="review-bar-head">
        <button type="button" className="review-bar-toggle" onClick={() => setOpen((value) => !value)}>
          <span className="activity-chev">{open ? "▾" : "▸"}</span>
          <span className="review-bar-title">{t("计划")}</span>
          <span className="review-bar-count">{plans.length}</span>
        </button>
      </div>
      {open && (
        <div className="plans-body">
          <div className="plans-list">
            {plans.map((plan) => (
              <div key={plan.path} className="plan-row">
                <button type="button" className="plan-row-main"
                  onClick={() => void window.owncoder.openPlanWindow(plan.path, sessionId)}>
                  <span className="plan-title">{plan.title}</span>
                </button>
                {plan.kind === "document" ? (
                  <span className="plan-kind-tag" title={t("文档交付物，无需批准")}>{t("文档")}</span>
                ) : (
                  <button type="button" className="ghost tiny accent" disabled={busy}
                    onClick={() => onApprovePlan(plan.path)}>{t("批准")}</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
