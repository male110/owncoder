import { useMemo, useState, useEffect, useRef, useCallback, memo } from "react";
import { Virtuoso } from "react-virtuoso";
import type { VirtuosoHandle } from "react-virtuoso";
import type { ChatTurnDto } from "../../../preload/index";
import { Markdown } from "./Markdown";
import type { DecompositionSnapshot, LiveEvent, PendingTool } from "../store/chat-store";
import { useI18n } from "../i18n";
import {
  buildChatItems,
  buildLogBlocks,
  deriveLiveStatus,
  lastAssistantBlockIndex,
  toolLabel,
  toolStatusLabel as toolStatusLabelFromModel,
  type ChatItem,
  type LogBlock,
} from "./chat-log-model";



/** Re-export with the original `export function` shape for existing importers. */
export function toolStatusLabel(
  phase: "running" | "done" | "error",
  name?: string,
  args?: Record<string, unknown>,
): string {
  return toolStatusLabelFromModel(phase, name, args);
}


const PLAN_MARKER = "\n\n<!--plan_saved:";

function extractPlanPath(content: string): string | null {
  const idx = content.lastIndexOf(PLAN_MARKER);
  if (idx < 0) return null;
  const rest = content.slice(idx + PLAN_MARKER.length);
  const endIdx = rest.indexOf("-->");
  if (endIdx < 0) return null;
  return rest.slice(0, endIdx).trim();
}

function stripPlanMarker(content: string): string {
  const idx = content.lastIndexOf(PLAN_MARKER);
  if (idx < 0) return content;
  return content.slice(0, idx).trimEnd();
}

// ── Arg summary for tool cards ────────────────────────────────────────────────

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const pick = (k: string) => (typeof args[k] === "string" ? String(args[k]) : undefined);
  if (name === "read_file" || name === "write_file" || name === "list_dir" || name === "apply_patch") {
    const p = pick("path") ?? pick("filePath") ?? "";
    // Show only the last 2 path segments to keep it compact
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.slice(-2).join("/");
  }
  if (name === "bash") return (pick("command") ?? pick("cmd") ?? "").slice(0, 80);
  if (name === "search_code" || name === "search_symbols" || name === "grep") return pick("query") ?? pick("pattern") ?? "";
  const first = Object.values(args).find((v) => typeof v === "string");
  return first ? String(first) : "";
}

/** Read params for read_file: Limit and Offset */
function readFileParams(args: Record<string, unknown>): string {
  const limit  = args.limit  != null ? `Limit:${args.limit}`  : null;
  const offset = args.offset != null ? `Offset:${args.offset}` : null;
  if (limit || offset) return [limit, offset].filter(Boolean).join(" | ");
  return "";
}

// ── Diff stat helper (for write/patch results) ────────────────────────────────

function parseDiffStat(output: string): { added: number; removed: number } | null {
  // Output format from write_file / apply_patch: "Wrote path (+N -M)"
  const m = output.match(/\(\+(\d+)\s+-(\d+)\)/);
  if (m) return { added: Number(m[1]), removed: Number(m[2]) };
  // Count raw +/- lines if full diff is emitted
  let added = 0; let removed = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return added + removed > 0 ? { added, removed } : null;
}

// ── LiveToolCard (current turn) ───────────────────────────────────────────────

