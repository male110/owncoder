import { useEffect, type RefObject } from "react";

/**
 * 浮层菜单的通用关闭逻辑：打开期间点击菜单外部关闭；Escape 可选
 * （工作区菜单不响应 Escape，与拆分前行为一致）。
 */
export function useMenuDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { escape?: boolean } = {},
): void {
  const { escape = true } = options;
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    if (escape) document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      if (escape) document.removeEventListener("keydown", onKey);
    };
  }, [open, ref, onClose, escape]);
}
