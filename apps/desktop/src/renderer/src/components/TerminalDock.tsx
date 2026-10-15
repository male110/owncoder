import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalEntryDto } from "../../../preload/index";
import { useUiStore } from "../store/ui-store";
import { t } from "../../../shared/i18n/core";
import { useI18n } from "../i18n";

const TERMINAL_THEMES = {
  dark: { background: "#0d1014", foreground: "#d8dee9", cursor: "#6b9cc4" },
  // Light theme: darken default + ANSI whites so typed commands stay readable
  // on the warm canvas (shells often paint input with white/brightWhite).
  light: {
    background: "#ebe8e4",
    foreground: "#1a1917",
    cursor: "#2f4d5c",
    cursorAccent: "#ebe8e4",
    selectionBackground: "#c8d3d8",
    selectionForeground: "#1a1917",
    black: "#1a1917",
    red: "#a83333",
    green: "#2a5f45",
    yellow: "#7a5f14",
    blue: "#2a5578",
    magenta: "#6b2f6b",
    cyan: "#2a5f5f",
    white: "#4a4742",
    brightBlack: "#5c5852",
    brightRed: "#8f2c2c",
    brightGreen: "#1f4d38",
    brightYellow: "#6b5210",
    brightBlue: "#1e4668",
    brightMagenta: "#5a275a",
    brightCyan: "#1f5050",
    brightWhite: "#141312",
  },
} as const;

