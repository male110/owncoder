import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * 输入框 textarea 的通用行为：
 * - 内容或窗口尺寸变化时自动调整高度（72–240px，超出部分滚动）；
 * - 活跃会话切换（新建 / 删除 / 切换）后重新聚焦。
 *
 * 聚焦依赖 activeSessionId 而非一次性 window 事件：effect 运行时 React 已提交
 * 更新 draft 与会话列表的那次渲染，textarea 是当前实例，可直接 focus。
 */
export function useComposerTextarea(activeSessionId: string | null, draft: string) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    // 先清除旧高度再读取 scrollHeight，确保删除内容后也能回缩。
    el.style.height = "auto";
    const minHeight = 72;
    const maxHeight = 240;
    const nextHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    autoResizeTextarea();
    window.addEventListener("resize", autoResizeTextarea);
    return () => window.removeEventListener("resize", autoResizeTextarea);
  }, [autoResizeTextarea, draft]);

  const didMountRef = useRef(false);
  const prevSessionIdRef = useRef<string | null>(activeSessionId);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      prevSessionIdRef.current = activeSessionId;
      return;
    }
    if (prevSessionIdRef.current === activeSessionId) return;
    prevSessionIdRef.current = activeSessionId;

    // Focus immediately, then again on the next frame in case a later store
    // update re-renders and displaces focus.
    textareaRef.current?.focus();
    const raf = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [activeSessionId]);

  return textareaRef;
}
