import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n";
import type { CompletionMenuState } from "./completion-controller";

export interface CompletionAnchor {
  left: number;
  top: number;
  lineHeight: number;
  width: number;
  height: number;
}

export function completionMenuPosition(anchor: CompletionAnchor) {
  const below = Math.max(0, anchor.height - anchor.top - anchor.lineHeight - 4);
  const above = Math.max(0, anchor.top - 4);
  const placeAbove = below < 130 && above > below;
  const maxHeight = Math.min(234, placeAbove ? above : below);
  return {
    left: Math.max(4, Math.min(anchor.left, Math.max(4, anchor.width - 364))),
    top: placeAbove ? Math.max(0, anchor.height - anchor.top + 2) : anchor.top + anchor.lineHeight + 2,
    above: placeAbove,
    maxHeight,
    maxWidth: Math.max(0, anchor.width - 8),
  };
}

export function TerminalCompletionMenu({ menu, anchor, onAccept }: {
  menu: CompletionMenuState;
  anchor: CompletionAnchor;
  onAccept: (index: number) => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const position = completionMenuPosition(anchor);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [menu.selected]);
  if (position.maxHeight < 36) return null;

  return (
    <div
      className="terminal-completions"
      style={{
        left: position.left,
        ...(position.above ? { bottom: position.top } : { top: position.top }),
        maxHeight: position.maxHeight,
        maxWidth: position.maxWidth,
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div ref={listRef} role="listbox" aria-label={t("终端补全")} className="terminal-completion-list">
        {menu.result.items.map((item, index) => (
          <div
            key={`${item.kind}:${item.label}:${index}`}
            role="option"
            aria-selected={menu.selected === index}
            className="terminal-completion-item"
            onMouseDown={(event) => {
              if (event.button === 0) onAccept(index);
            }}
          >
            <span className="terminal-completion-kind" aria-hidden="true">
              {item.kind === "branch" ? "⑂" : item.kind === "directory" ? "/" : item.kind === "file" ? "·" : "❯"}
            </span>
            <span className="terminal-completion-label" title={item.label}>{item.label}</span>
            {item.detail ? <span className="terminal-completion-detail" title={item.detail}>{item.detail}</span> : null}
          </div>
        ))}
      </div>
      <div className="terminal-completion-help">{t("↑↓ 选择 · Tab / Enter 补全 · Esc 关闭")}</div>
    </div>
  );
}
