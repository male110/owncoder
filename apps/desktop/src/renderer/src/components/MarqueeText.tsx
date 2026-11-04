import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";

// 长文本走马灯：静止时仅右侧渐隐；鼠标在所在行上停留满 1 秒后开始循环滚动，
// 末尾停留 2 秒再进入下一轮。
const marqueeGapPx = 24;
const marqueePixelsPerSecond = 40;
const minimumMarqueeDurationSeconds = 6;
const marqueePauseSeconds = 2;
const marqueeHoverDelayMs = 1_000;
const marqueeMaskFadeInSeconds = 0.15;
const rightFadeMask =
  "linear-gradient(to right, black 0, black calc(100% - 1.5rem), transparent 100%)";
const bothEdgesFadeMask =
  "linear-gradient(to right, transparent 0, black 1.5rem, black calc(100% - 1.5rem), transparent 100%)";

function createMaskKeyframe(maskImage: string, offset: number): Keyframe {
  return { maskImage, offset, webkitMaskImage: maskImage };
}

type MarqueeTextProps = ComponentPropsWithoutRef<"span"> & {
  /** 触发走马灯的最近祖先选择器；默认取所在会话行，整行悬停都算数。 */
  hoverSelector?: string;
};

export function MarqueeText({
  children,
  className,
  hoverSelector = ".session-row, .session-wrap",
  // 原生 title 提示框会在 hover 走马灯时遮挡正在滚动的文字。
  // 在组件边界统一消费该属性，避免各调用方漏掉后再次引入 tooltip。
  title: _nativeTitle,
  ...props
}: MarqueeTextProps) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const originalTextRef = useRef<HTMLSpanElement | null>(null);
  const marqueeTrackRef = useRef<HTMLSpanElement | null>(null);
  const [overflowState, setOverflowState] = useState({
    distance: 0,
    duration: minimumMarqueeDurationSeconds,
    isOverflowing: false,
  });
  const { distance, duration, isOverflowing } = overflowState;

  useEffect(() => {
    const textElement = textRef.current;
    const originalTextElement = originalTextRef.current;
    if (!textElement || !originalTextElement) return;

    const updateOverflow = () => {
      // 以单份标题的真实排版宽度为准，避免走马灯副本撑大 scrollWidth 后无法退出溢出状态。
      const contentWidth = originalTextElement.scrollWidth;
      const nextIsOverflowing = contentWidth > textElement.clientWidth;
      const nextDistance = nextIsOverflowing ? contentWidth + marqueeGapPx : 0;
      const nextDuration = nextIsOverflowing
        ? Math.max(minimumMarqueeDurationSeconds, nextDistance / marqueePixelsPerSecond)
        : minimumMarqueeDurationSeconds;
      setOverflowState((current) =>
        current.isOverflowing === nextIsOverflowing &&
        current.distance === nextDistance &&
        current.duration === nextDuration
          ? current
          : {
              distance: nextDistance,
              duration: nextDuration,
              isOverflowing: nextIsOverflowing,
            },
      );
    };

    updateOverflow();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateOverflow);
      return () => window.removeEventListener("resize", updateOverflow);
    }

    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(textElement);
    resizeObserver.observe(originalTextElement);
    return () => resizeObserver.disconnect();
  }, [children]);

  useEffect(() => {
    const textElement = textRef.current;
    const marqueeTrack = marqueeTrackRef.current;
    if (
      !isOverflowing ||
      !textElement ||
      !marqueeTrack ||
      typeof marqueeTrack.animate !== "function"
    ) {
      return;
    }

    const reducedMotionQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    // 走马灯事件若只绑在文字节点上，鼠标位于行内时间、状态等区域时不会滚动；
    // 统一绑到最近的会话行边界。
    const hoverTarget = textElement.closest<HTMLElement>(hoverSelector) ?? textElement;
    let animations: Animation[] = [];
    let startTimer: number | null = null;

    const stopMarquee = () => {
      if (startTimer !== null) {
        window.clearTimeout(startTimer);
        startTimer = null;
      }
      animations.forEach((animation) => animation.cancel());
      animations = [];
    };
    const startMarquee = () => {
      if (reducedMotionQuery?.matches) return;

      stopMarquee();
      const totalDuration = duration + marqueePauseSeconds;
      // 纯 CSS infinite 动画只能按百分比停顿，标题宽度变化时无法保证
      // 副本头部对齐后固定等待 2 秒。Web Animation 用动态 offset 分离移动与停留时长。
      const movementEndOffset = duration / totalDuration;
      const maskFadeInEndOffset = marqueeMaskFadeInSeconds / totalDuration;
      // 左侧 mask 在 24px 间距内继续淡出，会让已经离场的主体标题
      // 仍留下一段无内容的渐变。主体尾部到达左边缘时直接切换为仅右侧 mask。
      const originalTailArrivalTime = duration * ((distance - marqueeGapPx) / distance);
      const originalTailArrivalOffset = originalTailArrivalTime / totalDuration;
      const animationOptions: KeyframeAnimationOptions = {
        duration: totalDuration * 1_000,
        easing: "linear",
        iterations: Infinity,
      };
      const trackAnimation = marqueeTrack.animate(
        [
          { offset: 0, transform: "translate3d(0, 0, 0)" },
          {
            offset: movementEndOffset,
            transform: `translate3d(-${distance}px, 0, 0)`,
          },
          {
            offset: 1,
            transform: `translate3d(-${distance}px, 0, 0)`,
          },
        ],
        animationOptions,
      );
      // 滚动期间始终使用双侧 mask，会让副本对齐后的 2 秒停留画面
      // 仍然看不清标题开头。mask 与位移动画共用时长，在到达前淡出左侧并保持到下一轮。
      const maskAnimation = textElement.animate(
        [
          createMaskKeyframe(rightFadeMask, 0),
          createMaskKeyframe(bothEdgesFadeMask, maskFadeInEndOffset),
          createMaskKeyframe(bothEdgesFadeMask, originalTailArrivalOffset),
          createMaskKeyframe(rightFadeMask, originalTailArrivalOffset),
          createMaskKeyframe(rightFadeMask, 1),
        ],
        animationOptions,
      );
      animations = [trackAnimation, maskAnimation];
    };
    const scheduleMarquee = () => {
      if (reducedMotionQuery?.matches) return;

      stopMarquee();
      // 交互规则：短暂划过会话行不应立即触发运动；停留满 1 秒才开始。
      startTimer = window.setTimeout(() => {
        startTimer = null;
        startMarquee();
      }, marqueeHoverDelayMs);
    };
    const handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
      if (event.matches) stopMarquee();
    };

    hoverTarget.addEventListener("mouseenter", scheduleMarquee);
    hoverTarget.addEventListener("mouseleave", stopMarquee);
    reducedMotionQuery?.addEventListener("change", handleMotionPreferenceChange);

    return () => {
      hoverTarget.removeEventListener("mouseenter", scheduleMarquee);
      hoverTarget.removeEventListener("mouseleave", stopMarquee);
      reducedMotionQuery?.removeEventListener("change", handleMotionPreferenceChange);
      stopMarquee();
    };
  }, [distance, duration, isOverflowing, hoverSelector]);

  return (
    <span
      ref={textRef}
      className={["marquee-text", isOverflowing ? "is-overflowing" : "", className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      <span ref={marqueeTrackRef} className="marquee-track">
        <span ref={originalTextRef} className="marquee-copy">
          {children}
        </span>
        {isOverflowing ? (
          <span aria-hidden="true" className="marquee-copy">
            {children}
          </span>
        ) : null}
      </span>
    </span>
  );
}
