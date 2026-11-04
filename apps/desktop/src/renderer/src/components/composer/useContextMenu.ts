import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import type { CtxMenuState } from "./types";

export interface CtxMenuApi {
  ctxMenu: CtxMenuState | null;
  ctxMenuRef: RefObject<HTMLDivElement | null>;
  /** 输入框右键：在光标处附近打开菜单（尺寸近似值用于收进视口）。 */
  openCtxMenu: (e: ReactMouseEvent) => void;
  execCtxAction: (action: "cut" | "copy" | "paste" | "selectAll") => void;
}

/**
 * textarea 右键菜单（剪切 / 复制 / 粘贴 / 全选）。粘贴走剪贴板 API，
 * 与受控 draft 状态保持一致；失败时退回到 execCommand。
 */
export function useContextMenu(
  draft: string,
  onDraft: (v: string) => void,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): CtxMenuApi {
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onDown = (e: MouseEvent) => {
      if (!ctxMenuRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [ctxMenu]);

  // 菜单尺寸近似值，用于把菜单收进视口内
  const openCtxMenu = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    const el = textareaRef.current;
    const hasSelection = !!el && el.selectionStart !== el.selectionEnd;
    const menuW = 190;
    const menuH = 150;
    const x = Math.max(4, Math.min(e.clientX, window.innerWidth - menuW - 8));
    const y = Math.max(4, Math.min(e.clientY, window.innerHeight - menuH - 8));
    setCtxMenu({ x, y, hasSelection });
  }, [textareaRef]);

  const execCtxAction = useCallback(
    (action: "cut" | "copy" | "paste" | "selectAll") => {
      const el = textareaRef.current;
      if (!el) return;
      const start = el.selectionStart ?? draft.length;
      const end = el.selectionEnd ?? draft.length;
      if (action === "selectAll") {
        el.focus();
        el.setSelectionRange(0, draft.length);
      } else if (action === "copy" || action === "cut") {
        if (start === end) return;
        void navigator.clipboard.writeText(draft.slice(start, end)).catch(() => {});
        if (action === "cut") {
          const next = `${draft.slice(0, start)}${draft.slice(end)}`;
          onDraft(next);
          requestAnimationFrame(() => {
            el.focus();
            el.setSelectionRange(start, start);
          });
        }
      } else {
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (!text) return;
            const next = `${draft.slice(0, start)}${text}${draft.slice(end)}`;
            onDraft(next);
            const pos = start + text.length;
            requestAnimationFrame(() => {
              el.focus();
              el.setSelectionRange(pos, pos);
            });
          })
          .catch(() => {
            el.focus();
            el.setSelectionRange(start, end);
            document.execCommand("paste");
          });
      }
      setCtxMenu(null);
    },
    [draft, onDraft, textareaRef],
  );

  return { ctxMenu, ctxMenuRef, openCtxMenu, execCtxAction };
}
