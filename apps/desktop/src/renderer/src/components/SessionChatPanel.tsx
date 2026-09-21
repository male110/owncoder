import { useMemo, useRef, useEffect, useCallback } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { useChatStore } from "../store/chat-store";
import type { ChatSessionRuntime } from "../store/chat-store";
import { removeMessage } from "../hooks/queue-controller";
import type { TabId } from "../SettingsPanel";
import { ChatLog } from "./ChatLog";
import { ErrorBanner } from "./ErrorBanner";


interface Props {
  sessionId: string;
  isActive: boolean;
  llmConfigured: boolean;
  onRegenerate: () => void;
  onOpenFile: (path: string) => void;
  onOpenSettings: (tab: TabId) => void;
  onSendQueuedMessage: (index: number) => void;
}

const EMPTY_RUNTIME: ChatSessionRuntime = {
  history: [],
  historyBeforeSeq: null,
  historyHasMore: false,
  historyLoading: false,
  sending: false,
  queuedMessages: [],
  liveEvents: [],
  terminal: [],
  liveStatus: "",
  errorAlert: null,
  taskRun: null,
  dangerousConfirmations: [],
  askRequests: [],
  status: "idle",
};

function useSessionRuntime(sessionId: string) {
  return useChatStore((s) => s.bySession[sessionId] ?? EMPTY_RUNTIME);
}

