import { useCallback, useEffect, useRef, useState, memo } from "react";
import { useI18n } from "../../i18n";

// ── ThinkingBlock ─────────────────────────────────────────────────────────────
// 思维过程默认收起（流式/完成态都是），头部保留运行态文案与流式摘要行；
// 内容区纯文本按行保留，限高滚动、吸底跟随（用户上滚即暂停，回底恢复）。

const BOTTOM_LOCK_DISTANCE_PX = 2;
const COLLAPSE_ANIMATION_MS = 220;

/** 流式摘要：取最后一条非空行。 */
function resolveStreamingSummary(streamingText: string): { key: string; text: string } | null {
  const lines = streamingText.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index]?.trim() ?? "";
    if (text.length > 0) return { key: String(index), text };
  }
  return null;
}

function resolveScrollMaskState(
  clientHeight: number,
  scrollHeight: number,
  scrollTop: number,
): "none" | "top" | "bottom" | "both" {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  if (maxScrollTop <= 1) return "none";
  const showTop = scrollTop > 1;
  const showBottom = scrollTop < maxScrollTop - 1;
  return showTop && showBottom ? "both" : showTop ? "top" : showBottom ? "bottom" : "none";
}

/** 收起态流式摘要：单行跟随最新 token 右移，溢出时双侧渐隐。 */
function StreamingSummary({ lineKey, text }: { lineKey: string; text: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const syncSummaryViewport = () => {
      const isOverflowing = viewport.scrollWidth > viewport.clientWidth + 1;
      setOverflowing((current) => (current === isOverflowing ? current : isOverflowing));
      // 摘要超过可用宽度后，普通 overflow-hidden 会固定显示旧前缀，
      // 最新 token 被裁在右侧。每次内容增长后把单行视口推到末尾，让旧内容向左移。
      viewport.scrollLeft = viewport.scrollWidth;
    };

    syncSummaryViewport();
    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(syncSummaryViewport);
    resizeObserver.observe(viewport);
    const textElement = textRef.current;
    if (textElement) resizeObserver.observe(textElement);
    return () => resizeObserver.disconnect();
  }, [text]);

  return (
    <span
      ref={viewportRef}
      className={`thinking-summary${overflowing ? " overflowing" : ""}`}
      data-thinking-summary-line={lineKey}
    >
      {/* key=行号：换行时整条摘要滚入；同行内增长则原位刷新不重播 */}
      <span key={lineKey} ref={textRef} className="thinking-summary-text">
        {text}
      </span>
    </span>
  );
}

