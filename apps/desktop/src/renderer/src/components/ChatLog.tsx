import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { Virtuoso } from "react-virtuoso";
import type { VirtuosoHandle } from "react-virtuoso";
import type { ChatTurnDto, TaskItemDto } from "../../../preload/index";
import type { LiveEvent, LlmRetryState } from "../store/chat-store";
import { useI18n } from "../i18n";
import {
  buildChatItems,
  buildLogBlocks,
  deriveLiveStatus,
  isActivationEdge,
  isInitialScrollReady,
  lastAssistantBlockIndex,
  toolStatusLabel as toolStatusLabelFromModel,
  type ChatItem,
  type LogBlock,
} from "./chat-log-model";
import { AssistantBubble } from "./chat-log/AssistantBubble";
import { DecomposeCard } from "./chat-log/DecomposeCard";
import { LiveEventStream } from "./chat-log/LiveEventStream";
import { LlmRetryNotice } from "./chat-log/LlmRetryNotice";
import { ProcessSteps } from "./chat-log/ProcessSteps";
import { UserBubble } from "./chat-log/UserBubble";
import { useCopyMenu } from "./chat-log/useCopyMenu";



/** Re-export with the original `export function` shape for existing importers. */
export function toolStatusLabel(
  phase: "running" | "done" | "error",
  name?: string,
  args?: Record<string, unknown>,
): string {
  return toolStatusLabelFromModel(phase, name, args);
}

// ── ChatLog ───────────────────────────────────────────────────────────────────

interface Props {
  turns: ChatTurnDto[];
  liveEvents: LiveEvent[];
  liveStatus: string;
  sending: boolean;
  /** True 表示处于「正在停止…」窗口，允许删除尚无 turnId 的乐观用户行。 */
  stopping?: boolean;
  virtuosoRef?: React.RefObject<VirtuosoHandle | null>;
  onRegenerate?: () => void;
  onDeleteTurn?: (turnId: string) => void;
  /** 「正在停止…」窗口删除刚发出的乐观消息（本地丢弃 + 落盘后补删）。 */
  onDiscardInflight?: () => void;
  onOpenFile?: (path: string) => void;
  workspaceRoot?: string;
  /** Rendered above the first message inside the scroll viewport. */
  header?: React.ReactNode;
  onStartReached?: () => void;
  /** Ref to the underlying scroll container (footer-aware bottom scrolling). */
  scrollerRef?: React.RefObject<HTMLElement | null>;
  /**
   * 面板是否可见。所有会话面板常驻挂载、用 display:none 切换，
   * sessionId 在单个实例上恒定，因此用 active 的 false→true 边沿
   * 作为「切换到本会话」信号，重新触发初始滚动到底部。
   */
  active?: boolean;
  /** 会话活动计划的任务（含执行状态），供任务分解卡片联动执行进度。 */
  planTasks?: TaskItemDto[];
  /** 等待中的 LLM 失败重试；非空时在实时状态行展示倒计时。 */
  llmRetry?: LlmRetryState | null;
}

