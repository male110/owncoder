import { useRef } from "react";
import type { AgentMode } from "@owncoder/shared";
import { useI18n } from "../../i18n";
import { useMenuDismiss } from "./useMenuDismiss";

interface ModePickerProps {
  mode: AgentMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMode: (mode: AgentMode) => void;
}

/** Spec / Agent 模式选择菜单；打开状态由父组件（App）控制。 */
export function ModePicker({ mode, open, onOpenChange, onMode }: ModePickerProps) {
  const { t } = useI18n();
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  useMenuDismiss(open, modeMenuRef, () => onOpenChange(false));

  return (
    <div className="mode-picker" ref={modeMenuRef}>
      <button
        type="button"
        className="mode-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span className="mode-icon" aria-hidden>
          {mode === "spec" ? "📋" : "∞"}
        </span>
        {mode === "spec" ? "Spec" : "Agent"}
        <span className="mode-chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <ul className="mode-menu" role="listbox">
          <li>
            <button
              type="button"
              role="option"
              aria-selected={mode === "agent"}
              className={mode === "agent" ? "selected" : ""}
              onClick={() => onMode("agent")}
            >
              <span className="mode-icon" aria-hidden>
                ∞
              </span>
              <span className="mode-meta">
                <strong>Agent</strong>
                <small>{t("可写 · 改代码与跑命令")}</small>
              </span>
              {mode === "agent" ? <span className="mode-check">✓</span> : null}
            </button>
          </li>
          <li>
            <button
              type="button"
              role="option"
              aria-selected={mode === "spec"}
              className={mode === "spec" ? "selected" : ""}
              onClick={() => onMode("spec")}
            >
              <span className="mode-icon" aria-hidden>
                ☰
              </span>
              <span className="mode-meta">
                <strong>Spec</strong>
                <small>{t("只读 · 需求与设计")}</small>
              </span>
              {mode === "spec" ? <span className="mode-check">✓</span> : null}
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