export function SessionChatPanel({
  sessionId,
  isActive,
  llmConfigured,
  onRegenerate,
  onOpenFile,
  onOpenSettings,
  onSendQueuedMessage,
}: Props) {
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 6) return "夜深了";
    if (h < 12) return "早上好呀";
    if (h < 14) return "中午好";
    if (h < 18) return "下午好";
    if (h < 22) return "晚上好呀，今天辛苦啦";
    return "夜深了，注意休息";
  }, []);

  const rt = useSessionRuntime(sessionId);
  const {
    history,
    historyBeforeSeq,
    historyHasMore,
    historyLoading,
    sending,
    queuedMessages,
    liveEvents,
    liveStatus,
    errorAlert,
  } = rt;


  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const wasActiveRef = useRef(false);
  const hadContentWhileActiveRef = useRef(false);
  const pageInitSessionRef = useRef<string | null>(null);

  const visible = useMemo(
    () =>
      history.filter(
        (t) =>
          (t.role === "user" || t.role === "assistant" || t.role === "tool") &&
          !(t.role === "assistant" && t.content.startsWith("Error:")),
      ),
    [history],
  );

  const isEmpty = visible.length === 0 && liveEvents.length === 0 && !sending;

  // 打开/切换到本会话时滚到底；若历史异步稍后才到，等有内容再滚一次。
  // 流式增量由 ChatLog 内部的 scrollToTrueBottom effect 负责（用户在底部时
  // 跟随 Footer 活流；用户上滚后自动停止），这里只处理激活/初始定位。
  useEffect(() => {
    if (!isActive) {
      wasActiveRef.current = false;
      hadContentWhileActiveRef.current = false;
      return;
    }

    const justActivated = !wasActiveRef.current;
    wasActiveRef.current = true;

    if (isEmpty) return;

    const contentJustArrived = !hadContentWhileActiveRef.current;
    hadContentWhileActiveRef.current = true;

    if (!justActivated && !contentJustArrived) return;

    const scrollToBottom = () => {
      // Footer-aware: scroll to the true bottom (includes live stream footer),
      // not just the last virtual item (which parks above a tall footer).
      const el = scrollerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      } else {
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
      }
    };

    let cancelled = false;
    const timers: number[] = [];
    const schedule = (ms: number) => {
      timers.push(
        window.setTimeout(() => {
          if (!cancelled) requestAnimationFrame(scrollToBottom);
        }, ms),
      );
    };

    // 切会话后 Virtuoso 换 customScrollParent / 量高需要多帧，多补几次避免停在顶部
    schedule(0);
    schedule(50);
    schedule(150);
    schedule(300);

    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, [isActive, isEmpty]);

  const onLoadOlder = useCallback(async () => {
    if (historyLoading || !historyHasMore) return;
    const store = useChatStore.getState();
    store.setHistoryPageState({ historyLoading: true }, sessionId);
    try {
      const page = await window.owncoder.getChatHistoryPage(sessionId, historyBeforeSeq ?? undefined, 10);
      store.prependHistory(page.turns, page.beforeSeq, page.hasMore, sessionId);
    } catch (error) {
      console.warn("加载更早历史失败", error);
      store.setHistoryPageState({ historyLoading: false }, sessionId);
    }
  }, [historyBeforeSeq, historyHasMore, historyLoading, sessionId]);

  // If the session already has messages but pagination was never initialized
  // (e.g. history arrived via sendChat result rather than getChatHistoryPage),
  // fetch the page cursor once so "加载更早消息" can appear when needed.
  useEffect(() => {
    if (!isActive || historyLoading) return;
    if (history.length === 0) return;
    if (historyBeforeSeq != null || historyHasMore) return;
    if (pageInitSessionRef.current === sessionId) return;
    pageInitSessionRef.current = sessionId;
    let cancelled = false;
    void (async () => {
      try {
        const page = await window.owncoder.getChatHistoryPage(sessionId, undefined, 10);
        if (cancelled) {
          pageInitSessionRef.current = null;
          return;
        }
        const current = useChatStore.getState().bySession[sessionId];
        if (current?.historyBeforeSeq != null || current?.historyHasMore) return;
        useChatStore.getState().setHistoryPageState(
          {
            historyBeforeSeq: page.beforeSeq,
            historyHasMore: page.hasMore,
            historyLoading: false,
          },
          sessionId,
        );
      } catch (error) {
        pageInitSessionRef.current = null;
        console.warn("同步历史分页状态失败", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isActive, sessionId, history.length, historyBeforeSeq, historyHasMore, historyLoading]);

  const historyHeader = useMemo(() => {
    if (!historyHasMore && !historyLoading) return null;
    return (
      <div className="chat-history-load-more">
        <button
          type="button"
          className="chat-history-load-more-btn"
          onClick={() => void onLoadOlder()}
          disabled={historyLoading || !historyHasMore}
        >
          {historyLoading ? "加载中…" : "加载更早消息"}
        </button>
      </div>
    );
  }, [historyHasMore, historyLoading, onLoadOlder]);

  const onRemoveQueuedMessage = useCallback((index: number) => {
    removeMessage(sessionId, index);
  }, [sessionId]);

  return (
    <div className="session-chat-panel" style={isActive ? undefined : { display: "none" }}>
      {isEmpty ? (
        <div className="hero-empty">
          <div className="hero-watermark" aria-hidden>A</div>
          <h1>{greeting}</h1>
          <p className="hero-sub">
            向 OwnCoder 描述任务，@ 引用文件，/ 使用命令，切换 Plan / Agent 模式
          </p>
          {!llmConfigured ? (
            <ErrorBanner
              error={{ code: "AUTH_MISSING_KEY", message: "模型 API Key 尚未配置，请先完成设置后再开始对话。" }}
              onDismiss={() => useChatStore.getState().setErrorAlert(null, sessionId)}
              onOpenSettings={() => onOpenSettings("models")}
            />
          ) : errorAlert ? (
            <ErrorBanner
              error={errorAlert}
              onDismiss={() => useChatStore.getState().setErrorAlert(null, sessionId)}
              onOpenSettings={() => { onOpenSettings("models"); useChatStore.getState().setErrorAlert(null, sessionId); }}
            />
          ) : liveStatus ? (
            <p className="live-status hero-status">{liveStatus}</p>
          ) : null}
        </div>
          ) : (
        <>
          {errorAlert ? (
            <ErrorBanner
              error={errorAlert}
              onDismiss={() => useChatStore.getState().setErrorAlert(null, sessionId)}
              onOpenSettings={() => { onOpenSettings("models"); useChatStore.getState().setErrorAlert(null, sessionId); }}
            />
          ) : null}
          <ChatLog
            turns={visible}
            liveEvents={liveEvents}
            liveStatus={liveStatus}
            sending={sending}
            virtuosoRef={virtuosoRef}
            scrollerRef={scrollerRef}
            onRegenerate={() => void onRegenerate()}
            onOpenFile={onOpenFile}
            header={historyHeader}
            onStartReached={() => {
              if (historyHasMore && !historyLoading) void onLoadOlder();
            }}
          />
        </>
      )}


      {queuedMessages.length > 0 ? (
        <div className="queued-messages-bar">
          <span className="queued-messages-icon" aria-hidden>⏳</span>
          <span className="queued-messages-label">
            待执行 {queuedMessages.length} 条
          </span>
          <ol className="queued-messages-list">
            {queuedMessages.map((msg, i) => (
              <li key={`${msg}-${i}`} className="queued-messages-item">
                <span className="queued-messages-text">
                  {msg.length > 80 ? `${msg.slice(0, 80)}…` : msg}
                </span>
                <button
                  type="button"
                  className="queued-messages-send"
                  onClick={() => onSendQueuedMessage(i)}
                  disabled={sending}
                >
                  发送
                </button>
                <button
                  type="button"
                  className="queued-messages-remove"
                  onClick={() => onRemoveQueuedMessage(i)}
                  title="删除该待执行消息"
                >
                  删除
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}