export function ChatLog({
  turns,
  liveEvents,
  liveStatus,
  sending,
  stopping = false,
  virtuosoRef,
  onRegenerate,
  onDeleteTurn,
  onDiscardInflight,
  onOpenFile,
  workspaceRoot,
  header,
  onStartReached,
  scrollerRef,
  active = true,
  planTasks,
  llmRetry = null,
}: Props) {
  const { t } = useI18n();
  const blocks = useMemo(
    () => buildLogBlocks(turns, sending, liveEvents.length),
    [turns, sending, liveEvents.length],
  );

  const START_INDEX = 100_000;
  const [firstItemIndex, setFirstItemIndex] = useState(START_INDEX);
  const prevItemsRef = useRef<{ length: number; firstKey?: string }>({ length: 0 });

  // Live status/stream render OUTSIDE Virtuoso (same custom scroller), so
  // streaming text updates React-render immediately. Virtuoso Footer+context
  // previously could keep showing only "思考中…" until a remount (session switch).
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const atBottomRef = useRef(true);
  const lastRenderedIndexRef = useRef<number | null>(null);
  // 虚拟列表异步量高或渲染新范围后，唤醒首屏贴底流程。
  const retryInitialPinRef = useRef<(() => void) | null>(null);
  const AT_BOTTOM_THRESHOLD = 80;

  const bindScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scrollerElRef.current = el;
      setScrollParent(el);
      if (scrollerRef) scrollerRef.current = el;
    },
    [scrollerRef],
  );

  const syncAtBottom = useCallback(() => {
    const el = scrollerElRef.current;
    if (!el) return;
    atBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD;
  }, []);

  const scrollToTrueBottom = useCallback(() => {
    const el = scrollerElRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (!sending && liveEvents.length === 0) return;
    if (!atBottomRef.current) return;
    const raf = requestAnimationFrame(() => scrollToTrueBottom());
    return () => cancelAnimationFrame(raf);
  }, [liveEvents, liveStatus, sending, scrollToTrueBottom]);

  const lastAssistantIdx = useMemo(() => lastAssistantBlockIndex(blocks), [blocks]);

  const derivedStatus = useMemo(
    () => deriveLiveStatus(sending, liveStatus, liveEvents),
    [sending, liveStatus, liveEvents],
  );

  // Decomposition cards belong to the current turn.
  // They must render BEFORE the in-progress assistant reply so the plan is
  // visible ahead of the LLM response.
  const decompositionCards = useMemo(
    () => liveEvents.filter((e): e is Extract<LiveEvent, { kind: "decompose" }> => e.kind === "decompose"),
    [liveEvents],
  );
  const nonDecomposeLiveEvents = useMemo(
    () => liveEvents.filter((e) => e.kind !== "decompose"),
    [liveEvents],
  );
  const showLiveFooter =
    Boolean(derivedStatus) ||
    llmRetry !== null ||
    decompositionCards.length > 0 ||
    nonDecomposeLiveEvents.length > 0;

  const renderBlock = useCallback((b: LogBlock, i: number) => {
    if (b.kind === "user")
      return (
        <UserBubble
          turn={b.turn}
          stopping={stopping}
          onDelete={onDeleteTurn}
          onDiscardInflight={onDiscardInflight}
        />
      );
    if (b.kind === "assistant") {
      return (
        <AssistantBubble
          turn={b.turn}
          canRegenerate={i === lastAssistantIdx && !sending && liveEvents.length === 0}
          regenerating={sending}
          onRegenerate={onRegenerate}
          onOpenFile={onOpenFile}
          workspaceRoot={workspaceRoot}
          onDelete={onDeleteTurn}
        />
      );
    }
    // 已完成轮次的过程步骤 → 可展开的折叠控件（默认收起）。
    if (b.kind === "process") return <ProcessSteps items={b.items} />;
    // 进行中轮次的工具链由 LiveToolCard / liveStatus 展示，不在列表里重复。
    return null;
  }, [lastAssistantIdx, sending, stopping, liveEvents.length, onRegenerate, onDeleteTurn, onDiscardInflight, onOpenFile]);

  // History rows only — live status/stream render after Virtuoso inside the
  // shared scroller so streaming updates don't depend on Footer remounts.
  const items = useMemo(() => buildChatItems(blocks), [blocks]);

  // 初始贴底 effect 的稳定触发信号：只关心「从空到有内容」的翻转，
  // 不把 liveEvents.length / sending 这类流式高频值放进 deps，
  // 避免流式期间 rAF 循环与 ResizeObserver 反复 teardown/重建。
  const hasContent = items.length > 0 || liveEvents.length > 0 || sending;

  // Prepend older messages by shifting firstItemIndex so Virtuoso keeps the
  // previously visible row in place instead of jumping to the new top.
  useEffect(() => {
    const prev = prevItemsRef.current;
    const firstKey = items[0]?.key;
    const delta = items.length - prev.length;
    prevItemsRef.current = { length: items.length, firstKey };
    if (prev.length === 0 && items.length > 0) {
      // A live footer may have settled before the asynchronous history arrived.
      initialBottomAppliedRef.current = false;
      lastRenderedIndexRef.current = null;
    }
    if (prev.length === 0 || delta <= 0) return;
    if (firstKey && firstKey !== prev.firstKey) {
      setFirstItemIndex((value) => value - delta);
    }
  }, [items]);

  // A session can mount before its history request completes. In that case
  // Virtuoso's mount-only initialTopMostItemIndex is calculated from an empty
  // list and cannot place the first rendered batch at the bottom.
  // customScrollParent is also assigned after the first paint, which can reset
  // scroll to the top — keep pinning until the scroller actually settles so
  // switching sessions lands on the latest messages.
  const initialBottomAppliedRef = useRef(false);

  // 面板常驻挂载：active 的 false→true 边沿才是真正的「切换到本会话」。
  // 此时重置初始钉底标志，确保切到正在 streaming 的会话也会重新贴底。
  const prevActiveRef = useRef(active);
  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;
    if (isActivationEdge(wasActive, active)) {
      initialBottomAppliedRef.current = false;
      lastRenderedIndexRef.current = null;
    }
  }, [active]);

  useEffect(() => {
    // 隐藏期间（display:none，clientHeight=0）不能跑钉底循环，
    // 否则会在不可见状态下误判 settle；等面板可见后再执行。
    if (!active) return;
    if (initialBottomAppliedRef.current) return;
    if (!hasContent) return;
    if (!scrollParent) return;

    let cancelled = false;
    // 用户在初始贴底阶段主动上滚（wheel/touch/键盘翻页）→ 尊重用户位置，
    // 立即停止钉底，并锁定 initialBottomAppliedRef，避免 deps 变化后重建
    // effect 再次强制覆盖（atBottomRef 也不会再被写成 true）。
    let userTookOver = false;
    const takeOver = () => {
      userTookOver = true;
      initialBottomAppliedRef.current = true;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) takeOver();
    };
    let touchStartY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (touchStartY != null && y != null && y < touchStartY) takeOver();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") takeOver();
    };
    scrollParent.addEventListener("wheel", onWheel, { passive: true });
    scrollParent.addEventListener("touchstart", onTouchStart, { passive: true });
    scrollParent.addEventListener("touchmove", onTouchMove, { passive: true });
    scrollParent.addEventListener("keydown", onKeyDown);

    let attempts = 0;
    let settledFrames = 0;
    let lastHeight = 0;
    let frame = 0;
    let framePending = false;
    // Virtuoso + customScrollParent 对长列表的尾部量高常常远超固定帧预算
    // （首屏只量到第一批次，尾部行要等异步 resize 才落定）。改用墙钟截止：
    // 在截止时间前持续钉底，而不是在短帧数后就停止、只剩 ResizeObserver。
    const DEADLINE_MS = 5000;
    let startedAt = Date.now();
    let pinSuspended = false;

    const schedulePin = () => {
      if (cancelled || userTookOver || initialBottomAppliedRef.current || framePending) return;
      framePending = true;
      frame = requestAnimationFrame(() => {
        framePending = false;
        pin();
      });
    };
    retryInitialPinRef.current = () => {
      // 新量高或新虚拟行范围：若仍在截止时间内，继续钉底；
      // 已停止（超时）的循环也会被重新唤醒，覆盖超慢的异步量高。
      if (pinSuspended) {
        pinSuspended = false;
        startedAt = Date.now();
      }
      schedulePin();
    };

    const readBottomState = (el: HTMLElement) => {
      const overflow = el.scrollHeight > el.clientHeight + AT_BOTTOM_THRESHOLD;
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD;
      return { overflow, atBottom };
    };

    const lastItemIndex = firstItemIndex + items.length - 1;

    const markSettledIfReady = (el: HTMLElement, heightStable: boolean) => {
      const { overflow, atBottom } = readBottomState(el);
      // 量高完成前 scrollHeight≈clientHeight，不能当成已经在底部。
      // 短会话始终无 overflow：等若干帧高度稳定后再允许 settle。
      // The outer scroller can appear settled while Virtuoso has only measured
      // the first batch. Wait for its last item before releasing the pin.
      // 空时间线（切换后会话历史尚未水合完成）永远不能 settle：否则会在
      // 顶部提前闩锁 initialBottomAppliedRef，后续历史/live 内容到达时
      // pin() 直接返回，不再贴底。会话切换先重置为跟随，
      // 等真实内容 commit 后再按 following 状态贴底。
      const readyToSettle =
        items.length > 0 &&
        isInitialScrollReady(
          lastRenderedIndexRef.current,
          lastItemIndex,
          atBottom, heightStable, overflow, attempts,
        );
      settledFrames = readyToSettle ? settledFrames + 1 : 0;
      if (settledFrames >= 3) {
        initialBottomAppliedRef.current = true;
        return true;
      }
      return false;
    };

    const pin = () => {
      if (cancelled || userTookOver || initialBottomAppliedRef.current) return;
      // A DOM scroll alone cannot reach virtual rows not laid out yet.
      if (items.length > 0 && lastRenderedIndexRef.current !== lastItemIndex) {
        virtuosoRef?.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
      }
      scrollToTrueBottom();
      atBottomRef.current = true;
      attempts += 1;
      const el = scrollerElRef.current;
      if (el && markSettledIfReady(el, el.scrollHeight === lastHeight)) {
        lastHeight = el.scrollHeight;
        return;
      }
      if (el) lastHeight = el.scrollHeight;
      // 墙钟截止：超时后停止 rAF 空转并挂起，留给 ResizeObserver/唤醒重试；
      // 截止时间内（含尚未量完尾部的长列表）持续钉底，避免停在顶部。
      if (Date.now() - startedAt >= DEADLINE_MS) {
        pinSuspended = true;
        return;
      }
      schedulePin();
    };
    schedulePin();

    const ro = new ResizeObserver(() => {
      // DOM 变化不一定伴随虚拟行范围变化；重新定位最后一行，再校正外层滚动容器。
      retryInitialPinRef.current?.();
    });
    ro.observe(scrollParent);
    const inner = scrollParent.firstElementChild;
    if (inner) ro.observe(inner);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      retryInitialPinRef.current = null;
      ro.disconnect();
      scrollParent.removeEventListener("wheel", onWheel);
      scrollParent.removeEventListener("touchstart", onTouchStart);
      scrollParent.removeEventListener("touchmove", onTouchMove);
      scrollParent.removeEventListener("keydown", onKeyDown);
    };
  }, [active, hasContent, scrollParent, scrollToTrueBottom, items.length, firstItemIndex, virtuosoRef]);

  // 仅挂载时生效：有历史时从底部起，避免先顶后跳
  const initialTopMostItemIndex = useMemo(
    () =>
      items.length > 0
        ? { index: START_INDEX + items.length - 1, align: "end" as const }
        : START_INDEX,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
    [],
  );

  const virtuosoComponents = useMemo(
    () => (header ? { Header: () => <>{header}</> } : {}),
    [header],
  );

  const { copyMenu, copyMenuRef, handleContextMenu, handleCopy } = useCopyMenu();

  return (
    <div className="chat-log wide">
      <div
        className="chat-log-scroller"
        ref={bindScroller}
        onScroll={syncAtBottom}
        onContextMenu={handleContextMenu}
      >
        <Virtuoso<ChatItem>
          ref={virtuosoRef}
          className="chat-log-virtuoso"
          data={items}
          // Live stream is outside Virtuoso; keep followOutput off and scroll
          // the shared scroller ourselves while the user stays at the bottom.
          followOutput={false}
          customScrollParent={scrollParent ?? undefined}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={initialTopMostItemIndex}
          computeItemKey={(_index, item) => item.key}
          rangeChanged={({ endIndex }) => {
            lastRenderedIndexRef.current = endIndex;
            retryInitialPinRef.current?.();
          }}
          totalListHeightChanged={() => retryInitialPinRef.current?.()}
          components={virtuosoComponents}
          startReached={() => {
            // 初始钉底完成前不要触发加载更早消息，否则会把刚切过来的会话钉在顶部
            if (!initialBottomAppliedRef.current) return;
            onStartReached?.();
          }}
          itemContent={(index, item) => renderBlock(item.block, index - firstItemIndex)}
        />
        {showLiveFooter ? (
          <div className="chat-log-live-footer">
            {llmRetry ? <LlmRetryNotice retry={llmRetry} /> : null}
            {derivedStatus ? (
              <div className={`chat-log-status${sending ? " sending" : ""}`}>
                {sending ? <span className="tool-spinner" aria-hidden /> : null}
                <span className="chat-log-status-text">{derivedStatus}</span>
              </div>
            ) : null}
            {decompositionCards.length > 0 || nonDecomposeLiveEvents.length > 0 ? (
              <div className="current-turn-bubble">
                {decompositionCards.length > 0 ? (
                  <div className="chat-log-decomposition">
                    {decompositionCards.map((ev) => (
                      <DecomposeCard
                        key={ev.id}
                        decomposition={ev.decomposition}
                        planTasks={planTasks}
                      />
                    ))}
                  </div>
                ) : null}
                <LiveEventStream events={nonDecomposeLiveEvents} />
              </div>
            ) : null}
          </div>
        ) : null}
        {copyMenu ? (
          <div
            ref={copyMenuRef}
            className="ctx-menu"
            role="menu"
            style={{ left: copyMenu.x, top: copyMenu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button type="button" role="menuitem" onClick={handleCopy}>
              <span>{t("复制")}</span>
              <span className="ctx-menu-key">Ctrl+C</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
