import { useMemo, useRef, useEffect, useCallback } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { useChatStore } from "../store/chat-store";
import type { ChatSessionRuntime } from "../store/chat-store";
import { removeMessage } from "../hooks/queue-controller";
import type { TabId } from "../SettingsPanel";
import { ChatLog } from "./ChatLog";
import { ErrorBanner } from "./ErrorBanner";
import { useI18n } from "../i18n";


interface Props {
  sessionId: string;
  isActive: boolean;
  llmConfigured: boolean;
  onRegenerate: () => void;
  onOpenFile: (path: string) => void;
  workspaceRoot?: string;
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
  currentStage: null,
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
  workspaceRoot,
  onOpenSettings,
  onSendQueuedMessage,
}: Props) {
  const { t } = useI18n();
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 6) return t("夜深了");
    if (h < 12) return t("早上好呀");
    if (h < 14) return t("中午好");
    if (h < 18) return t("下午好");
    if (h < 22) return t("晚上好呀，今天辛苦啦");
    return t("夜深了，注意休息");
  }, [t]);

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
          {historyLoading ? t("加载中…") : t("加载更早消息")}
        </button>
      </div>
    );
  }, [historyHasMore, historyLoading, onLoadOlder]);

  const onRemoveQueuedMessage = useCallback((index: number) => {
    removeMessage(sessionId, index);
  }, [sessionId]);

  const onDeleteTurn = useCallback((turnId: string) => {
    void window.owncoder.deleteChatTurn(turnId, sessionId).then((ok) => {
      if (ok) useChatStore.getState().removeTurnFromHistory(turnId, sessionId);
    });
  }, [sessionId]);

  return (
    <div className="session-chat-panel" style={isActive ? undefined : { display: "none" }}>
      {isEmpty ? (
        <div className="hero-empty">
          <div className="hero-watermark" aria-hidden>A</div>
          <h1>{greeting}</h1>
          <p className="hero-sub">
            {t("向 OwnCoder 描述任务，@ 引用文件，/ 使用命令，切换 Plan / Agent 模式")}
          </p>
          {!llmConfigured ? (
            <ErrorBanner
              error={{ code: "AUTH_MISSING_KEY", message: t("模型 API Key 尚未配置，请先完成设置后再开始对话。") }}
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
            onRegenerate={() => void onRegenerate()}
            onDeleteTurn={onDeleteTurn}
            onOpenFile={onOpenFile}
            workspaceRoot={workspaceRoot}
            header={historyHeader}
            onStartReached={() => {
              if (historyHasMore && !historyLoading) void onLoadOlder();
            }}
            active={isActive}
          />
        </>
      )}


      {queuedMessages.length > 0 ? (
        <div className="queued-messages-bar">
          <span className="queued-messages-icon" aria-hidden>⏳</span>
          <span className="queued-messages-label">
            {t("待执行 {{count}} 条", { count: queuedMessages.length })}
          </span>
          <ol className="queued-messages-list">
            {queuedMessages.map((msg, i) => {
              const label = msg.text.trim()
                || (msg.attachments?.length ? msg.attachments.map((a) => a.name).join(", ") : "");
              const preview = label.length > 80 ? `${label.slice(0, 80)}…` : label;
              return (
              <li key={`${msg.text}-${i}-${msg.attachments?.map((a) => a.url).join("|") ?? ""}`} className="queued-messages-item">
                <span className="queued-messages-text">
                  {preview || "（附件）"}
                </span>
                <button
                  type="button"
                  className="queued-messages-send"
                  onClick={() => onSendQueuedMessage(i)}
                  disabled={sending}
                >
                  {t("发送")}
                </button>
                <button
                  type="button"
                  className="queued-messages-remove"
                  onClick={() => onRemoveQueuedMessage(i)}
                  title={t("删除该待执行消息")}
                >
                  {t("删除")}
                </button>
              </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </div>
  );
}