/** One live xterm view bound to a backend PTY. Kept mounted across tab switches. */
function XtermView({ active }: { active: boolean }) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const inputBufferRef = useRef("");
  const historyRef = useRef<string[]>([]);
  const suggestionRef = useRef("");
  const [suggestion, setSuggestion] = useState("");
  const [cursorCell, setCursorCell] = useState({ x: 0, y: 0 });
  const [ghostPosition, setGhostPosition] = useState<{
    left: number;
    top: number;
    lineHeight: number;
  } | null>(null);
  const uiTheme = useUiStore((s) => s.theme);

  const syncCursor = () => {
    const term = termRef.current;
    if (!term) return;
    setCursorCell({ x: term.buffer.active.cursorX, y: term.buffer.active.cursorY });
  };

  useEffect(() => {
    if (!suggestion) {
      setGhostPosition(null);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const shell = shellRef.current;
      const host = hostRef.current;
      const term = termRef.current;
      const screen = host?.querySelector<HTMLElement>(".xterm-screen");
      if (!shell || !screen || !term || term.cols <= 0 || term.rows <= 0) {
        setGhostPosition(null);
        return;
      }
      const shellRect = shell.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      if (screenRect.width <= 0 || screenRect.height <= 0) {
        setGhostPosition(null);
        return;
      }
      setGhostPosition({
        left: screenRect.left - shellRect.left + cursorCell.x * (screenRect.width / term.cols),
        top: screenRect.top - shellRect.top + cursorCell.y * (screenRect.height / term.rows),
        lineHeight: screenRect.height / term.rows,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, cursorCell, suggestion]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = TERMINAL_THEMES[uiTheme];
  }, [uiTheme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, Consolas, 'Cascadia Mono', monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: TERMINAL_THEMES[useUiStore.getState().theme],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      /* not visible yet */
    }

let disposed = false;

	    // Right-click: copy selection or paste clipboard (PowerShell-style)
	    const onContextMenu = (e: MouseEvent) => {
	      e.preventDefault();
	      if (!term || disposed) return;
	      const selection = term.getSelection();
	      if (selection) {
	        navigator.clipboard.writeText(selection).catch(() => {});
	        term.clearSelection();
	      } else {
	        navigator.clipboard.readText().then((text) => {
	          if (text && ptyIdRef.current) {
	            window.owncoder.writeTerminal(ptyIdRef.current, text);
	          }
	        }).catch(() => {});
	      }
	    };
	    host.addEventListener("contextmenu", onContextMenu);

	    const clearSuggestion = () => {
	      suggestionRef.current = "";
	      setSuggestion("");
	    };
    const refreshSuggestion = () => {
      const input = inputBufferRef.current;
      if (!input || /[\r\n]/.test(input)) {
        clearSuggestion();
        return;
      }
      const match = [...historyRef.current]
        .reverse()
        .find((command) => command.startsWith(input) && command.length > input.length);
      const next = match ? match.slice(input.length) : "";
      suggestionRef.current = next;
      setSuggestion(next);
    };
    const rememberCurrentCommand = () => {
      const command = inputBufferRef.current.trim();
      if (command) {
        historyRef.current = [
          ...historyRef.current.filter((entry) => entry !== command),
          command,
        ].slice(-100);
      }
      inputBufferRef.current = "";
      clearSuggestion();
    };
    const trackInput = (data: string) => {
      let buffer = inputBufferRef.current;
      for (const char of data) {
        if (char === "\r" || char === "\n") {
          inputBufferRef.current = buffer;
          rememberCurrentCommand();
          buffer = "";
          continue;
        }
        if (char === "\x7f" || char === "\b") {
          buffer = Array.from(buffer).slice(0, -1).join("");
          continue;
        }
        if (char === "\t" || char < " " || char === "\x7f") {
          inputBufferRef.current = "";
          clearSuggestion();
          return;
        }
        buffer += char;
      }
      inputBufferRef.current = buffer;
      refreshSuggestion();
    };

    const offData = window.owncoder.onTerminalData(({ id, data }) => {
      if (id === ptyIdRef.current) term.write(data, syncCursor);
    });
    const offExit = window.owncoder.onTerminalExit(({ id }) => {
      if (id === ptyIdRef.current) {
        clearSuggestion();
        inputBufferRef.current = "";
        term.write(`\r\n\x1b[90m${t("[进程已退出]")}\x1b[0m\r\n`, syncCursor);
      }
    });
    const onInput = term.onData((data) => {
      const currentSuggestion = suggestionRef.current;
      const acceptsSuggestion =
        currentSuggestion && (data === "\t" || data === "\x1b[C" || data === "\x1bOC");
      if (acceptsSuggestion) {
        if (ptyIdRef.current) {
          window.owncoder.writeTerminal(ptyIdRef.current, currentSuggestion);
          inputBufferRef.current += currentSuggestion;
          refreshSuggestion();
        }
        return;
      }
      if (ptyIdRef.current) window.owncoder.writeTerminal(ptyIdRef.current, data);
      trackInput(data);
      syncCursor();
    });

    void window.owncoder.createTerminal({ cols: term.cols, rows: term.rows }).then((id) => {
      if (disposed) {
        window.owncoder.killTerminal(id);
        return;
      }
      ptyIdRef.current = id;
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      if (ptyIdRef.current) window.owncoder.resizeTerminal(ptyIdRef.current, term.cols, term.rows);
      syncCursor();
    });
    ro.observe(host);

return () => {
	      disposed = true;
	      ro.disconnect();
	      offData();
	      offExit();
	      onInput.dispose();
	      host.removeEventListener("contextmenu", onContextMenu);
	      if (ptyIdRef.current) window.owncoder.killTerminal(ptyIdRef.current);
	      term.dispose();
	    };
  }, []);

  // Re-fit + focus when this tab becomes active (was possibly display:none before).
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      const term = termRef.current;
      if (term && ptyIdRef.current) window.owncoder.resizeTerminal(ptyIdRef.current, term.cols, term.rows);
      syncCursor();
      term?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [active]);

  return (
    <div className="xterm-shell" ref={shellRef}>
      <div className="xterm-host" ref={hostRef} />
      {suggestion && ghostPosition ? (
        <span
          className="terminal-ghost"
          aria-hidden="true"
          style={{
            left: ghostPosition.left,
            top: ghostPosition.top,
            lineHeight: `${ghostPosition.lineHeight}px`,
          }}
        >
          {suggestion}
        </span>
      ) : null}
    </div>
  );
}

interface Props {
  terminalLog: TerminalEntryDto[];
}

const AGENT_TAB = "agent";
const MIN_H = 140;
const MAX_H = 640;

