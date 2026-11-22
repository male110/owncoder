import { useEffect, useState, memo, createContext, useContext } from "react";
import type { ChatTurnDto, PlanInfoDto } from "../../../../preload/index";
import { Markdown } from "../Markdown";
import { useI18n } from "../../i18n";
import { extractPlanPath, stripPlanMarker } from "./plan-marker";
import { stripToolCallBlocks } from "./tool-call-display";

export const PlanActionsContext = createContext<{
  plans: PlanInfoDto[];
  activePlanPath: string | null;
  busy: boolean;
  onApprovePlan: (path: string) => void;
  /**
   * 共享的 per-plan 批准飞行锁（key = planPath）。
   * PlanCard 与应用层批准入口共用同一把锁，避免并发重复批准。
   */
  approvingPlanPaths?: Set<string>;
} | null>(null);

export function PlanCard({
  planPath,
  sessionId,
  onOpenFile,
}: {
  planPath: string;
  sessionId?: string;
  /** 在主窗口的编辑器标签页中打开计划文件（替代独立 Electron 窗口）。 */
  onOpenFile?: (path: string) => void;
}) {
  const actions = useContext(PlanActionsContext);
  /** 部分内容：随卡片直接展示（对齐 ZCode 计划卡片），完整内容由点击标题在编辑器标签页查看。 */
  const [content, setContent] = useState<string | null>(null);
  const plan = actions?.plans.find((p) => p.path === planPath && p.sessionId === sessionId);
  const { t } = useI18n();
  const title = plan?.title && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?:\.md)?$/i.test(plan.title)
    ? t("计划已生成：{{name}}", { name: plan.title }) : t("已生成计划");
  const approved = actions?.activePlanPath === planPath;
  // 批准去重锁来自共享层（PlanActionsContext），与应用层批准入口共用同一把 per-plan 飞行锁。
  const approving = actions?.approvingPlanPaths?.has(planPath) ?? false;
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    if (sessionId) {
      void window.owncoder.readPlan(planPath, sessionId).then((text) => {
        if (!cancelled) setContent(text);
      }, () => {});
    }
    return () => { cancelled = true; };
  }, [planPath, sessionId]);
  const open = () => {
    // openEditorFile 内部会先用 readPlan 校验会话归属，再以新标签页打开计划文件。
    if (!sessionId) return;
    onOpenFile?.(planPath);
  };
  const approve = () => {
    if (!plan || plan.kind === "document" || approved || approving || actions?.busy) return;
    actions?.onApprovePlan(planPath);
  };
  return (
    <div>
    <div className="plan-card">
      <div className="plan-card-icon">📋</div>
      <div className="plan-card-body">
        {/* 点击标题在主窗口编辑器标签页打开完整计划文件。 */}
        <button type="button" className="plan-card-title" onClick={open} disabled={!sessionId}
          title={sessionId ? t("查看完整计划") : t("未知会话")}>
          {title}
        </button>
      </div>
    </div>
    {/* 文案态（文档交付物 / 已批准）留在正文上方；待批准时按钮悬浮在正文之上（对齐 ZCode 计划卡片）。 */}
    {plan?.kind === "document" ? (
      <span className="plan-kind-note">{t("文档交付物 · 无需批准（如需执行请生成实施计划）")}</span>
    ) : approved ? (
      <span className="plan-kind-note">{t("已批准")}</span>
    ) : plan && content === null ? (
      /* 正文尚未加载完成时，批准按钮留在原位，避免孤悬。 */
      <button
        type="button"
        className="plan-approve-cta"
        disabled={actions?.busy || approving}
        onClick={approve}
      >
        {approving ? t("批准中…") : t("批准计划")}
      </button>
    ) : null}
    {content !== null ? (
      <div className="plan-preview-wrap">
        <pre className="plan-preview-body plan-preview-body--masked">{content}</pre>
        {plan && plan.kind !== "document" && !approved ? (
          <button
            type="button"
            className="plan-approve-cta plan-approve-float"
            disabled={actions?.busy || approving}
            onClick={approve}
          >
            {approving ? t("批准中…") : t("批准计划")}
          </button>
        ) : null}
      </div>
    ) : null}
    </div>
  );
}

