import { useState, useEffect, useRef, memo } from "react";
import type { SubagentGroup } from "../../store/chat-store";
import { useI18n } from "../../i18n";
import { LiveToolCard } from "./LiveToolCard";

// ── SubagentGroupCard: 子智能体/任务节点执行流的折叠分组 ──────────────────────

/** 工具超过此数量时收起旧的，只留最近的（避免几十张卡片堆成一堵墙）。 */
const VISIBLE_TOOL_LIMIT = 8;

function SubagentGroupCardImpl({ group }: { group: SubagentGroup }) {
  const running = group.status === "running";
  const [open, setOpen] = useState(false);
  /** 工具过多时是否展开全部（默认收起旧调用）。 */
  const [showAll, setShowAll] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 用户是否手动上滚过；上滚后不再自动跟随，避免抢焦点。 */
  const pinnedRef = useRef(true);
  const { t } = useI18n();

  // 执行中自动展开工具流，结束后折叠，仅保留标题行结论。
  useEffect(() => {
    setOpen(running);
  }, [running]);

  // 运行中新工具到达时钉在底部（用户上滚则不跟随）。
  useEffect(() => {
    if (!open || !running) return;
    const body = bodyRef.current;
    if (body && pinnedRef.current) {
      body.scrollTop = body.scrollHeight;
    }
  }, [group.tools.length, open, running]);

  // 「查看全部 / 收起旧调用」切换后保持滚动定位：钉底状态继续钉底，
  // 避免列表一次性插入/移除多张卡片时视口跳动。
  useEffect(() => {
    const body = bodyRef.current;
    if (body && pinnedRef.current) {
      body.scrollTop = body.scrollHeight;
    }
  }, [showAll]);

  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    pinnedRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  };

  const statusText = running ? t("运行中") : group.status === "error" ? t("失败") : t("完成");
  const hiddenCount = group.tools.length - VISIBLE_TOOL_LIMIT;
  const showToggle = hiddenCount > 0 && !showAll;
  const visibleTools = showToggle ? group.tools.slice(-VISIBLE_TOOL_LIMIT) : group.tools;

  return (
    <div className={`subagent-card ${group.status}`}>
      <button type="button" className="subagent-card-head" onClick={() => setOpen((v) => !v)}>
        <span className="subagent-card-icon">{running ? <span className="tool-spinner" /> : "🔍"}</span>
        <span className="subagent-card-title">{group.agentType}</span>
        <span className="subagent-card-prompt">{group.task}</span>
        <span className={`subagent-card-status ${group.status}`}>
          {statusText} · {group.tools.length}
        </span>
        <span className="activity-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className={`subagent-card-body${showAll ? " show-all" : ""}`} ref={bodyRef} onScroll={onScroll}>
          {group.report ? (
            <div className="subagent-report">
              <div className="subagent-report-label">{t("节点报告")}</div>
              <pre>{group.report}</pre>
            </div>
          ) : null}
          {showToggle ? (
            <button
              type="button"
              className="subagent-show-all"
              onClick={() => setShowAll(true)}
            >
              {t("查看全部 {{count}} 个调用", { count: group.tools.length })}
            </button>
          ) : null}
          {showAll && hiddenCount > 0 ? (
            <button
              type="button"
              className="subagent-show-all"
              onClick={() => setShowAll(false)}
            >
              {t("收起旧调用，仅显示最近 {{limit}} 个", { limit: VISIBLE_TOOL_LIMIT })}
            </button>
          ) : null}
          {visibleTools.map((tool) => (
            <LiveToolCard key={`subagent-tool-${tool.id}`} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const SubagentGroupCard = memo(SubagentGroupCardImpl, (prev, next) => prev.group === next.group);
