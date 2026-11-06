import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AvailableModel } from "@owncoder/settings";
import { useI18n } from "../../i18n";
import { useMenuDismiss } from "./useMenuDismiss";
import type { ModelGroup } from "./useGroupedModels";

interface ModelPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupedModels: ModelGroup[];
  availableModels: AvailableModel[];
  /** chip 上展示的模型名 */
  label: string;
  /** decomposer=任务分解模型；react=循环执行模型 */
  variant: "decomposer" | "react";
  /** 分解模型指示图标 📋（仅分阶段模式） */
  stageIndicator?: boolean;
  /** 菜单打开时预选的平台；默认第一个平台。循环执行模型传入当前 reactProviderId。 */
  initialProviderId?: string | null;
  isSelected: (model: AvailableModel) => boolean;
  onSelect: (model: AvailableModel) => void;
  onOpenSettings: () => void;
}

/**
 * 模型选择浮层：左侧平台列表（含设置入口）+ 右侧模型列表（独立滚动）。
 * 浮层以当前平台项的中心定位，并在窗口边缘限制位置。
 */
export function ModelPicker({
  open,
  onOpenChange,
  groupedModels,
  availableModels,
  label,
  variant,
  stageIndicator = false,
  initialProviderId,
  isSelected,
  onSelect,
  onOpenSettings,
}: ModelPickerProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  useMenuDismiss(open, menuRef, () => onOpenChange(false));

  // 展开时直接显示第一个平台（或预选平台）的模型，避免模型仅在悬停平台后才出现。
  useEffect(() => {
    if (!open) return;
    setSelectedProviderId(initialProviderId ?? groupedModels[0]?.providerId ?? null);
  }, [open, groupedModels, initialProviderId]);

  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current?.querySelector<HTMLElement>(".model-menu");
    const body = menuRef.current?.querySelector<HTMLElement>(".model-menu-body");
    const list = body?.querySelector<HTMLElement>(".model-menu-providers-list");
    const models = body?.querySelector<HTMLElement>(".model-menu-models");
    if (!menu || !body || !list || !models) return;
    const updatePosition = () => {
      const pickerRect = menuRef.current?.getBoundingClientRect();
      if (!pickerRect) return;
      const gap = 6;
      const margin = 8;
      if (document.documentElement.dataset.theme === "light") {
        const menuWidth = 140 + models.offsetWidth;
        menu.style.left = `${Math.max(margin - pickerRect.left, Math.min(0, window.innerWidth - margin - pickerRect.left - menuWidth))}px`;
      } else {
        menu.style.left = "";
      }
      const spaceAbove = Math.max(0, pickerRect.top - gap - margin);
      const spaceBelow = Math.max(0, window.innerHeight - pickerRect.bottom - gap - margin);
      const downward = spaceBelow > spaceAbove;
      const availableHeight = downward ? spaceBelow : spaceAbove;
      menu.style.top = downward ? "calc(100% + 6px)" : "auto";
      menu.style.bottom = downward ? "auto" : "calc(100% + 6px)";
      // 模型列表保持在输入框上方（或下方）的可用空间内，超出部分滚动。
      models.style.maxHeight = `${Math.min(300, availableHeight)}px`;
      const settings = body.querySelector<HTMLElement>(".model-menu-settings");
      list.style.maxHeight = `${Math.max(0, Math.min(300, availableHeight - (settings?.offsetHeight ?? 0) - 2))}px`;
      const active = list.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!active) return;
      const bodyTop = body.getBoundingClientRect().top;
      const activeRect = active.getBoundingClientRect();
      const center = activeRect.top - bodyTop + activeRect.height / 2;
      const desiredTop = center - models.getBoundingClientRect().height / 2;
      const minTop = (downward ? pickerRect.bottom + gap : margin) - bodyTop;
      const maxTop = (downward ? window.innerHeight - margin : pickerRect.top - gap) - bodyTop - models.offsetHeight;
      models.style.top = `${Math.max(minTop, Math.min(desiredTop, maxTop))}px`;
    };
    models.scrollTop = 0;
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(body);
    observer.observe(models);
    list.addEventListener("scroll", updatePosition);
    window.addEventListener("resize", updatePosition);
    menuRef.current?.addEventListener("animationend", updatePosition);
    const menuEl = menuRef.current;
    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", updatePosition);
      window.removeEventListener("resize", updatePosition);
      menuEl?.removeEventListener("animationend", updatePosition);
    };
  }, [open, selectedProviderId, groupedModels]);

  const pickerClassName = `model-picker${variant === "react" ? " model-picker-react" : ""}${stageIndicator ? " model-picker-decomposer" : ""}`;
  // chip 自身不再带颜色左边框：颜色由外层 .model-group 的圆弧边框统一呈现。
  const chipClassName = "model-chip";
  const chipTitle =
    variant === "react" ? t("循环执行模型") : stageIndicator ? "任务分解模型" : t("切换模型");

  return (
    <div className={pickerClassName} ref={menuRef}>
      <button
        type="button"
        className={chipClassName}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        title={chipTitle}
      >
        <span className="model-chip-label">{label}</span>
        <span className="mode-chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div className="model-menu" role="listbox">
          {availableModels.length === 0 ? (
            <div className="model-menu-empty">
              <span>{t("暂无可用模型")}</span>
              <button
                type="button"
                className="model-menu-settings"
                onClick={() => {
                  onOpenChange(false);
                  onOpenSettings();
                }}
              >
                {t("去设置")}
              </button>
            </div>
          ) : (
            <>
              {/* 平台列含设置入口，模型浮层独立滚动。 */}
              <div className="model-menu-body">
                <nav className="model-menu-providers" role="tablist" aria-label={t("模型平台")}>
                  <div className="model-menu-providers-list">
                    {groupedModels.map((group) => (
                      <button
                        key={group.providerId}
                        type="button"
                        role="tab"
                        aria-selected={selectedProviderId === group.providerId}
                        className={`model-menu-provider-item ${selectedProviderId === group.providerId ? "active" : ""}`}
                        onMouseEnter={() => setSelectedProviderId(group.providerId)}
                        onFocus={() => setSelectedProviderId(group.providerId)}
                        onClick={() => setSelectedProviderId(group.providerId)}
                      >
                        <span className="model-menu-provider-label">
                          {group.providerName}
                          <span className="model-menu-provider-count">{group.models.length}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="model-menu-settings"
                    onClick={() => {
                      onOpenChange(false);
                      onOpenSettings();
                    }}
                  >
                    {t("⚙ 模型设置…")}
                  </button>
                </nav>
                <ul className="model-menu-models" role="group">
                  {(groupedModels.find((g) => g.providerId === selectedProviderId)?.models ?? []).map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected(m)}
                        className={`${isSelected(m) ? "selected" : ""} ${
                          (groupedModels.find((g) => g.providerId === selectedProviderId)?.models.length ?? 0) === 1
                            ? "single-model"
                            : ""
                        }`}
                        onClick={() => {
                          onOpenChange(false);
                          setSelectedProviderId(null);
                          onSelect(m);
                        }}
                      >
                        <span className="model-menu-name">{m.name}</span>
                        {isSelected(m) ? <span className="mode-check">✓</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
