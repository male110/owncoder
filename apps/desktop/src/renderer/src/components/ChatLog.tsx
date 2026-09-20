import { useMemo, useState, useEffect, useRef, useCallback, memo } from "react";
import { Virtuoso } from "react-virtuoso";
import type { VirtuosoHandle } from "react-virtuoso";
import type { ChatTurnDto } from "../../../preload/index";
import { Markdown } from "./Markdown";
import type { DecompositionSnapshot, LiveEvent, PendingTool } from "../store/chat-store";
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

// ── ToolCard (history) ────────────────────────────────────────────────────────

function parseBashOutput(content: string): { cmd?: string; body: string; exitCode?: number } {
  const exitMatch   = content.match(/^exit\s+(-?\d+)/m);
  // Strip optional "stdout:" / "stderr:" labels so the displayed body is the raw content.
  const labeledBody = content
    .replace(/^stdout:\s*\n?/m, "")
    .replace(/^stderr:\s*\n?/gm, "");
  const cmdFromContent = content.match(/^([^\n]+)/)?.[1];
  return {
    cmd: cmdFromContent && !cmdFromContent.startsWith("exit") ? cmdFromContent : undefined,
    body: labeledBody.trim(),
    exitCode: exitMatch ? Number(exitMatch[1]) : undefined,
  };
}