function LiveToolCardImpl({ tool }: { tool: PendingTool }) {
  const running   = tool.status === "running";
  const [open, setOpen] = useState(false);  // collapsed by default; expand on click
  const bodyRef   = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(running);
  const { t } = useI18n();

  // Auto-expand while running so user sees progress
  useEffect(() => { if (running) setOpen(true); }, [running]);

  // Auto-collapse when done
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false);
    wasRunning.current = running;
  }, [running]);

  useEffect(() => {
    if (open && tool.output && bodyRef.current) {
      requestAnimationFrame(() => { bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight); });
    }
  }, [tool.output, open]);

  const isWrite = tool.name === "write_file" || tool.name === "apply_patch";
  const isRead  = tool.name === "read_file";
  const isBash  = tool.name === "bash";
  const diff    = isWrite && tool.output ? parseDiffStat(tool.output) : null;
  const argSummary = summarizeArgs(tool.name, tool.args);
  const readParams = isRead ? readFileParams(tool.args) : "";

  return (
    <div className={`tool-card live ${running ? "running" : tool.status}`}>
      <button type="button" className="tool-card-head" onClick={() => setOpen((v) => !v)}>

        {/* Icon */}
        <span className="tool-card-icon">
          {running
            ? <span className="tool-spinner" />
            : tool.status === "error" ? "✕"
            : tool.status === "skipped" ? "–"
            : isWrite ? "✏" : isBash ? "▶" : "⚙"}
        </span>

        {/* Tool name + arg summary */}
        <span className="tool-card-label">
          {isRead
            ? <><span className="tool-verb">Read</span>{" "}<span className="tool-path">{argSummary}</span>{readParams ? <span className="tool-read-params">{readParams}</span> : null}</>
            : isWrite
            ? <><span className="tool-verb">{tool.name === "apply_patch" ? "Edit" : "Write"}</span>{" "}<span className="tool-path">{argSummary}</span></>
            : isBash
            ? <><span className="tool-verb">Run</span>{" "}<span className="tool-path">{argSummary}</span></>
            : <>{toolLabel(tool.name)}{argSummary ? <span className="tool-path"> {argSummary}</span> : null}</>
          }
        </span>

        {/* Diff stat for write/patch */}
        {!running && diff ? (
          <span className="tool-diff-stat">
            <span className="diff-added">+{diff.added}</span>
            {" "}
            <span className="diff-removed">-{diff.removed}</span>
          </span>
        ) : null}

        {/* Status badge */}
        <span className={`tool-status ${running ? "running" : tool.status}`}>
          {running ? t("运行中") : tool.status === "error" ? t("失败") : tool.status === "skipped" ? t("已跳过") : t("完成")}
        </span>

        <span className="activity-chev">{open ? "▾" : "▸"}</span>
      </button>

      {open && (tool.output || running) ? (
        <div className="tool-card-body" ref={bodyRef}>
          {tool.output ? (
            <div className="tool-card-content-wrap">
              <div className="tool-card-result-label">{t("结果")}</div>
              <pre>{tool.output}</pre>
              <button
                type="button"
                className="tool-card-copy-btn"
                onClick={() => {
                  navigator.clipboard.writeText(tool.output || "");
                }}
                title={t("复制内容")}
              >
                {t("📋 复制")}
              </button>
            </div>
          ) : null}
          {running && !tool.output ? <div className="tool-progress">{t("执行中...")}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

// ── ThinkingBlock ─────────────────────────────────────────────────────────────

function ThinkingBlockImpl({ content, streaming }: { content: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
  const { t } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);
  const wasStreaming = useRef(streaming);

  useEffect(() => { if (streaming) setOpen(true); }, [streaming]);

  useEffect(() => {
    if (wasStreaming.current && !streaming) setOpen(false);
    wasStreaming.current = streaming;
  }, [streaming]);

  useEffect(() => {
    if (open && streaming && bodyRef.current) {
      requestAnimationFrame(() => { bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight); });
    }
  }, [content, open, streaming]);

  if (!content) return null;

  return (
    <div className={`thinking-block ${streaming ? "streaming" : ""}`}>
      <button type="button" className="thinking-head" onClick={() => setOpen((v) => !v)}>
        <span className="thinking-icon">⊗</span>
        <span className="thinking-label">{streaming ? t("思考中…") : t("思考过程")}</span>
        <span className="activity-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="thinking-body" ref={bodyRef}>
          <Markdown content={content} showCopy={false} />
          {streaming ? <span className="stream-cursor" /> : null}
        </div>
      ) : null}
    </div>
  );
}

// ── LiveEventStream: renders liveEvents[] in order ───────────────────────────

function LiveEventStreamImpl({ events }: { events: LiveEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="live-event-stream">
      {events.map((ev) => {
        if (ev.kind === "thinking") {
          return (
            <ThinkingBlock
              key={ev.id}
              content={ev.text}
              streaming={ev.streaming}
            />
          );
        }
        if (ev.kind === "tool") {
          return <LiveToolCard key={`tool-${ev.tool.id}`} tool={ev.tool} />;
        }
        // decompose events are rendered by ChatLog inside the current-turn
        // assistant container, before the live event stream; skip here.
        if (ev.kind === "decompose") return null;
        // text (must narrow the union — ev may be "structured" which has no .text)
        if (ev.kind !== "text") return null;
        if (!ev.text) return null;
        return (
          <div key={ev.id} className={`msg assistant${ev.streaming ? " streaming" : ""}`}>
            <Markdown content={ev.text} />
            {ev.streaming ? <span className="stream-cursor" /> : null}
          </div>
        );
      })}
    </div>
  );
}

// ── DecomposeCard: task_decompose result (intent + tasks) ────────────────────
// 仅在 pnpm dev（import.meta.env.DEV）时由 ChatLog footer 渲染。

function DecomposeCard({ decomposition }: { decomposition: DecompositionSnapshot }) {
  const [open, setOpen] = useState(true);
  const { t } = useI18n();
  const { intent, userConstraints, tasks, fallback } = decomposition;
  const taskCount = tasks.length;

  const title = fallback
    ? t("任务分解（本地回退）")
    : taskCount === 0
      ? t("任务分解：无需计划")
      : t("任务分解：{{count}} 个任务", { count: taskCount });

  return (
    <div className={`decompose-card${fallback ? " fallback" : ""}`}>
      <button type="button" className="decompose-head" onClick={() => setOpen((v) => !v)}>
        <span className="decompose-icon">🗂</span>
        <span className="decompose-title">{title}</span>
        <span className="activity-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="decompose-body">
          {intent ? (
            <div className="decompose-section">
              <div className="decompose-section-label">{t("意图")}</div>
              <div className="decompose-intent">{intent}</div>
            </div>
          ) : null}
          {userConstraints.length > 0 ? (
            <div className="decompose-section">
              <div className="decompose-section-label">{t("用户约束")}</div>
              <ul className="decompose-constraints">
                {userConstraints.map((c, i) => (
                  <li key={`${c}-${i}`}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {tasks.length > 0 ? (
            <div className="decompose-section">
              <div className="decompose-section-label">{t("任务")}</div>
              {tasks.map((task) => (
                <div key={task.id} className="decompose-task">
                  <div className="decompose-task-head">
                    <span className="decompose-step-id">{task.id}</span>
                    {task.description ? (
                      <span className="decompose-step-desc">{task.description}</span>
                    ) : null}
                  </div>
                  <ol className="decompose-steps">
                    {task.steps.map((s) => (
                      <li key={s.id} className="decompose-step">
                        <div className="decompose-step-head">
                          <span className="decompose-step-id">{s.id}</span>
                          <span className="decompose-step-desc">{s.description}</span>
                          {s.dependsOn.length > 0 ? (
                            <span className="decompose-step-deps" title={t("依赖的前序步骤")}>
                              ⇦ {s.dependsOn.join(", ")}
                            </span>
                          ) : null}
                        </div>
                        {s.informationNeeds.length > 0 ? (
                          <ul className="decompose-needs">
                            {s.informationNeeds.map((need) => (
                              <li key={need.id}>
                                <span className="decompose-need-id">{need.id}</span>
                                {need.question}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {s.stopReadingWhen.length > 0 ? (
                          <div className="decompose-stop">
                            {t("停读条件：")}{s.stopReadingWhen.map((c) => c.condition).join("；")}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          ) : (
            <div className="decompose-empty">
              {t("本次请求未产生计划步骤（琐碎任务 / 提问 / 交还用户）。")}
            </div>
          )}
          {fallback ? (
            <div className="decompose-fallback-note">
              {t("分解调用失败，以上为本地启发式回退结果，仅供粗略参考。")}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Bubbles ───────────────────────────────────────────────────────────────────

function UserBubbleImpl({ turn }: { turn: ChatTurnDto }) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();

  const isCompressed = turn.isCompressed === true;
  const compressionRatio = turn.originalLength && turn.content.length
    ? Math.round((turn.content.length / turn.originalLength) * 100)
    : null;
  const hasImportantSnippets = turn.importantSnippets && turn.importantSnippets.length > 0;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(turn.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className={`msg user ${isCompressed ? "compressed" : ""}`}>
      <div className="user-bubble-wrap">
        <div className="msg-bubble">
          <Markdown content={turn.content} />
          {isCompressed && (
            <div className="compression-indicator">
              <span className="compression-icon" title={t("已压缩内容")}>🗜️</span>
              {compressionRatio && (
                <span className="compression-ratio">{t("压缩{{percent}}%", { percent: compressionRatio })}</span>
              )}
              {hasImportantSnippets && (
                <div className="important-snippets-tooltip">
                  <strong>{t("保留的重要片段：")}</strong>
                  <ul>
                    {turn.importantSnippets!.slice(0, 3).map((snippet, i) => (
                      <li key={`${snippet}-${i}`}>{snippet}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="msg-actions">
          <button type="button" className="msg-action-btn" onClick={() => void onCopy()} title={t("复制")}>
            {copied ? t("已复制") : t("复制")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanCard({ planPath, onOpen }: { planPath: string; onOpen: (path: string) => void }) {
  const fileName = planPath.split("/").pop() ?? planPath;
  const { t } = useI18n();
  return (
    <div className="plan-card">
      <div className="plan-card-icon">📋</div>
      <div className="plan-card-body">
        <div className="plan-card-title">{t("已生成计划")}</div>
        <div className="plan-card-filename">{fileName}</div>
        <div className="plan-card-path">{planPath}</div>
      </div>
      <button type="button" className="plan-card-open" onClick={() => onOpen(planPath)} title={t("在编辑器中打开")}>
        {t("打开 →")}
      </button>
    </div>
  );
}

function AssistantBubbleImpl({
  turn,
  canRegenerate,
  regenerating,
  onRegenerate,
  onOpenFile,
}: {
  turn: ChatTurnDto;
  canRegenerate: boolean;
  regenerating: boolean;
  onRegenerate?: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const planPath      = extractPlanPath(turn.content);
  const displayContent = planPath ? stripPlanMarker(turn.content) : turn.content;

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
      <Markdown content={displayContent} />
      {planPath ? <PlanCard planPath={planPath} onOpen={(p) => onOpenFile?.(p)} /> : null}
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
        {isCompressed && (
          <span className="compression-badge" title={t("已压缩内容")}>
            {t("🗜️ 压缩")}
          </span>
        )}
      </div>
    </div>
  );
}


const LiveToolCard = memo(LiveToolCardImpl, (prev, next) =>
  prev.tool === next.tool ||
  (prev.tool.id === next.tool.id &&
    prev.tool.status === next.tool.status &&
    prev.tool.output === next.tool.output &&
    prev.tool.name === next.tool.name)
);

const UserBubble = memo(UserBubbleImpl, (prev, next) =>
  prev.turn === next.turn ||
  (prev.turn.id === next.turn.id &&
    prev.turn.content === next.turn.content &&
    prev.turn.isCompressed === next.turn.isCompressed &&
    prev.turn.originalLength === next.turn.originalLength)
);

const ThinkingBlock = memo(ThinkingBlockImpl, (prev, next) =>
  prev.content === next.content && prev.streaming === next.streaming
);

const LiveEventStream = memo(LiveEventStreamImpl, (prev, next) => prev.events === next.events);

const AssistantBubble = memo(AssistantBubbleImpl, (prev, next) =>
  (prev.turn === next.turn ||
    (prev.turn.id === next.turn.id &&
      prev.turn.content === next.turn.content &&
      prev.turn.isCompressed === next.turn.isCompressed &&
      prev.turn.originalLength === next.turn.originalLength)) &&
  prev.canRegenerate === next.canRegenerate &&
  prev.regenerating === next.regenerating &&
  prev.onRegenerate === next.onRegenerate &&
  prev.onOpenFile === next.onOpenFile
);

// ── ProcessSteps: 已完成轮次的过程步骤（工具链 + 中间过程文本）折叠控件 ──────

function ProcessStepsImpl({ items }: { items: ChatTurnDto[] }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <div className="process-block">
      <button type="button" className="process-head" onClick={() => setOpen((v) => !v)}>
        <span className="process-icon">⚙</span>
        <span className="process-title">{t("执行过程 · {{count}} 步", { count: items.length })}</span>
        <span className="activity-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="process-body">
          {items.map((it, idx) => {
            const key = it.id ?? `p-${idx}`;
            if (it.role === "tool") {
              const failed = it.content.startsWith("Error:");
              const argSummary = it.toolName ? summarizeArgs(it.toolName, it.toolArgs ?? {}) : "";
              return (
                <div key={key} className="process-step">
                  <span className={`tool-status ${failed ? "error" : "done"}`}>
                    {toolStatusLabelFromModel(failed ? "error" : "done", it.toolName, it.toolArgs)}
                  </span>
                  {argSummary ? <span className="process-step-arg">{argSummary}</span> : null}
                </div>
              );
            }
            return (
              <div key={key} className="process-step-text">
                <Markdown content={it.content} showCopy={false} />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

const ProcessSteps = memo(ProcessStepsImpl, (prev, next) => prev.items === next.items);

// ── ChatLog ───────────────────────────────────────────────────────────────────

interface Props {
  turns: ChatTurnDto[];
  liveEvents: LiveEvent[];
  liveStatus: string;
  sending: boolean;
  virtuosoRef?: React.RefObject<VirtuosoHandle | null>;
  onRegenerate?: () => void;
  onOpenFile?: (path: string) => void;
  /** Rendered above the first message inside the scroll viewport. */
  header?: React.ReactNode;
  onStartReached?: () => void;
  /** Ref to the underlying scroll container (footer-aware bottom scrolling). */
  scrollerRef?: React.RefObject<HTMLElement | null>;
}

export function ChatLog({
  turns,
  liveEvents,
  liveStatus,
  sending,
  virtuosoRef,
  onRegenerate,
  onOpenFile,
  header,
  onStartReached,
  scrollerRef,
}: Props) {
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

  // Decomposition cards belong to the current turn and only show in pnpm dev.
  // They must render BEFORE the in-progress assistant reply so the plan is
  // visible ahead of the LLM response.
  const decompositionCards = useMemo(
    () =>
      import.meta.env.DEV
        ? liveEvents.filter((e): e is Extract<LiveEvent, { kind: "decompose" }> => e.kind === "decompose")
        : [],
    [liveEvents],
  );
  const nonDecomposeLiveEvents = useMemo(
    () => liveEvents.filter((e) => e.kind !== "decompose"),
    [liveEvents],
  );
  const showLiveFooter =
    Boolean(derivedStatus) ||
    decompositionCards.length > 0 ||
    nonDecomposeLiveEvents.length > 0;

  const renderBlock = useCallback((b: LogBlock, i: number) => {
    if (b.kind === "user") return <UserBubble turn={b.turn} />;
    if (b.kind === "assistant") {
      return (
        <AssistantBubble
          turn={b.turn}
          canRegenerate={i === lastAssistantIdx && !sending && liveEvents.length === 0}
          regenerating={sending}
          onRegenerate={onRegenerate}
          onOpenFile={onOpenFile}
        />
      );
    }
    // 已完成轮次的过程步骤 → 可展开的折叠控件（默认收起）。
    if (b.kind === "process") return <ProcessSteps items={b.items} />;
    // 进行中轮次的工具链由 LiveToolCard / liveStatus 展示，不在列表里重复。
    return null;
  }, [lastAssistantIdx, sending, liveEvents.length, onRegenerate, onOpenFile]);

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
  useEffect(() => {
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
    // Virtuoso + customScrollParent 首屏量高常超过 800ms；超时后若仍未贴底，
    // 不能把 flag 置 true，否则 ResizeObserver 无法继续纠正，切换会话会停在顶部。
    const MAX_FRAMES = 90;

    const readBottomState = (el: HTMLElement) => {
      const overflow = el.scrollHeight > el.clientHeight + AT_BOTTOM_THRESHOLD;
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD;
      return { overflow, atBottom };
    };

    const markSettledIfReady = (el: HTMLElement, heightStable: boolean) => {
      const { overflow, atBottom } = readBottomState(el);
      // 量高完成前 scrollHeight≈clientHeight，不能当成已经在底部。
      // 短会话始终无 overflow：等若干帧高度稳定后再允许 settle。
      const readyToSettle =
        atBottom && heightStable && (overflow || attempts >= 12);
      settledFrames = readyToSettle ? settledFrames + 1 : 0;
      if (settledFrames >= 3) {
        initialBottomAppliedRef.current = true;
        return true;
      }
      return false;
    };

    const pin = () => {
      if (cancelled || userTookOver) return;
      scrollToTrueBottom();
      atBottomRef.current = true;
      attempts += 1;
      const el = scrollerElRef.current;
      if (!el) {
        frame = requestAnimationFrame(pin);
        return;
      }
      const heightStable = el.scrollHeight === lastHeight;
      lastHeight = el.scrollHeight;
      if (markSettledIfReady(el, heightStable)) return;
      if (attempts >= MAX_FRAMES) {
        // 停止 rAF 空转；只有确实贴底才锁定，否则留给 ResizeObserver 继续钉。
        const { atBottom } = readBottomState(el);
        if (atBottom && heightStable) initialBottomAppliedRef.current = true;
        return;
      }
      frame = requestAnimationFrame(pin);
    };
    frame = requestAnimationFrame(pin);

    const ro = new ResizeObserver(() => {
      if (cancelled || userTookOver || initialBottomAppliedRef.current) return;
      scrollToTrueBottom();
      atBottomRef.current = true;
      const el = scrollerElRef.current;
      if (!el) return;
      // 布局抖动结束后补一次 settle，避免 MAX_FRAMES 放弃后永远停在顶部
      lastHeight = el.scrollHeight;
      markSettledIfReady(el, true);
    });
    ro.observe(scrollParent);
    const inner = scrollParent.firstElementChild;
    if (inner) ro.observe(inner);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      scrollParent.removeEventListener("wheel", onWheel);
      scrollParent.removeEventListener("touchstart", onTouchStart);
      scrollParent.removeEventListener("touchmove", onTouchMove);
      scrollParent.removeEventListener("keydown", onKeyDown);
    };
  }, [hasContent, scrollParent, scrollToTrueBottom]);

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

  return (
    <div className="chat-log wide">
      <div
        className="chat-log-scroller"
        ref={bindScroller}
        onScroll={syncAtBottom}
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
                      <DecomposeCard key={ev.id} decomposition={ev.decomposition} />
                    ))}
                  </div>
                ) : null}
                <LiveEventStream events={nonDecomposeLiveEvents} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
