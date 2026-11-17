import { useState, useEffect, useRef, memo } from "react";
import type { SubagentGroup } from "../../store/chat-store";
import { useI18n } from "../../i18n";
import { LiveToolCard } from "./LiveToolCard";

// ── SubagentGroupCard: 子智能体/任务节点执行流的折叠分组 ──────────────────────

/** 工具超过此数量时收起旧的，只留最近的（避免几十张卡片堆成一堵墙）。 */
const VISIBLE_TOOL_LIMIT = 8;

/** Planner 输入预览的截断长度：仅影响渲染，不改写 store 中的原始输入。 */
const INPUT_PREVIEW_LIMIT = 200;

/** 渲染时截断长文本并附「...」按钮；点击按钮切换完整/截断内容。 */
function InputPreview({ text }: { text: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const truncated = text.length > INPUT_PREVIEW_LIMIT;
  const shown = truncated && !expanded ? text.slice(0, INPUT_PREVIEW_LIMIT) : text;
  return (
    <pre>
      {shown}
      {truncated ? (
        <button
          type="button"
          className="subagent-input-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t("收起") : "..."}
        </button>
      ) : null}
    </pre>
  );
}

/** 分组条头部的 prompt 预览：默认单行截断，点击「...」展开完整文本。
 *  文本与「...」是并列的兄弟节点：滚动区域只作用于文本，
 *  展开后「收起」按钮始终留在可见区域；外层头部是 div[role=button]，
 *  不再是 <button>，因此「...」这个真按钮能独立接收点击而不被吞掉。 */
function HeadPrompt({ text }: { text: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const truncated = text.length > INPUT_PREVIEW_LIMIT;
  const shown = truncated && !expanded ? text.slice(0, INPUT_PREVIEW_LIMIT) : text;
  return (
    <span className={`subagent-card-prompt${expanded ? " expanded" : ""}`}>
      <span className="subagent-card-prompt-text">{shown}</span>
      {truncated ? (
        <button
          type="button"
          className="subagent-input-toggle"
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          // 键盘回车/空格会冒泡到头部容器，这里一并拦住，避免顺带切换执行过程
          onKeyDown={(e) => e.stopPropagation()}
        >
          {expanded ? t("收起") : "..."}
        </button>
      ) : null}
    </span>
  );
}

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
      {/* 头部用 div[role=button] 而非 <button>：button 内不允许嵌入另一个 button，
          会把「...」的点击并入头部点击，导致它无法独立展开 prompt。 */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        className="subagent-card-head"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        <span className="subagent-card-icon">{running ? <span className="tool-spinner" /> : "🔍"}</span>
        <span className="subagent-card-title">{group.agentType}</span>
        <HeadPrompt text={group.task} />
        <span className={`subagent-card-status ${group.status}`}>
          {statusText} · {group.tools.length}
        </span>
        <span className="activity-chev">{open ? "▾" : "▸"}</span>
      </div>
      {open ? (
        <div className={`subagent-card-body${showAll ? " show-all" : ""}`} ref={bodyRef} onScroll={onScroll}>
          {group.input ? (
            <div className="subagent-report">
              <div className="subagent-report-label">{t("发送给 Planner 的输入（按设置遮盖敏感值）")}</div>
              <div className="subagent-report-label">{t("搜索广度")}：{group.input.thoroughness}</div>
              <div className="subagent-report-label">{t("用户任务")}</div>
              <InputPreview text={group.input.userMessage} />
              <div className="subagent-report-label">{t("系统提示词（含索引导航）")}</div>
              <InputPreview text={group.input.systemPromptOverride} />
            </div>
          ) : null}
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