function ToolCardImpl({ turn }: { turn: ChatTurnDto }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const isBash    = turn.toolName === "bash";
  const bash      = isBash ? parseBashOutput(turn.content) : null;
  const isError   = turn.content.trim().startsWith("Error:");
  const bashFailed = isBash && bash?.exitCode !== undefined && bash.exitCode !== 0;
  const failed    = isError || bashFailed;
  const bashOk    = isBash && bash?.exitCode === 0;
  const preview   = turn.content.length > 60 ? `${turn.content.slice(0, 60)}…` : turn.content;
  const bodyRef   = useRef<HTMLPreElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollFrameRef = useRef<number | null>(null);

  // 压缩相关信息
  const isCompressed = turn.isCompressed === true;
  const compressionRatio = turn.originalLength && turn.content.length
    ? Math.round((turn.content.length / turn.originalLength) * 100)
    : null;
  const hasImportantSnippets = turn.importantSnippets && turn.importantSnippets.length > 0;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(turn.content);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1500);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (open && bodyRef.current) {
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
      });
    }

    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [open, turn.content]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current);
    }
  }, []);

  return (
    <div className={`tool-card ${failed ? "err" : bashOk ? "ok" : ""} ${isCompressed ? "compressed" : ""}`}>
      <button type="button" className="tool-card-head" onClick={() => setOpen((v) => !v)}>
        <span className={`tool-card-icon ${failed ? "err" : bashOk ? "ok" : ""} ${isCompressed ? "compressed" : ""}`}>
          {isCompressed ? "🗜️" : isBash ? "▶" : failed ? "✕" : "⚙"}
        </span>
        <span className="tool-card-label">
          {toolLabel(turn.toolName)}
          {isCompressed && (
            <span className="compression-badge" title="已压缩内容">
              🗜️
            </span>
          )}
        </span>
        {isBash && bash?.exitCode !== undefined ? (
          <span className={`tool-exit ${bash.exitCode === 0 ? "ok" : "err"}`}>exit {bash.exitCode}</span>
        ) : (
          <span className={`tool-status ${failed ? "error" : "done"}`}>
            {failed ? "失败" : isCompressed ? `压缩${compressionRatio ? ` ${compressionRatio}%` : ''}` : "完成"}
          </span>
        )}
        <span className="tool-card-preview">
          {bash?.cmd ?? preview}
          {isCompressed && turn.originalLength && (
            <span className="compression-info">
              ({turn.content.length}/{turn.originalLength}字符)
            </span>
          )}
        </span>
        <span className="activity-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-card-body">
          {isCompressed && (
            <div className="compression-header">
              <div className="compression-stats">
                <strong>压缩信息：</strong>
                {turn.compressionReason && (
                  <span className="reason">原因：{
                    turn.compressionReason === 'context_limit' ? '上下文限制' :
                    turn.compressionReason === 'manual' ? '手动压缩' :
                    turn.compressionReason === 'auto' ? '自动压缩' :
                    turn.compressionReason === 'disk_save' ? '磁盘保存' :
                    turn.compressionReason === 'retained' ? '完整保留' : turn.compressionReason
                  }</span>
                )}
                {turn.originalLength && (
                  <span className="ratio">压缩率：{compressionRatio}% ({turn.content.length}/{turn.originalLength}字符)</span>
                )}
                {turn.compressedAt && (
                  <span className="time">时间：{new Date(turn.compressedAt).toLocaleString()}</span>
                )}
              </div>
              {hasImportantSnippets && (
                <div className="important-snippets">
                  <strong>保留的重要片段：</strong>
                  <ul>
                    {turn.importantSnippets!.map((snippet, i) => (
                      <li key={i} title={snippet}>{snippet}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <div className="tool-card-content-wrap">
            <pre ref={bodyRef}>{turn.content}</pre>
            <button
              type="button"
              className="tool-card-copy-btn"
              onClick={() => void onCopy()}
              title="复制内容"
            >
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          {isCompressed && turn.originalLength && turn.originalLength > turn.content.length && (
            <div className="compression-footer">
              <em>提示：此内容已压缩。原始内容为{turn.originalLength}字符，压缩后为{turn.content.length}字符。</em>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── LiveToolCard (current turn) ───────────────────────────────────────────────

function LiveToolCardImpl({ tool }: { tool: PendingTool }) {
  const running   = tool.status === "running";
  const [open, setOpen] = useState(false);  // collapsed by default; expand on click
  const bodyRef   = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(running);

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
          {running ? "运行中" : tool.status === "error" ? "失败" : tool.status === "skipped" ? "已跳过" : "完成"}
        </span>

        <span className="activity-chev">{open ? "▾" : "▸"}</span>
      </button>

      {open && (tool.output || running) ? (
        <div className="tool-card-body" ref={bodyRef}>
          {tool.output ? (
            <div className="tool-card-content-wrap">
              <div className="tool-card-result-label">结果</div>
              <pre>{tool.output}</pre>
              <button
                type="button"
                className="tool-card-copy-btn"
                onClick={() => {
                  navigator.clipboard.writeText(tool.output || "");
                }}
                title="复制内容"
              >
                📋 复制
              </button>
            </div>
          ) : null}
          {running && !tool.output ? <div className="tool-progress">执行中...</div> : null}
        </div>
      ) : null}
    </div>
  );
}

// ── ThinkingBlock ─────────────────────────────────────────────────────────────

function ThinkingBlockImpl({ content, streaming }: { content: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
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
        <span className="thinking-label">{streaming ? "思考中…" : "思考过程"}</span>
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

// ── DecomposeCard: task_decompose result (understanding + steps) ─────────────

function DecomposeCard({ decomposition }: { decomposition: DecompositionSnapshot }) {
  const [open, setOpen] = useState(true);
  const { understanding, userConstraints, steps, fallback } = decomposition;
  const stepCount = steps.length;

  const title = fallback
    ? "任务分解（本地回退）"
    : stepCount === 0
      ? "任务分解：无需计划"
      : `任务分解：${stepCount} 个步骤`;

  return (
    <div className={`decompose-card${fallback ? " fallback" : ""}`}>
      <button type="button" className="decompose-head" onClick={() => setOpen((v) => !v)}>
        <span className="decompose-icon">🗂</span>
        <span className="decompose-title">{title}</span>
        <span className="activity-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="decompose-body">
          {understanding ? (
            <div className="decompose-section">
              <div className="decompose-section-label">理解</div>
              <div className="decompose-understanding">{understanding}</div>
            </div>
          ) : null}
          {userConstraints.length > 0 ? (
            <div className="decompose-section">
              <div className="decompose-section-label">用户约束</div>
              <ul className="decompose-constraints">
                {userConstraints.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {stepCount > 0 ? (
            <div className="decompose-section">
              <div className="decompose-section-label">步骤</div>
              <ol className="decompose-steps">
                {steps.map((s) => (
                  <li key={s.id} className="decompose-step">
                    <div className="decompose-step-head">
                      <span className="decompose-step-id">{s.id}</span>
                      <span className="decompose-step-desc">{s.description}</span>
                      {s.dependsOn.length > 0 ? (
                        <span className="decompose-step-deps" title="依赖的前序步骤">
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
                        停读条件：{s.stopReadingWhen.map((c) => c.condition).join("；")}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className="decompose-empty">
              本次请求未产生计划步骤（琐碎任务 / 提问 / 交还用户）。
            </div>
          )}
          {fallback ? (
            <div className="decompose-fallback-note">
              分解调用失败，以上为本地启发式回退结果，仅供粗略参考。
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}



// ── History: ActivityGroup ────────────────────────────────────────────────────

function ActivityGroup({ items }: { items: ChatTurnDto[] }) {
  const [open, setOpen] = useState(false);
  const failCount = items.filter((t) => t.content.trim().startsWith("Error:")).length;
  const summary   = items.map((t) => toolLabel(t.toolName)).join(" · ");


  if (items.length === 1) return <ToolCard turn={items[0]!} />;

  return (
    <div className="activity-group">
      <button type="button" className="activity-group-head" onClick={() => setOpen((v) => !v)}>
        <span className={`activity-dot ${failCount > 0 ? "err" : ""}`} />
        <span className="activity-group-title">
          {open
            ? "隐藏步骤"
            : `已执行 ${items.length} 个步骤${failCount > 0 ? `（${failCount} 失败）` : ""}`}
        </span>
        <span className="activity-chev">{open ? "▾" : "▸"}</span>
      </button>
      {!open ? <p className="activity-group-summary">{summary}</p> : null}
      {open ? (
        <div className="activity-group-body">
          {items.map((t, j) => (
            <ToolCard key={t.id ?? `${t.toolName ?? "tool"}-${j}`} turn={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Completed-round process trace (collapsed by default) ─────────────────────

function RoundProcess({ items }: { items: ChatTurnDto[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="activity-group">
      <button type="button" className="activity-group-head" onClick={() => setOpen((v) => !v)}>
        <span className="activity-dot" />
        <span className="activity-group-title">
          {open ? "收起执行过程" : `执行过程 · ${items.length} 步`}
        </span>
        <span className="activity-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="activity-group-body">
          {items.map((t, j) =>
            t.role === "tool" ? (
              <ToolCard key={t.id ?? `pt-${t.toolName ?? "tool"}-${j}`} turn={t} />
            ) : (
              <div key={t.id ?? `pn-${j}-${t.content.slice(0, 24)}`} className="process-note">
                <Markdown content={t.content} />
              </div>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Bubbles ───────────────────────────────────────────────────────────────────

function UserBubbleImpl({ turn }: { turn: ChatTurnDto }) {
  const [copied, setCopied] = useState(false);

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
              <span className="compression-icon" title="已压缩内容">🗜️</span>
              {compressionRatio && (
                <span className="compression-ratio">压缩{compressionRatio}%</span>
              )}
              {hasImportantSnippets && (
                <div className="important-snippets-tooltip">
                  <strong>保留的重要片段：</strong>
                  <ul>
                    {turn.importantSnippets!.slice(0, 3).map((snippet, i) => (
                      <li key={i}>{snippet}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="msg-actions">
          <button type="button" className="msg-action-btn" onClick={() => void onCopy()} title="复制">
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanCard({ planPath, onOpen }: { planPath: string; onOpen: (path: string) => void }) {
  const fileName = planPath.split("/").pop() ?? planPath;
  return (
    <div className="plan-card">
      <div className="plan-card-icon">📋</div>
      <div className="plan-card-body">
        <div className="plan-card-title">已生成计划</div>
        <div className="plan-card-filename">{fileName}</div>
        <div className="plan-card-path">{planPath}</div>
      </div>
      <button type="button" className="plan-card-open" onClick={() => onOpen(planPath)} title="在编辑器中打开">
        打开 →
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
            <strong>压缩信息：</strong>
            {turn.compressionReason && (
              <span className="reason">原因：{
                turn.compressionReason === 'context_limit' ? '上下文限制' :
                turn.compressionReason === 'manual' ? '手动压缩' :
                turn.compressionReason === 'auto' ? '自动压缩' :
                turn.compressionReason === 'disk_save' ? '磁盘保存' :
                turn.compressionReason === 'retained' ? '完整保留' : turn.compressionReason
              }</span>
            )}
            {turn.originalLength && (
              <span className="ratio">压缩率：{compressionRatio}% ({turn.content.length}/{turn.originalLength}字符)</span>
            )}
            {turn.compressedAt && (
              <span className="time">时间：{new Date(turn.compressedAt).toLocaleString()}</span>
            )}
          </div>
          {hasImportantSnippets && (
            <div className="important-snippets">
              <strong>保留的重要片段：</strong>
              <ul>
                {turn.importantSnippets!.map((snippet, i) => (
                  <li key={i} title={snippet}>{snippet}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <Markdown content={displayContent} />
      {planPath ? <PlanCard planPath={planPath} onOpen={(p) => onOpenFile?.(p)} /> : null}
      <div className="msg-actions">
        <button type="button" className="msg-action-btn" onClick={() => void onCopy()} title="复制">
          {copied ? "已复制" : "复制"}
        </button>
        {canRegenerate && onRegenerate ? (
          <button
            type="button"
            className="msg-action-btn"
            disabled={regenerating}
            onClick={onRegenerate}
            title="重新生成"
          >
            {regenerating ? "生成中…" : "重新生成"}
          </button>
        ) : null}
        {isCompressed && (
          <span className="compression-badge" title="已压缩内容">
            🗜️ 压缩
          </span>
        )}
      </div>
    </div>
  );
}


const ToolCard = memo(ToolCardImpl, (prev, next) =>
  prev.turn === next.turn ||
  (prev.turn.id === next.turn.id &&
    prev.turn.content === next.turn.content &&
    prev.turn.toolName === next.turn.toolName &&
    prev.turn.isCompressed === next.turn.isCompressed &&
    prev.turn.originalLength === next.turn.originalLength)
);

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

  // Decomposition cards belong to the current turn. They must render BEFORE
  // the in-progress assistant reply (the live event stream) so the user sees
  // the decomposition plan ahead of the LLM's response, not after it.
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
    return b.kind === "tools"
      ? <ActivityGroup items={b.items} />
      : <RoundProcess items={b.items} />;
  }, [lastAssistantIdx, sending, liveEvents.length, onRegenerate, onOpenFile]);

  // History rows only — live status/stream render after Virtuoso inside the
  // shared scroller so streaming updates don't depend on Footer remounts.
  const items = useMemo(() => buildChatItems(blocks), [blocks]);

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
    if (items.length === 0 && liveEvents.length === 0 && !sending) return;
    if (!scrollParent) return;

    let cancelled = false;
    let attempts = 0;
    let settledFrames = 0;
    let lastHeight = 0;
    let frame = 0;
    const MAX_FRAMES = 48;

    const pin = () => {
      if (cancelled) return;
      scrollToTrueBottom();
      atBottomRef.current = true;
      attempts += 1;
      const el = scrollerElRef.current;
      if (!el) {
        frame = requestAnimationFrame(pin);
        return;
      }
      const overflow = el.scrollHeight > el.clientHeight + AT_BOTTOM_THRESHOLD;
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD;
      const heightStable = el.scrollHeight === lastHeight;
      lastHeight = el.scrollHeight;
      // 量高完成前 scrollHeight≈clientHeight，不能当成已经在底部
      settledFrames = overflow && atBottom && heightStable ? settledFrames + 1 : 0;
      if (settledFrames >= 3 || attempts >= MAX_FRAMES) {
        initialBottomAppliedRef.current = true;
        return;
      }
      frame = requestAnimationFrame(pin);
    };
    frame = requestAnimationFrame(pin);

    const ro = new ResizeObserver(() => {
      if (cancelled || initialBottomAppliedRef.current) return;
      scrollToTrueBottom();
      atBottomRef.current = true;
    });
    ro.observe(scrollParent);
    const inner = scrollParent.firstElementChild;
    if (inner) ro.observe(inner);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [items.length, liveEvents.length, sending, scrollParent, scrollToTrueBottom]);

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
