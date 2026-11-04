import { useState } from "react";
import type { TaskItemDto, TaskStatusDto } from "../../../../preload/index";
import type { DecompositionSnapshot } from "../../store/chat-store";
import { useI18n } from "../../i18n";

// ── DecomposeCard: task_decompose result (intent + tasks) ───────────────────
// 参照 ZCode-main 的 run-line：默认折叠成一条单行状态条
// （图标 + 灯点轨道 + 当前任务一句话 + n/m），点击展开精简卡片
// （意图一行 + 任务行：状态灯 + 标题/描述）。任务 prompt / 依赖 /
// 相关历史等次级信息收入任务行下的 <details>，不再平铺。
// 仅在 pnpm dev（import.meta.env.DEV）时由 ChatLog footer 渲染。
// 节点式分解：节点含 title/description/prompt/kind/dependsOn，
// 任务相关历史与节点同级（顶层）。

interface DecomposeTaskRow {
  id: string;
  title?: string;
  description: string;
  /** 节点执行指令（旧数据可能是 guidance）。 */
  prompt?: string;
  dependsOn?: string[];
  /** 会话活动计划中匹配到的执行状态；null 表示未关联（不参与进度统计）。 */
  status: TaskStatusDto | null;
}

/** 任务在灯点轨道上的状态 class；未关联执行进度时为 none。 */
function dotClass(status: TaskStatusDto | null): string {
  switch (status) {
    case "completed":
    case "skipped":
      return "done";
    case "in_progress":
      return "current";
    case "failed":
      return "failed";
    default:
      return "none";
  }
}

/** 描述归一化：去掉空白后比较，容忍计划任务与分解任务之间的空格差异。 */
function normDesc(s: string): string {
  return s.replace(/\s+/g, "");
}

/**
 * 把会话活动计划的任务状态联到分解任务上：id 一致且描述一致优先，
 * 退化按描述精确匹配；两者都对不上就不关联（避免误报执行进度）。
 */
function joinPlanStatus(
  tasks: DecompositionSnapshot["tasks"],
  planTasks?: TaskItemDto[],
): { rows: DecomposeTaskRow[]; joined: boolean } {
  const rows: DecomposeTaskRow[] = (tasks ?? []).map((t) => ({ ...t, status: null }));
  if (!planTasks || planTasks.length === 0) return { rows, joined: false };
  const byDesc = new Map(planTasks.map((p) => [normDesc(p.description), p]));
  let matched = false;
  for (const row of rows) {
    const p =
      planTasks.find((q) => q.id === row.id && normDesc(q.description) === normDesc(row.description)) ??
      byDesc.get(normDesc(row.description));
    if (p) {
      row.status = p.status;
      matched = true;
    }
  }
  return { rows, joined: matched };
}

/** 连线仅表示它前一任务已结束，不从全局完成数量推断顺序。 */
export function isRailSegmentReached(status: TaskStatusDto | null): boolean {
  return status === "completed" || status === "skipped";
}

/** 灯点轨道：一个任务一盏灯，灯间 1px 轨段；超过 6 盏折到 +n。 */
function StatusRail({ rows, total }: { rows: DecomposeTaskRow[]; total: number }) {
  const visible = rows.slice(0, 6);
  const hidden = total - visible.length;
  return (
    <span className="decompose-rail" aria-hidden>
      {visible.map((row, index) => (
        <span key={row.id} className="decompose-rail-station">
          {index > 0 ? <span className={`decompose-rail-seg${isRailSegmentReached(visible[index - 1]!.status) ? " reached" : ""}`} /> : null}
          <span className={`decompose-rail-dot s-${dotClass(row.status)}`} />
        </span>
      ))}
      {hidden > 0 ? <span className="decompose-rail-more">+{hidden}</span> : null}
    </span>
  );
}