export function TerminalDock({ terminalLog }: Props) {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(280);
  const [shellTabs, setShellTabs] = useState<number[]>([]);
  const [active, setActive] = useState<string>(AGENT_TAB);
  const seqRef = useRef(0);
  // map/filter 回调里 t 已是条目变量，取词函数用别名 tr。
  const { t: tr } = useI18n();
  const dockRef = useRef<HTMLDivElement | null>(null);

  const running = terminalLog.filter((t) => t.status === "running").length;
  const pending = terminalLog.filter((t) => t.status === "pending_confirm").length;
  const activeCount = running + pending;

  const addShell = () => {
    const key = ++seqRef.current;
    setShellTabs((prev) => [...prev, key]);
    setActive(String(key));
  };

  const closeShell = (key: number) => {
    setShellTabs((prev) => prev.filter((k) => k !== key));
    setActive((cur) => (cur === String(key) ? AGENT_TAB : cur));
  };

  // On first open, ensure there is at least one interactive shell.
  useEffect(() => {
    if (open && shellTabs.length === 0) {
      const key = ++seqRef.current;
      setShellTabs([key]);
      setActive(String(key));
    }
  }, [open, shellTabs.length]);

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(MAX_H, Math.max(MIN_H, startH + (startY - ev.clientY)));
      setHeight(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      ref={dockRef}
      className={open ? "terminal-dock open" : "terminal-dock closed"}
      style={open ? { height } : undefined}
    >
      {open ? (
        <>
          <div className="terminal-resize" onMouseDown={onResizeStart} title={tr("拖动调整高度")} />
          <div className="terminal-tabs">
            <div
              className={active === AGENT_TAB ? "terminal-tab agent active" : "terminal-tab agent"}
            >
              <button
                type="button"
                className="terminal-tab-main"
                onClick={() => setActive(AGENT_TAB)}
              >
                <span className="csb-icon">⚙</span>
                {tr("Agent 执行")}{activeCount ? ` (${activeCount})` : ""}
              </button>
            </div>
            {shellTabs.map((key, i) => (
              <div
                key={key}
                className={active === String(key) ? "terminal-tab active" : "terminal-tab"}
              >
                <button type="button" className="terminal-tab-main" onClick={() => setActive(String(key))}>
                  <span className="csb-icon">❯</span>
                  {tr("终端 {{n}}", { n: i + 1 })}
                </button>
                <button
                  type="button"
                  className="terminal-tab-close"
                  title={tr("关闭")}
                  onClick={() => closeShell(key)}
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="terminal-tab-add" title={tr("新建终端")} onClick={addShell}>
              ＋
            </button>
            <button
              type="button"
              className="terminal-collapse"
              title={tr("收起终端")}
              onClick={() => setOpen(false)}
            >
              ─
            </button>
          </div>
          <div className="terminal-panes">
            {shellTabs.map((key) => (
              <div
                key={key}
                className="terminal-pane"
                style={{ display: active === String(key) ? "block" : "none" }}
              >
                <XtermView active={active === String(key)} />
              </div>
            ))}
            <div
              className="terminal-pane agent-log"
              style={{ display: active === AGENT_TAB ? "block" : "none" }}
            >
              {terminalLog.length === 0 ? (
                <p className="hint context-empty">{tr("Agent 执行命令的输出会显示在这里")}</p>
              ) : (
                terminalLog.map((t) => (
                  <div key={t.id} className={`term-entry ${t.status}`}>
                    <div className="term-entry-head">
                      <pre className="term-cmd">$ {t.command}</pre>
                      {t.exitCode !== undefined ? (
                        <span className={`term-badge ${t.exitCode === 0 ? "ok" : "err"}`}>
                          exit {t.exitCode}
                        </span>
                      ) : t.status === "running" ? (
                        <span className="term-badge running">{tr("运行中")}</span>
                      ) : t.status === "pending_confirm" ? (
                        <span className="term-badge pending">{tr("等待确认")}</span>
                      ) : t.status === "denied" ? (
                        <span className="term-badge denied">{tr("已拒绝")}</span>
                      ) : null}
                    </div>
                    {t.stdout ? <pre className="term-out">{t.stdout}</pre> : null}
                    {t.stderr ? <pre className="term-err">{t.stderr}</pre> : null}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      ) : (
        <button type="button" className="terminal-statusbar" onClick={() => setOpen(true)}>
          <span className="csb-icon">❯</span>
          <span className="terminal-statusbar-label">{tr("终端")}</span>
          {pending ? (
            <span className="terminal-statusbar-run terminal-statusbar-pending">{tr("{{count}} 个命令等待确认", { count: pending })}</span>
          ) : running ? (
            <span className="terminal-statusbar-run">{tr("{{count}} 个命令运行中", { count: running })}</span>
          ) : null}
        </button>
      )}
    </div>
  );
}