function AssistantBubbleImpl({
  sessionId,
  turn,
  canRegenerate,
  regenerating,
  onRegenerate,
  onOpenFile,
  workspaceRoot,
  onDelete,
}: {
  sessionId?: string;
  turn: ChatTurnDto;
  canRegenerate: boolean;
  regenerating: boolean;
  onRegenerate?: () => void;
  onOpenFile?: (path: string) => void;
  workspaceRoot?: string;
  onDelete?: (turnId: string) => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const planPath = extractPlanPath(turn.content);
  const contentWithoutToolCalls = stripToolCallBlocks(turn.content);
  const displayContent = planPath ? stripPlanMarker(contentWithoutToolCalls) : contentWithoutToolCalls;
  const [validatedPlan, setValidatedPlan] = useState<string | null>(null);
  const validationKey = `${sessionId}:${planPath}`;
  useEffect(() => {
    let cancelled = false;
    setValidatedPlan(null);
    if (planPath && sessionId) {
      void window.owncoder.readPlan(planPath, sessionId).then(() => {
        if (!cancelled) setValidatedPlan(validationKey);
      }, () => {});
    }
    return () => { cancelled = true; };
  }, [planPath, sessionId, validationKey]);

  // 压缩相关信息
  const isCompressed = turn.isCompressed === true;
  const compressionRatio = turn.originalLength && turn.content.length
    ? Math.round((turn.content.length / turn.originalLength) * 100)
    : null;
  const hasImportantSnippets = turn.importantSnippets && turn.importantSnippets.length > 0;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  if (planPath && validatedPlan !== validationKey) return null;
  return (
    <div className={`msg assistant ${isCompressed ? "compressed" : ""}`}>
      {isCompressed && (
        <div className="compression-header">
          <div className="compression-stats">
            <strong>{t("压缩信息：")}</strong>
            {turn.compressionReason && (
              <span className="reason">{t("原因：")}{
                turn.compressionReason === 'context_limit' ? t("上下文限制") :
                turn.compressionReason === 'manual' ? t("手动压缩") :
                turn.compressionReason === 'auto' ? t("自动压缩") :
                turn.compressionReason === 'disk_save' ? t("磁盘保存") :
                turn.compressionReason === 'retained' ? t("完整保留") : turn.compressionReason
              }</span>
            )}
            {turn.originalLength && (
              <span className="ratio">{t("压缩率：{{ratio}}% ({{cur}}/{{orig}}字符)", { ratio: compressionRatio ?? 0, cur: turn.content.length, orig: turn.originalLength })}</span>
            )}
            {turn.compressedAt && (
              <span className="time">{t("时间：{{time}}", { time: new Date(turn.compressedAt).toLocaleString() })}</span>
            )}
          </div>
          {hasImportantSnippets && (
            <div className="important-snippets">
              <strong>{t("保留的重要片段：")}</strong>
              <ul>
                {turn.importantSnippets!.map((snippet, i) => (
                  <li key={`${snippet}-${i}`} title={snippet}>{snippet}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {/* 计划通知：正文（「计划已保存：…/请查看计划…」）对用户无信息量，卡片
          已承载计划名称、部分内容、批准入口与完整查看，整块替换为 PlanCard。 */}
      {planPath ? <PlanCard planPath={planPath} sessionId={sessionId} onOpenFile={onOpenFile} /> : (
        <Markdown content={displayContent} onOpenFile={onOpenFile} workspaceRoot={workspaceRoot} />
      )}
      <div className="msg-actions">
        <button type="button" className="msg-action-btn" onClick={() => void onCopy()} title={t("复制")}>
          {copied ? t("已复制") : t("复制")}
        </button>
        {canRegenerate && onRegenerate ? (
          <button
            type="button"
            className="msg-action-btn"
            disabled={regenerating}
            onClick={onRegenerate}
            title={t("重新生成")}
          >
            {regenerating ? t("生成中…") : t("重新生成")}
          </button>
        ) : null}
        {turn.turnId && onDelete ? (
          confirming ? (
            <>
              <button
                type="button"
                className="msg-action-btn danger"
                onClick={() => {
                  onDelete(turn.turnId!);
                  setConfirming(false);
                }}
                title={t("确认删除")}
              >
                {t("确认删除该回复及输入？")}
              </button>
              <button
                type="button"
                className="msg-action-btn"
                onClick={() => setConfirming(false)}
              >
                {t("取消")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="msg-action-btn"
              onClick={() => setConfirming(true)}
              title={t("删除该回复及对应输入")}
            >
              {t("删除")}
            </button>
          )
        ) : null}
        {isCompressed && (
          <span className="compression-badge" title={t("已压缩内容")}>
            {t("🗜️ 压缩")}
          </span>
        )}
      </div>
    </div>
  );
}

export const AssistantBubble = memo(AssistantBubbleImpl, (prev, next) =>
  prev.sessionId === next.sessionId &&
  (prev.turn === next.turn ||
    (prev.turn.id === next.turn.id &&
      prev.turn.content === next.turn.content &&
      prev.turn.isCompressed === next.turn.isCompressed &&
      prev.turn.originalLength === next.turn.originalLength)) &&
  prev.canRegenerate === next.canRegenerate &&
  prev.regenerating === next.regenerating &&
  prev.onRegenerate === next.onRegenerate &&
  prev.onOpenFile === next.onOpenFile &&
  prev.workspaceRoot === next.workspaceRoot &&
  prev.onDelete === next.onDelete
);