function ThinkingBlockImpl({
  content,
  streaming,
  stage,
}: {
  content: string;
  streaming: boolean;
  stage?: "decompose" | "react";
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<number | null>(null);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const userInteractedRef = useRef(false);
  const wasStreaming = useRef(streaming);
  // 收起动画需要真实内容高度：关闭先动画 220ms，再延迟卸载内容。
  const [shouldRenderContent, setShouldRenderContent] = useState(false);
  const [collapsing, setCollapsing] = useState(true);
  const autoFollowBottomRef = useRef(true);
  const [maskState, setMaskState] = useState<"none" | "top" | "bottom" | "both">("none");

  // 思考耗时：流式期间且展开时每秒更新（收起态不触发整块重渲染）；
  // 流式结束按同一开始时间补算最终耗时。
  useEffect(() => {
    if (!streaming) {
      if (startTimeRef.current !== null) {
        setDuration(Math.max(1, Math.ceil((Date.now() - startTimeRef.current) / 1000)));
        startTimeRef.current = null;
      }
      return;
    }
    if (startTimeRef.current === null) {
      startTimeRef.current = Date.now();
    }
    if (!open) return;

    const updateDuration = () => {
      if (startTimeRef.current === null) return;
      setDuration(Math.max(1, Math.ceil((Date.now() - startTimeRef.current) / 1000)));
    };
    updateDuration();
    const durationTimer = window.setInterval(updateDuration, 1000);
    return () => window.clearInterval(durationTimer);
  }, [open, streaming]);

  // 输出边界（流式结束）自动收起；用户手动展开过则尊重其选择。
  useEffect(() => {
    if (wasStreaming.current && !streaming && !userInteractedRef.current) {
      setOpen(false);
    }
    wasStreaming.current = streaming;
  }, [streaming]);

  // 展开立即挂载内容；收起先切换 0fr 动画，动画跑完再卸载。
  useEffect(() => {
    if (open) {
      setShouldRenderContent(true);
      setCollapsing(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setCollapsing(false));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setCollapsing(true);
    const unmountTimer = window.setTimeout(() => {
      setShouldRenderContent(false);
    }, COLLAPSE_ANIMATION_MS + 20);
    return () => window.clearTimeout(unmountTimer);
  }, [open]);

  const scrollBodyToBottom = useCallback(() => {
    const scrollNode = bodyRef.current;
    if (scrollNode) scrollNode.scrollTop = scrollNode.scrollHeight;
  }, []);

  const updateBodyMask = useCallback(() => {
    const scrollNode = bodyRef.current;
    if (!scrollNode) return;
    setMaskState(
      resolveScrollMaskState(scrollNode.clientHeight, scrollNode.scrollHeight, scrollNode.scrollTop),
    );
  }, []);

  // 思考内容流式追加时 scrollHeight 会变化；同时监听容器和内容尺寸。
  // 默认吸底跟随最新思考；用户主动离底后暂停，直到用户自己滚回底部再恢复。
  useEffect(() => {
    if (!shouldRenderContent) {
      autoFollowBottomRef.current = true;
      setMaskState("none");
      return;
    }
    const scrollNode = bodyRef.current;
    const contentNode = contentRef.current;
    if (!scrollNode || typeof ResizeObserver === "undefined") return;

    const syncScrollPosition = () => {
      if (autoFollowBottomRef.current) {
        scrollBodyToBottom();
      }
      updateBodyMask();
    };
    syncScrollPosition();
    const resizeObserver = new ResizeObserver(syncScrollPosition);
    resizeObserver.observe(scrollNode);
    if (contentNode) resizeObserver.observe(contentNode);
    return () => resizeObserver.disconnect();
  }, [shouldRenderContent, scrollBodyToBottom, updateBodyMask]);

  useEffect(() => {
    if (!shouldRenderContent) return;
    if (autoFollowBottomRef.current) {
      scrollBodyToBottom();
    }
    updateBodyMask();
  }, [content, shouldRenderContent, scrollBodyToBottom, updateBodyMask]);

  const handleBodyScroll = useCallback(() => {
    const scrollNode = bodyRef.current;
    if (!scrollNode) return;
    const bottomDistance =
      scrollNode.scrollHeight - scrollNode.scrollTop - scrollNode.clientHeight;
    autoFollowBottomRef.current = bottomDistance <= BOTTOM_LOCK_DISTANCE_PX;
    updateBodyMask();
  }, [updateBodyMask]);

  const toggleOpen = useCallback(() => {
    userInteractedRef.current = true;
    setOpen((value) => !value);
  }, []);

  if (!content) return null;

  const stageClass = stage === "decompose" ? "stage-decompose" : stage === "react" ? "stage-react" : "";
  const summary = streaming && !open ? resolveStreamingSummary(content) : null;

  return (
    <div className={`thinking-block${streaming ? " streaming" : ""} ${stageClass}`}>
      <button
        type="button"
        className="thinking-head"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <span className="thinking-icon">⊗</span>
        <span className="thinking-label">
          {streaming ? (
            <span className="thinking-live">{t("思考中…")}</span>
          ) : (
            t("思考过程")
          )}
          {duration !== undefined ? (
            <span className="thinking-duration"> · {t("{{n}}秒", { n: duration })}</span>
          ) : null}
        </span>
        {summary ? <span className="thinking-summary-sep">·</span> : null}
        {summary ? <StreamingSummary lineKey={summary.key} text={summary.text} /> : null}
        <span className="activity-chev">{open ? "▾" : "▸"}</span>
      </button>
      {shouldRenderContent ? (
        <div className={`thinking-collapse${collapsing ? " closing" : ""}`}>
          <div className="thinking-collapse-inner">
            <div
              className="thinking-body"
              ref={bodyRef}
              data-scroll-mask={maskState}
              onScroll={handleBodyScroll}
            >
              <div ref={contentRef} className="thinking-body-inner">
                {content}
                {streaming ? <span className="stream-cursor" /> : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const ThinkingBlock = memo(ThinkingBlockImpl, (prev, next) =>
  prev.content === next.content &&
  prev.streaming === next.streaming &&
  prev.stage === next.stage
);