export function DecomposeCard({
  decomposition,
  planTasks,
}: {
  decomposition: DecompositionSnapshot;
  planTasks?: TaskItemDto[];
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const { intent, userConstraints, relevantHistory, fallback } = decomposition;
  const { rows, joined } = joinPlanStatus(decomposition.tasks, planTasks);

  const done = rows.filter((r) => r.status === "completed" || r.status === "skipped").length;
  const total = rows.length;
  const current = rows.find((r) => r.status === "in_progress");
  const allDone = joined && total > 0 && done === total;

  // 摘要词：与 TaskListBar 重复的任务详情交给任务栏，这里只给一句状态。
  const hasDetail = Boolean(current?.title || current?.description || rows[0]?.title || rows[0]?.description);

  if (!open) {
    return (
      <button
        type="button"
        className={`decompose-pill${fallback ? " fallback" : ""}${allDone ? " done" : ""}`}
        onClick={() => setOpen(true)}
        aria-label={t("任务分解：{{count}} 个任务", { count: total })}
      >
        <StatusRail rows={rows} total={total} />
        <span className="decompose-pill-text">
          {allDone
            ? t("全部完成")
            : current
              ? current.title || current.description
              : hasDetail
                ? (rows[0]!.title || rows[0]!.description)
                : intent || t("任务分解：无需计划")}
        </span>
        {joined && total > 0 ? (
          <span className="decompose-pill-count">{done}/{total}</span>
        ) : null}
        <span className="decompose-pill-chev">▸</span>
      </button>
    );
  }

  return (
    <div className={`decompose-card${fallback ? " fallback" : ""}`}>
      <button type="button" className="decompose-head" onClick={() => setOpen(false)}>
        <StatusRail rows={rows} total={total} />
        <span className="decompose-title">
          {total === 0 ? t("任务分解：无需计划") : t("任务分解：{{count}} 个任务", { count: total })}
        </span>
        {joined && total > 0 ? (
          <span className="decompose-head-count">{done}/{total}</span>
        ) : null}
        <span className="activity-chev">▾</span>
      </button>
      <div className="decompose-body">
        {intent ? <div className="decompose-intent">{intent}</div> : null}
        {userConstraints?.length > 0 ? (
          <ul className="decompose-constraints">
            {userConstraints.map((c, i) => (
              <li key={`${c}-${i}`}>{c}</li>
            ))}
          </ul>
        ) : null}
        {total > 0 ? (
          <div className="decompose-tasks">
            {rows.map((task) => (
              <div
                key={task.id}
                className={
                  "decompose-task" +
                  (task.status === "completed" || task.status === "skipped" ? " done" : "") +
                  (task.status === "failed" ? " failed" : "")
                }
              >
                <div className="decompose-task-head">
                  <span className={`decompose-task-dot s-${dotClass(task.status)}`} />
                  <span className="decompose-step-id">{task.id}</span>
                  <span className="decompose-step-desc">{task.title || task.description}</span>
                </div>
                {(task.title && task.description) ||
                task.dependsOn?.length ||
                task.prompt ||
                relevantHistory ? (
                  <details className="decompose-task-details">
                    <summary>{t("详情")}</summary>
                    {task.title && task.description ? (
                      <div className="decompose-task-line">{task.description}</div>
                    ) : null}
                    {task.dependsOn && task.dependsOn.length > 0 ? (
                      <div className="decompose-task-line">{t("依赖：")}{task.dependsOn.join(", ")}</div>
                    ) : null}
                    {task.prompt ? <div className="decompose-task-line">{task.prompt}</div> : null}
                    {relevantHistory ? (
                      <div className="decompose-task-line">{t("历史：")}{relevantHistory}</div>
                    ) : null}
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="decompose-empty">
            {t("本次请求未产生任务（琐碎请求 / 提问 / 交还用户）。")}
          </div>
        )}
        {fallback ? (
          <div className="decompose-fallback-note">
            {t("分解调用失败，以上为本地启发式回退结果，仅供粗略参考。")}
          </div>
        ) : null}
      </div>
    </div>
  );
}
