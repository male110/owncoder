import { useEffect, useMemo, useState } from "react";
import {
  MODEL_CATEGORIES,
  groupModelsBySeries,
  modelCategory,
  modelDisplayName,
  type ListedModel,
  type ModelCategory,
} from "@owncoder/settings";
import { useI18n } from "../i18n";
import type { MsgId } from "../../../shared/i18n/core";
import { fuzzyMatchModel } from "./model-match";

/** 分类页签：所有 + 各能力分类（按当前模型集合过滤掉空分类）。 */
type CategoryTab = "all" | ModelCategory;

/**
 * 「获取所有模型」结果弹窗：按能力分类浏览 + 模糊搜索 + 按模型系列分组，
 * 每个候选模型通过 + 添加到已接入列表（已加入项显示 −，点击即移除）。
 */
export function ModelBrowserModal({
  providerName,
  models,
  addedIds,
  onAdd,
  onRemove,
  onClose,
}: {
  providerName: string;
  models: ListedModel[];
  /** 已接入（selectedModels）中该平台的模型标识集合（含 id 与请求用的 name）。 */
  addedIds: Set<string>;
  onAdd: (model: ListedModel) => void;
  onRemove: (model: ListedModel) => void;
  onClose: () => void;
}) {
  const { t: tr } = useI18n();
  const [category, setCategory] = useState<CategoryTab>("all");
  const [query, setQuery] = useState("");
  /** 已折叠分组的 key 集合（默认全部展开；切换分类/搜索时同名分组保持折叠状态）。 */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const classified = useMemo(
    () => models.map((m) => ({ model: m, category: modelCategory(m) })),
    [models],
  );

  const availableTabs = useMemo<CategoryTab[]>(() => {
    const present = new Set(classified.map((c) => c.category));
    return ["all", ...MODEL_CATEGORIES.filter((c) => present.has(c))];
  }, [classified]);

  const counts = useMemo(() => {
    const map = new Map<CategoryTab, number>();
    map.set("all", classified.length);
    for (const { category: c } of classified) map.set(c, (map.get(c) ?? 0) + 1);
    return map;
  }, [classified]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = classified.filter(({ model, category: c }) => {
      if (category !== "all" && c !== category) return false;
      if (!q) return true;
      return (
        fuzzyMatchModel(model.name, model.id, q) ||
        (model.display_name ? fuzzyMatchModel(model.display_name, model.id, q) : false)
      );
    });
    return groupModelsBySeries(visible.map((v) => v.model));
  }, [classified, category, query]);

  const totalVisible = groups.reduce((n, g) => n + g.models.length, 0);

  return (
    <div
      className="model-browser-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="model-browser-modal" role="dialog" aria-modal="true" aria-label={tr("所有模型")}>
        <div className="model-browser-head">
          <div className="model-browser-title">
            {tr("所有模型")}
            <span className="model-browser-sub">{providerName}</span>
            <span className="model-browser-count">
              {tr("{{count}} 个模型", { count: models.length })}
            </span>
          </div>
          <button type="button" className="ghost tiny" onClick={onClose} title={tr("关闭")}>
            ✕
          </button>
        </div>

        <div className="model-browser-toolbar">
          <div className="model-browser-tabs" role="tablist" aria-label={tr("分类")}>
            {availableTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={category === tab}
                className={`model-browser-tab ${category === tab ? "active" : ""}`}
                onClick={() => setCategory(tab)}
              >
                {tab === "all" ? tr("所有") : tr(categoryLabelKey(tab))}
                <span className="model-browser-tab-count">{counts.get(tab) ?? 0}</span>
              </button>
            ))}
          </div>
          <input
            className="model-browser-search"
            autoFocus
            value={query}
            placeholder={tr("模糊搜索模型名称或 ID…")}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={tr("搜索模型")}
          />
        </div>

        <div className="model-browser-body">
          {totalVisible === 0 ? (
            <p className="hint">{tr("无匹配模型")}</p>
          ) : (
            groups.map((group) => {
              const open = !collapsed.has(group.key);
              return (
                <section key={group.key} className="model-browser-group">
                  <header className="model-browser-group-head">
                    <button
                      type="button"
                      className="model-browser-group-toggle"
                      aria-expanded={open}
                      title={open ? tr("折叠") : tr("展开")}
                      onClick={() => toggleGroup(group.key)}
                    >
                      <span className="model-browser-group-chev" aria-hidden>
                        {open ? "▾" : "▸"}
                      </span>
                      <span className="model-browser-group-name">{group.label}</span>
                      <span className="model-browser-group-count">{group.models.length}</span>
                    </button>
                  </header>
                  {open && (
                    <ul className="model-browser-group-list">
                      {group.models.map((m) => {
                        // 历史数据的 id 可能是 model_<providerId>_<raw>，请求标识在 name 上，两者都要比。
                        const added = addedIds.has(m.id) || (!!m.name && addedIds.has(m.name));
                        return (
                          <li key={m.id} className="model-browser-item">
                            <span className="model-browser-item-main">
                              <span className="model-browser-item-name">{modelDisplayName(m)}</span>
                              <span className="model-browser-item-id">{m.id}</span>
                            </span>
                            <button
                              type="button"
                              className={`model-browser-add ${added ? "added" : ""}`}
                              title={added ? tr("从已接入列表移除") : tr("添加到已接入列表")}
                              aria-label={added ? tr("从已接入列表移除") : tr("添加到已接入列表")}
                              onClick={() => (added ? onRemove(m) : onAdd(m))}
                            >
                              {added ? "−" : "+"}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** 分类 → i18n msgid（中文原文即 msgid，故需固定映射表）。 */
function categoryLabelKey(category: ModelCategory): MsgId {
  switch (category) {
    case "text":
      return "文本";
    case "image":
      return "图片";
    case "video":
      return "视频";
    case "audio":
      return "音频";
    case "embedding":
      return "向量";
    default:
      return "其它";
  }
}
