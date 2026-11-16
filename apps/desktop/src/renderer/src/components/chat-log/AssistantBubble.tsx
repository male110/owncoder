import { useEffect, useState, memo, createContext, useContext } from "react";
import type { ChatTurnDto, PlanInfoDto } from "../../../../preload/index";
import { Markdown } from "../Markdown";
import { useI18n } from "../../i18n";
import { extractPlanPath, stripPlanMarker } from "./plan-marker";

export const PlanActionsContext = createContext<{
  plans: PlanInfoDto[];
  activePlanPath: string | null;
  busy: boolean;
  onApprovePlan: (path: string) => void;
  /**
   * 共享的 per-plan 批准飞行锁（key = planPath）。
   * PlanCard 与 PlansBar 两个入口共用同一把锁，避免并发重复批准。
   */
  approvingPlanPaths?: Set<string>;
} | null>(null);

export function PlanCard({ planPath, sessionId, onOpen }: { planPath: string; sessionId?: string; onOpen: (path: string) => void }) {
  const actions = useContext(PlanActionsContext);
  const [preview, setPreview] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [copied, setCopied] = useState(false);
  const plan = actions?.plans.find((p) => p.path === planPath && p.sessionId === sessionId);
  const approved = actions?.activePlanPath === planPath;
  // 批准去重锁来自共享层（PlanActionsContext），与 PlansBar 共用同一把 per-plan 飞行锁。
  const approving = actions?.approvingPlanPaths?.has(planPath) ?? false;
  const open = async () => {
    if (!sessionId || opening) return;
    setOpening(true);
    try {
      setPreview(await window.owncoder.readPlan(planPath, sessionId));
    } catch {
      setPreview(null);
    } finally {
      setOpening(false);
    }
  };
  const approve = () => {
    if (!plan || plan.kind === "document" || approved || approving || actions?.busy) return;
    actions?.onApprovePlan(planPath);
  };
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(planPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };
  const fileName = planPath.split("/").pop() ?? planPath;
  const { t } = useI18n();
  return (
    <div>
    <div className="plan-card">
      <div className="plan-card-icon">📋</div>
      <div className="plan-card-body">
        <div className="plan-card-title">{t("已生成计划")}</div>
        <div className="plan-card-filename">{fileName}</div>
        <div className="plan-card-path">{planPath}</div>
      </div>
      <button
        type="button"
        className="plan-card-copy"
        onClick={() => void copyPath()}
        title={copied ? t("已复制") : t("复制路径")}
      >
        {copied ? "✓" : "⧉"}
      </button>
      <button type="button" className="plan-card-open" onClick={() => void open()} disabled={opening}>
        {t("打开 →")}
      </button>
    </div>
      {preview !== null ? (
        <div className="plan-preview">
          <div className="prompt-toolbar">
            <strong>{planPath}</strong>
            <div className="plan-preview-actions">
              <button type="button" className="ghost tiny" onClick={() => onOpen(planPath)}>{t("在编辑器中打开")}</button>
              <button type="button" className="ghost tiny" onClick={() => setPreview(null)}>{t("关闭预览")}</button>
            </div>
          </div>
          {/* 限高 + mask 渐隐必须落在同一节点，分层会导致渐隐失效（借鉴 ZCode switch-mode.tsx L113-114）。 */}
          <pre className="plan-preview-body plan-preview-body--masked">{preview}</pre>
          {plan?.kind === "document" ? (
            <span className="plan-kind-note">{t("文档交付物 · 无需批准（如需执行请生成实施计划）")}</span>
          ) : approved ? (
            <span className="plan-kind-note">{t("已批准")}</span>
          ) : plan ? (
            <button
              type="button"
              className="plan-approve-cta"
              disabled={actions?.busy || approving}
              onClick={approve}
            >
              {approving ? t("批准中…") : t("批准此计划并自动执行")}
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

  const planPath      = extractPlanPath(turn.content);
  const displayContent = planPath ? stripPlanMarker(turn.content) : turn.content;
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
      <Markdown content={displayContent} onOpenFile={onOpenFile} workspaceRoot={workspaceRoot} />
      {planPath ? <PlanCard planPath={planPath} sessionId={sessionId} onOpen={(p) => onOpenFile?.(p)} /> : null}
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
