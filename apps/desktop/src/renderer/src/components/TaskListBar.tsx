import { useState } from "react";
import type { ActivePlanMetaDto, TaskStatusDto } from "../../../preload/index";
import type { MsgId } from "../../../shared/i18n/core";
import { useI18n } from "../i18n";

interface Props {
  meta: ActivePlanMetaDto;
  busy?: boolean;
  onUpdateTask: (taskId: string, status: TaskStatusDto) => void;
}

const STATUS_ICON: Record<TaskStatusDto, string> = {
  pending: "⬜",
  in_progress: "🔄",
  completed: "✅",
  failed: "❌",
  skipped: "⏭️",
};

const STATUS_LABEL: Record<TaskStatusDto, MsgId> = {
  pending: "待执行",
  in_progress: "执行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

export function TaskListBar({ meta, busy, onUpdateTask }: Props) {
  const [open, setOpen] = useState(false);
  // map 回调里 t 已是任务项，取词函数用别名 tr。
  const { t: tr } = useI18n();
  if (!meta.tasks || meta.tasks.length === 0) return null;
  const done = meta.tasks.filter((t) => t.status === "completed" || t.status === "skipped").length;
  const total = meta.tasks.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const allDone = done === total;

  return (
    <section className={open ? "task-bar open" : "task-bar"}>
      <button type="button" className="task-bar-head" onClick={() => setOpen((v) => !v)}>
        <span className="activity-chev">{open ? "▾" : "▸"}</span>
        <span className="task-bar-title">{tr("任务进度")}</span>
        <span className="task-bar-count">{done}/{total}</span>
        <div className="task-bar-progress" aria-label={tr("进度 {{pct}}%", { pct })}>
          <div className="task-bar-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        {allDone ? <span className="task-bar-done">{tr("全部完成")}</span> : null}
      </button>
      {open ? (
        <ol className="task-list">
          {meta.tasks.map((t) => {
            const isCurrent = t.id === meta.currentTaskId && t.status === "in_progress";
            return (
              <li
                key={t.id}
                className={
                  "task-row" +
                  (isCurrent ? " current" : "") +
                  (t.status === "completed" ? " done" : "") +
                  (t.status === "failed" ? " failed" : "")
                }
              >
                <span className="task-icon" aria-label={tr(STATUS_LABEL[t.status])}>{STATUS_ICON[t.status]}</span>
                <div className="task-body">
                  <div className="task-desc">
                    <span className="task-id">{t.id}</span>
                    {t.description}
                  </div>
                  {t.acceptance ? <div className="task-acceptance">{tr("验收：")}{t.acceptance}</div> : null}
                  {t.result ? <div className="task-result">{t.result}</div> : null}
                </div>
                <div className="task-actions">
                  {t.status === "in_progress" || t.status === "pending" ? (
                    <button
                      type="button"
                      className="ghost tiny"
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); onUpdateTask(t.id, "skipped"); }}
                      title={tr("跳过此任务")}
                    >
                      {tr("跳过")}
                    </button>
                  ) : null}
                  {t.status === "failed" || t.status === "skipped" ? (
                    <button
                      type="button"
                      className="ghost tiny accent"
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); onUpdateTask(t.id, "pending"); }}
                      title={tr("重置为待执行")}
                    >
                      {tr("重置")}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}