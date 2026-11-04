import { useEffect, useState } from "react";
import type { SpecFeatureDto, SpecPhaseDto } from "../../../preload/index";
import { useI18n } from "../i18n";

interface Props {
  /** Feature currently under discussion in this session. */
  currentFeature: string | null;
  specs: SpecFeatureDto[];
  activePlanPath: string | null;
  busy?: boolean;
  onApprove: (feature: string) => void;
  onReject: (feature: string, feedback: string) => void;
  onReadSpec: (feature: string, phase: SpecPhaseDto) => Promise<string>;
  onSaveSpec: (feature: string, phase: SpecPhaseDto, content: string) => void;
  onOpenFile?: (absolutePath: string) => void;
}

const PHASE_ORDER: SpecPhaseDto[] = ["spec", "design", "tasks"];

const PHASE_LABEL = {
  spec: "Requirements",
  design: "Design",
  tasks: "Tasks",
} as const;

const AWAITING_STAGE_TO_PHASE: Record<string, SpecPhaseDto> = {
  awaiting_spec_approval: "spec",
  awaiting_design_approval: "design",
  awaiting_tasks_approval: "tasks",
};

function phaseUnderReview(feature: SpecFeatureDto | undefined): SpecPhaseDto | null {
  if (!feature) return null;
  if (feature.stage) {
    const awaiting = AWAITING_STAGE_TO_PHASE[feature.stage];
    if (awaiting) return awaiting;
  }
  // No gate state on disk: fall back to the first existing document that
  // hasn't got its successor yet (e.g. spec written before the gate existed).
  if (feature.phases.includes("spec") && !feature.phases.includes("design")) return "spec";
  if (feature.phases.includes("design") && !feature.phases.includes("tasks")) return "design";
  if (feature.phases.includes("tasks") && feature.stage !== "approved") return "tasks";
  return null;
}

/** Spec workflow bar (Kiro 风格): spec → design → tasks, 各阶段独立审批。
 * Visible while a phase document awaits the user's review; once tasks are
 * approved (activePlanPath set) execution runs via TaskListBar and this hides. */
export function SpecsBar({
  currentFeature,
  specs,
  activePlanPath,
  busy,
  onApprove,
  onReject,
  onReadSpec,
  onSaveSpec,
}: Props) {
  const [open, setOpen] = useState(true);
  const [preview, setPreview] = useState<{ feature: string; phase: SpecPhaseDto; body: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(false);
  const { t } = useI18n();

  // Pick the feature to show: the one under discussion, else the newest
  // feature that still has a document awaiting review.
  const focused = specs.find((f) => f.name === currentFeature)
    ?? specs.find((f) => phaseUnderReview(f) !== null);
  const phase = phaseUnderReview(focused);

  // Load the document under review whenever the focus moves.
  useEffect(() => {
    if (!focused || !phase) {
      setPreview(null);
      setEditing(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    onReadSpec(focused.name, phase)
      .then((body) => {
        if (!cancelled) setPreview({ feature: focused.name, phase, body });
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [focused?.name, phase, onReadSpec]);

  if (activePlanPath) return null;
  if (!focused || !phase) return null;

  const phaseIndex = PHASE_ORDER.indexOf(phase);
  const awaiting = focused.stage !== null && AWAITING_STAGE_TO_PHASE[focused.stage] === phase;

  const startEdit = () => {
    if (!preview) return;
    setDraft(preview.body);
    setEditing(true);
  };

  const saveEdit = () => {
    if (!preview || !draft.trim()) return;
    onSaveSpec(preview.feature, preview.phase, draft);
    setEditing(false);
  };

  const submitReject = () => {
    if (!focused) return;
    onReject(focused.name, feedback);
    setFeedback("");
  };

  return (
    <section className={open ? "review-bar open" : "review-bar"}>
      <div className="review-bar-head">
        <button type="button" className="review-bar-toggle" onClick={() => setOpen((v) => !v)}>
          <span className="activity-chev">{open ? "▾" : "▸"}</span>
          <span className="review-bar-title">{t("Spec")} · {focused.title}</span>
          {awaiting ? <span className="review-bar-count">{t("待审批")}</span> : null}
        </button>
      </div>
      {open ? (
        <div className="plans-body">
          {/* Phase stepper */}
          <div className="spec-stepper">
            {PHASE_ORDER.map((p, i) => {
              const done = i < phaseIndex || (i === phaseIndex && !awaiting);
              const current = i === phaseIndex;
              return (
                <div
                  key={p}
                  className={`spec-step${current ? " current" : ""}${done ? " done" : ""}`}
                >
                  <span className="spec-step-dot">{done ? "✓" : i + 1}</span>
                  <span className="spec-step-label">{t(PHASE_LABEL[p])}</span>
                </div>
              );
            })}
          </div>

          {loading ? (
            <div className="plan-preview">
              <p className="plan-kind-note">{t("正在加载文档…")}</p>
            </div>
          ) : preview ? (
            <div className="plan-preview">
              <div className="prompt-toolbar">
                <strong>{preview.feature}/{preview.phase}.md</strong>
                <div className="plan-preview-actions">
                  {!editing ? (
                    <button type="button" className="ghost tiny" onClick={startEdit} disabled={busy}>
                      {t("编辑")}
                    </button>
                  ) : null}
                  <button type="button" className="ghost tiny" onClick={() => setPreview(null)}>
                    {t("关闭预览")}
                  </button>
                </div>
              </div>
              {editing ? (
                <div className="spec-edit">
                  <textarea
                    className="spec-edit-textarea"
                    value={draft}
                    spellCheck={false}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <div className="spec-edit-actions">
                    <button
                      type="button"
                      className="ghost accent"
                      disabled={busy || !draft.trim()}
                      onClick={saveEdit}
                    >
                      {t("保存修改")}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => setEditing(false)}
                    >
                      {t("取消")}
                    </button>
                  </div>
                </div>
              ) : (
                <pre className="plan-preview-body">{preview.body}</pre>
              )}
              {!editing ? (
                <div className="spec-actions">
                  <button
                    type="button"
                    className="ghost accent"
                    disabled={busy}
                    onClick={() => onApprove(preview.feature)}
                  >
                    {phase === "tasks" ? t("批准任务并开始执行") : t("批准并进入下一阶段")}
                  </button>
                  <input
                    type="text"
                    className="spec-feedback-input"
                    placeholder={t("驳回：写下修改意见（留空则直接驳回）")}
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !busy) submitReject();
                    }}
                  />
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={submitReject}
                  >
                    {t("驳回修改")}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
