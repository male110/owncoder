import { useCallback, useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

export interface MentionApi {
  /** @ 提及浮层是否激活（有查询词且有候选结果）。 */
  isOpen: boolean;
  mentionHits: string[];
  mentionIndex: number;
  /** 输入框内容或光标变化时同步提及状态。 */
  syncMention: (value: string, cursor: number) => void;
  /** 把命中路径作为 @path 令牌插入输入框。 */
  insertMention: (path: string) => void;
  /** 提及浮层打开时处理键盘导航；返回 true 表示已消费事件。 */
  handleKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * textarea 中的 @ 提及：监听光标前的 @query，命中工作区文件列表，
 * Tab / 回车插入 @path 令牌。
 */
export function useMention(draft: string, onDraft: (v: string) => void, textareaRef: RefObject<HTMLTextAreaElement | null>): MentionApi {
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(0);
  const [mentionHits, setMentionHits] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  useEffect(() => {
    if (mentionQuery === null) {
      setMentionHits([]);
      return;
    }
    let cancelled = false;
    void window.owncoder.searchWorkspaceFiles(mentionQuery).then((hits) => {
      if (!cancelled) {
        setMentionHits(hits);
        setMentionIndex(0);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [mentionQuery]);

  const syncMention = useCallback((value: string, cursor: number) => {
    const before = value.slice(0, cursor);
    const match = before.match(/@([^\s@]*)$/);
    if (match) {
      setMentionQuery(match[1] ?? "");
      setMentionStart(cursor - match[0].length);
    } else {
      setMentionQuery(null);
    }
  }, []);

  const insertMention = useCallback(
    (path: string) => {
      const el = textareaRef.current;
      const cursor = el?.selectionStart ?? draft.length;
      const token = `@${path} `;
      const next = `${draft.slice(0, mentionStart)}${token}${draft.slice(cursor)}`;
      onDraft(next);
      setMentionQuery(null);
      requestAnimationFrame(() => {
        const pos = mentionStart + token.length;
        el?.focus();
        el?.setSelectionRange(pos, pos);
      });
    },
    [draft, mentionStart, onDraft, textareaRef],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (mentionQuery === null || mentionHits.length === 0) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, mentionHits.length - 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        insertMention(mentionHits[mentionIndex]!);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return true;
      }
      return false;
    },
    [mentionQuery, mentionHits, mentionIndex, insertMention],
  );

  return {
    isOpen: mentionQuery !== null && mentionHits.length > 0,
    mentionHits,
    mentionIndex,
    syncMention,
    insertMention,
    handleKeyDown,
  };
}
