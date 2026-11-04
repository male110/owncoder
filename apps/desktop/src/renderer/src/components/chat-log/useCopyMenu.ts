import { useCallback, useEffect, useRef, useState } from "react";

export interface CopyMenuState {
  x: number;
  y: number;
  text: string;
}

export interface CopyMenuApi {
  copyMenu: CopyMenuState | null;
  copyMenuRef: React.RefObject<HTMLDivElement | null>;
  /** 右键处理：仅当选中文本时弹出「复制」菜单，无选区则抑制默认菜单。 */
  handleContextMenu: (e: React.MouseEvent) => void;
  handleCopy: () => void;
}

// ── LLM 输出区域自定义右键菜单（仅含「复制」） ───────────────────────────────

export function useCopyMenu(): CopyMenuApi {
  const [copyMenu, setCopyMenu] = useState<CopyMenuState | null>(null);
  const copyMenuRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  // 右键菜单处理：仅当选中文本时弹出「复制」菜单，无选区则抑制默认菜单且不弹菜单
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const sel = window.getSelection();
    const text = sel?.toString() ?? "";
    if (!sel || sel.isCollapsed || !text) {
      // 无选中文本：抑制默认右键菜单，不弹出任何菜单
      setCopyMenu(null);
      return;
    }
    const menuW = 130;
    const menuH = 40;
    const x = Math.max(4, Math.min(e.clientX, window.innerWidth - menuW - 8));
    const y = Math.max(4, Math.min(e.clientY, window.innerHeight - menuH - 8));
    setCopyMenu({ x, y, text });
  }, []);

  const closeCopyMenu = useCallback(() => setCopyMenu(null), []);

  const handleCopy = useCallback(() => {
    const text = copyMenu?.text ?? "";
    if (text) void navigator.clipboard.writeText(text).catch(() => {});
    closeCopyMenu();
  }, [copyMenu, closeCopyMenu]);

  // 点击菜单外部区域关闭
  useEffect(() => {
    if (!copyMenu) return;
    const onDocClick = (e: MouseEvent) => {
      if (copyMenuRef.current && !copyMenuRef.current.contains(e.target as Node)) closeCopyMenu();
    };
    document.addEventListener("mousedown", onDocClick, true);
    return () => document.removeEventListener("mousedown", onDocClick, true);
  }, [copyMenu, closeCopyMenu]);

  // 按 Esc 键关闭
  useEffect(() => {
    if (!copyMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCopyMenu();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [copyMenu, closeCopyMenu]);

  // 选区变化时自动关闭菜单（拖动改变选区、点击其他位置等）
  useEffect(() => {
    if (!copyMenu) return;
    const onSelChange = () => {
      // 延迟执行，避免在刚选中文字触发 contextmenu 时 selectionchange 立即清除菜单
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) closeCopyMenu();
      }, 0);
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      document.removeEventListener("selectionchange", onSelChange);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    };
  }, [copyMenu, closeCopyMenu]);

  return { copyMenu, copyMenuRef, handleContextMenu, handleCopy };
}
