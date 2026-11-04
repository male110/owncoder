import { useState, useEffect, useRef, memo } from "react";
import type { PendingTool } from "../../store/chat-store";
import { useI18n } from "../../i18n";
import { parseDiffStat, formatToolArgs, summarizeArgs, readFileParams } from "./tool-card-utils";

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
          <span className="tool-verb">{tool.name}</span>
          {argSummary ? <span className="tool-path"> {argSummary}</span> : null}
          {isRead && readParams ? <span className="tool-read-params">{readParams}</span> : null}
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

      {open && (tool.output || running || Object.keys(tool.args).length > 0) ? (
        <div className="tool-card-body" ref={bodyRef}>
          {Object.keys(tool.args).length > 0 ? (
            <div className="tool-card-content-wrap">
              <div className="tool-card-result-label">参数</div>
              <pre>{formatToolArgs(tool.args)}</pre>
            </div>
          ) : null}
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
        </div>
      ) : null}
    </div>
  );
}

export const LiveToolCard = memo(LiveToolCardImpl, (prev, next) =>
  prev.tool === next.tool ||
  (prev.tool.id === next.tool.id &&
    prev.tool.status === next.tool.status &&
    prev.tool.output === next.tool.output &&
    prev.tool.name === next.tool.name)
);
