import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatSessionMetaDto } from "../../../preload/index";

export type SearchResult =
  | { kind: "session"; id: string; title: string; subtitle: string }
  | { kind: "file"; path: string }
  | { kind: "action"; id: string; label: string; hint?: string };

interface Props {
  open: boolean;
  sessions: ChatSessionMetaDto[];
  workspaceName: string | null;
  onClose: () => void;
  onSelectSession: (id: string) => void | Promise<void>;
  onSelectFile: (path: string) => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
}

function matchScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 50;
  return 0;
}

export function CommandPalette({
  open,
  sessions,
  workspaceName,
  onClose,
  onSelectSession,
  onSelectFile,
  onNewSession,
  onOpenSettings,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const focusRafRef = useRef<number | null>(null);
  const [query, setQuery] = useState("");
  const [fileHits, setFileHits] = useState<string[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setFileHits([]);
      setIndex(0);
      return;
    }
    focusRafRef.current = requestAnimationFrame(() => {
      focusRafRef.current = null;
      inputRef.current?.focus();
    });
    return () => {
      if (focusRafRef.current !== null) {
        cancelAnimationFrame(focusRafRef.current);
        focusRafRef.current = null;
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setFileHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.owncoder.searchWorkspaceFiles(q).then((hits) => {
        if (!cancelled) setFileHits(hits);
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query]);

  const results = useMemo((): SearchResult[] => {
    const q = query.trim();
    const out: SearchResult[] = [];

    if (!q) {
      out.push({ kind: "action", id: "new", label: "新建对话", hint: "Ctrl+N" });
      out.push({ kind: "action", id: "settings", label: "打开设置" });
    }

    for (const s of sessions) {
      const score = matchScore(s.title, q);
      if (score > 0 || !q) {
        out.push({
          kind: "session",
          id: s.id,
          title: s.title,
          subtitle: s.pinned ? "已固定" : workspaceName ?? "会话",
        });
      }
    }

    for (const path of fileHits) {
      out.push({ kind: "file", path });
    }

    if (q && out.length === 0) {
      return [];
    }

    if (q) {
      return out.sort((a, b) => {
        const scoreA =
          a.kind === "session"
            ? matchScore(a.title, q)
            : a.kind === "file"
              ? matchScore(a.path, q)
              : matchScore(a.label, q);
        const scoreB =
          b.kind === "session"
            ? matchScore(b.title, q)
            : b.kind === "file"
              ? matchScore(b.path, q)
              : matchScore(b.label, q);
        return scoreB - scoreA;
      });
    }

    return out.slice(0, 16);
  }, [query, sessions, fileHits, workspaceName]);

  useEffect(() => {
    setIndex(0);
  }, [query, fileHits.length]);

  const pick = useCallback(
    (item: SearchResult) => {
      if (item.kind === "session") onSelectSession(item.id);
      else if (item.kind === "file") onSelectFile(item.path);
      else if (item.id === "new") onNewSession();
      else if (item.id === "settings") onOpenSettings();
      onClose();
    },
    [onClose, onNewSession, onOpenSettings, onSelectFile, onSelectSession],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && results[index]) {
        e.preventDefault();
        pick(results[index]!);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, results, index, pick, onClose]);

  if (!open) return null;

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className="palette-input-wrap">
          <span className="palette-search-icon" aria-hidden>
            ⌕
          </span>
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            placeholder="搜索会话、文件或操作…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="palette-kbd">Esc</kbd>
        </div>
        <ul className="palette-results" role="listbox">
          {results.length === 0 ? (
            <li className="palette-empty">无匹配结果</li>
          ) : (
            results.map((item, i) => {
              const selected = i === index;
              if (item.kind === "session") {
                return (
                  <li key={`s-${item.id}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={selected ? "palette-item selected" : "palette-item"}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => pick(item)}
                    >
                      <span className="palette-item-icon">💬</span>
                      <span className="palette-item-body">
                        <strong>{item.title}</strong>
                        <small>{item.subtitle}</small>
                      </span>
                    </button>
                  </li>
                );
              }
              if (item.kind === "file") {
                return (
                  <li key={`f-${item.path}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={selected ? "palette-item selected" : "palette-item"}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => pick(item)}
                    >
                      <span className="palette-item-icon">📄</span>
                      <span className="palette-item-body">
                        <strong className="mono">{item.path}</strong>
                        <small>引用到输入框</small>
                      </span>
                    </button>
                  </li>
                );
              }
              return (
                <li key={`a-${item.id}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={selected ? "palette-item selected" : "palette-item"}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => pick(item)}
                  >
                    <span className="palette-item-icon">⚡</span>
                    <span className="palette-item-body">
                      <strong>{item.label}</strong>
                      {item.hint ? <small>{item.hint}</small> : null}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
