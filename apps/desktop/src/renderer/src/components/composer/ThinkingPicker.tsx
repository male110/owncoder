import { useRef } from "react";
import type { ThinkingEffort } from "@owncoder/settings";
import { useI18n } from "../../i18n";
import { useMenuDismiss } from "./useMenuDismiss";

interface ThinkingPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  effort: ThinkingEffort;
  onSelect: (effort: ThinkingEffort) => void;
  /** decomposer=任务分解思考强度；react=循环执行思考强度 */
  variant: "decomposer" | "react";
  /** 分解模型指示图标 📋（仅分阶段模式） */
  stageIndicator?: boolean;
}

/** 思考强度选择菜单（低 / 中 / 高）。 */
export function ThinkingPicker({ open, onOpenChange, effort, onSelect, variant, stageIndicator = false }: ThinkingPickerProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  useMenuDismiss(open, menuRef, () => onOpenChange(false));

  const options: Array<{ value: ThinkingEffort; label: string }> = [
    { value: "high", label: t("高强度") },
    { value: "medium", label: t("中强度") },
    { value: "low", label: t("低强度") },
  ];
  const chipTitle =
    variant === "react" ? t("循环执行思考强度") : stageIndicator ? "任务分解思考强度" : t("思考强度");

  return (
    <div className={`thinking-picker${variant === "react" ? " thinking-picker-react" : ""}`} ref={menuRef}>
      <button
        type="button"
        className={`thinking-chip${variant === "react" ? " thinking-chip-react" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        title={chipTitle}
      >
        <span className="thinking-icon">{stageIndicator ? "📋" : "💭"}</span>
        {effort === "low" ? t("低") : effort === "medium" ? t("中") : t("高")}
        <span className="mode-chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <ul className="thinking-menu" role="listbox">
          {options.map((opt) => (
            <li key={opt.value}>
              <button
                type="button"
                role="option"
                aria-selected={effort === opt.value}
                className={effort === opt.value ? "selected" : ""}
                onClick={() => {
                  onOpenChange(false);
                  onSelect(opt.value);
                }}
              >
                <span className="thinking-menu-name">{opt.label}</span>
                {effort === opt.value ? <span className="mode-check">✓</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
