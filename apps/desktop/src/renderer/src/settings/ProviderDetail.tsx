import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listedModelToEntry,
  modelDisplayName,
  type ApiFormat,
  type AvailableModel,
  type ListedModel,
  type Provider,
  type SystemWorkflowConfig,
} from "@owncoder/settings";
import { useI18n } from "../i18n";
import { fuzzyMatchModel } from "./model-match";
import { ModelBrowserModal } from "./ModelBrowserModal";

export function ProviderDetail({
  provider,
  selectedModels,
  patch,
}: {
  provider: Provider;
  selectedModels: AvailableModel[];
  patch: (fn: (d: SystemWorkflowConfig) => void) => void;
}) {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState(provider.apiKey);
  const [apiFormat, setApiFormat] = useState<ApiFormat>(
    provider.apiFormat === "openai-chat" ||
      provider.apiFormat === "openai-responses" ||
      provider.apiFormat === "anthropic-messages"
      ? provider.apiFormat
      : "openai-chat",
  );
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [manualModelId, setManualModelId] = useState("");
  const [listMode, setListMode] = useState<"add" | "search">("add");
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  // 「获取所有模型」弹窗的数据源；null = 未打开。
  const [browseModels, setBrowseModels] = useState<ListedModel[] | null>(null);
  // 正在通过设置图标自定义展示名的已接入模型 id；null = 无编辑态。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const modelListInputRef = useRef<HTMLInputElement>(null);
  const { t: tr } = useI18n();

  useEffect(() => {
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setApiKey(provider.apiKey);
    setApiFormat(
      provider.apiFormat === "openai-chat" ||
        provider.apiFormat === "openai-responses" ||
        provider.apiFormat === "anthropic-messages"
        ? provider.apiFormat
        : "openai-chat",
    );
    setListMode("add");
    setModelSearchQuery("");
    setManualModelId("");
    setEditingId(null);
  }, [provider.id, provider.name, provider.baseUrl, provider.apiKey, provider.apiFormat]);

  useEffect(() => {
    modelListInputRef.current?.focus();
  }, [listMode]);

  const syncProvider = useCallback(
    (field: "name" | "baseUrl" | "apiKey" | "apiFormat", value: string) => {
      patch((d) => {
        const idx = (d.providers ?? []).findIndex((p) => p.id === provider.id);
        if (idx >= 0) {
          if (field === "apiFormat") {
            d.providers![idx]!.apiFormat = value as ApiFormat;
          } else {
            d.providers![idx]![field] = value;
          }
        }
      });
    },
    [patch, provider.id],
  );

  /** 已接入模型标识集合（弹窗中据此显示 ✓ / 禁用 +）。
   *  同时收录 id 与 name：name 才是发给服务端的请求标识，历史数据里存在
   *  `model_<providerId>_<raw>` 形式的 id，其 name 为裸 raw，只比 id 会漏判为未添加。 */
  const addedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of selectedModels) {
      if (m.providerId !== provider.id) continue;
      ids.add(m.id);
      if (m.name) ids.add(m.name);
    }
    return ids;
  }, [selectedModels, provider.id]);

  /** 弹窗数据：目录（上次拉取结果）映射回 ListedModel，展示名走 displayName。 */
  const catalogAsListed = useMemo<ListedModel[]>(
    () =>
      (provider.models ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        ...(m.displayName ? { display_name: m.displayName } : {}),
      })),
    [provider.models],
  );

  const fetchModels = useCallback(async () => {
    setFetching(true);
    setFetchError("");
    try {
      const result = await window.owncoder.fetchModelList(baseUrl, apiKey || undefined, apiFormat);
      if (!result.ok) {
        setFetchError(result.error ?? tr("未知错误"));
        return;
      }
      const listed = (result.models ?? []).map((m) => ({
        id: m.id,
        name: m.name || m.id,
        ...(m.display_name ? { display_name: m.display_name } : {}),
      }));
      // 写回目录时保留用户已自定义的展示名；请求标识 name 固定为模型 id。
      patch((d) => {
        const idx = (d.providers ?? []).findIndex((p) => p.id === provider.id);
        if (idx < 0) return;
        const previous = new Map((d.providers![idx]!.models ?? []).map((m) => [m.id, m]));
        d.providers![idx]!.models = listed.map((m) => {
          const entry = listedModelToEntry(m);
          const custom = previous.get(m.id)?.displayName?.trim();
          return custom ? { ...entry, displayName: custom } : entry;
        });
      });
      setBrowseModels(listed);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }, [baseUrl, apiKey, apiFormat, provider.id, patch, tr]);

  const openBrowser = useCallback(() => {
    if ((provider.models ?? []).length > 0) {
      setBrowseModels(catalogAsListed);
      return;
    }
    void fetchModels();
  }, [catalogAsListed, fetchModels, provider.models]);

  /** 弹窗中点 + ：把模型加入已接入列表（目录/已接入列表已含同一请求标识则不重复写入）。 */
  const addModel = useCallback(
    (model: ListedModel) => {
      const entry = listedModelToEntry(model);
      patch((d) => {
        const idx = (d.providers ?? []).findIndex((p) => p.id === provider.id);
        if (idx < 0) return;
        const catalog = d.providers![idx]!.models ?? [];
        // 同时比对 name：旧数据的 id 形如 model_<providerId>_<raw>，其 name 才是裸 raw，
        // 只比 id 会让同一模型在目录里出现两条。
        const same = (m: { id: string; name: string }) =>
          m.id === entry.id || (!!m.name && m.name === entry.name);
        if (!catalog.some(same)) {
          d.providers![idx]!.models = [...catalog, entry];
        }
        if ((d.selectedModels ?? []).some((s) => s.providerId === provider.id && same(s))) return;
        d.selectedModels = [...(d.selectedModels ?? []), { ...entry, providerId: provider.id }];
      });
    },
    [patch, provider.id],
  );

  const toggleModel = useCallback(
    (model: AvailableModel, checked: boolean) => {
      patch((d) => {
        if (checked) {
          d.selectedModels = [...(d.selectedModels ?? []), model];
        } else {
          d.selectedModels = (d.selectedModels ?? []).filter(
            (m) => m.providerId !== model.providerId || m.id !== model.id,
          );
        }
      });
    },
    [patch],
  );

  const removeProvider = useCallback(() => {
    patch((d) => {
      d.providers = (d.providers ?? []).filter((p) => p.id !== provider.id);
      d.selectedModels = (d.selectedModels ?? []).filter((m) => m.providerId !== provider.id);
    });
  }, [patch, provider.id]);

  const addManualModel = useCallback(() => {
    const raw = manualModelId.trim();
    if (!raw) return;
    patch((d) => {
      const idx = (d.providers ?? []).findIndex((p) => p.id === provider.id);
      if (idx < 0) return;
      const existing = d.providers![idx]!.models ?? [];
      // 与 addModel 一致：同时比对 name，避免与旧格式 id（model_<providerId>_<raw>）重复。
      const same = (m: { id: string; name: string }) => m.id === raw || m.name === raw;
      if (!existing.some(same)) {
        d.providers![idx]!.models = [...existing, { id: raw, name: raw }];
      }
      if ((d.selectedModels ?? []).some((s) => s.providerId === provider.id && same(s))) return;
      d.selectedModels = [...(d.selectedModels ?? []), { id: raw, name: raw, providerId: provider.id }];
    });
    setManualModelId("");
  }, [manualModelId, provider.id, patch]);

  const removeModel = useCallback(
    (modelId: string) => {
      patch((d) => {
        const idx = (d.providers ?? []).findIndex((p) => p.id === provider.id);
        if (idx >= 0) {
          d.providers![idx]!.models = (d.providers![idx]!.models ?? []).filter((m) => m.id !== modelId);
        }
        d.selectedModels = (d.selectedModels ?? []).filter(
          (m) => m.providerId !== provider.id || m.id !== modelId,
        );
      });
      setEditingId((prev) => (prev === modelId ? null : prev));
    },
    [patch, provider.id],
  );

  /** 保存自定义展示名：目录条目与已接入条目同步更新。 */
  const saveDisplayName = useCallback(
    (modelId: string, value: string) => {
      const displayName = value.trim();
      patch((d) => {
        const idx = (d.providers ?? []).findIndex((p) => p.id === provider.id);
        if (idx >= 0) {
          d.providers![idx]!.models = (d.providers![idx]!.models ?? []).map((m) =>
            m.id === modelId ? (displayName ? { ...m, displayName } : { id: m.id, name: m.name }) : m,
          );
        }
        d.selectedModels = (d.selectedModels ?? []).map((m) =>
          m.providerId === provider.id && m.id === modelId
            ? displayName
              ? { ...m, displayName }
              : { id: m.id, name: m.name, providerId: m.providerId }
            : m,
        );
      });
      setEditingId(null);
    },
    [patch, provider.id],
  );

  const enabledCount = addedIds.size;

  const addedModels = useMemo(() => {
    const list = selectedModels.filter((m) => m.providerId === provider.id);
    if (listMode !== "search" || !modelSearchQuery.trim()) return list;
    const q = modelSearchQuery.trim().toLowerCase();
    return list.filter((m) => fuzzyMatchModel(modelDisplayName(m), m.id, q));
  }, [listMode, modelSearchQuery, provider.id, selectedModels]);

  const enterSearchMode = useCallback(() => {
    setListMode("search");
    setModelSearchQuery("");
  }, []);

  const exitSearchMode = useCallback(() => {
    setListMode("add");
    setModelSearchQuery("");
  }, []);

  return (
    <div className="model-detail">
      <div className="model-detail-head">
        <div className="model-detail-title">
          <input
            className="model-detail-name-input"
            value={name}
            placeholder={tr("平台名称")}
            onChange={(e) => {
              setName(e.target.value);
              syncProvider("name", e.target.value);
            }}
          />
          <span className={`model-status-badge ${enabledCount > 0 ? "on" : ""}`}>
            {enabledCount > 0 ? tr("已启用 {{count}}", { count: enabledCount }) : tr("未启用")}
          </span>
        </div>
        <button type="button" className="ghost small danger" onClick={removeProvider}>
          {tr("删除")}
        </button>
      </div>

      <label className="model-detail-field">
        Base URL
        <input
          value={baseUrl}
          placeholder="https://api.example.com/v1"
          onChange={(e) => {
            setBaseUrl(e.target.value);
            syncProvider("baseUrl", e.target.value);
          }}
        />
      </label>

      <label className="model-detail-field">
        {tr("API 协议")}
        <select
          value={apiFormat}
          onChange={(e) => {
            const next = e.target.value as ApiFormat;
            setApiFormat(next);
            syncProvider("apiFormat", next);
          }}
        >
          <option value="openai-chat">OpenAI Chat Completions</option>
          <option value="openai-responses">OpenAI Responses</option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
        <span className="hint">{tr("协议与 Base URL 独立：自建或代理端点也可选 Anthropic Messages。")}</span>
      </label>

      <label className="model-detail-field">
        API Key
        <div className="api-key-row">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            placeholder={tr("sk-...（本地可留空）")}
            autoComplete="off"
            onChange={(e) => {
              setApiKey(e.target.value);
              syncProvider("apiKey", e.target.value);
            }}
          />
          <button type="button" className="ghost tiny" onClick={() => setShowKey((s) => !s)}>
            {showKey ? tr("隐藏") : tr("显示")}
          </button>
        </div>
      </label>

      <div className="model-detail-actions">
        <button
          type="button"
          className="primary small"
          disabled={fetching || !baseUrl.trim()}
          onClick={() => void fetchModels()}
        >
          {fetching ? tr("获取中...") : tr("获取所有模型")}
        </button>
        {(provider.models ?? []).length > 0 && (
          <button type="button" className="ghost small" onClick={openBrowser}>
            {tr("浏览模型目录")}
          </button>
        )}
      </div>

      {fetchError && <p className="error-text">{fetchError}</p>}

      <div
        className="model-detail-list"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "f" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            enterSearchMode();
          } else if (e.key === "Escape" && listMode === "search") {
            e.preventDefault();
            e.stopPropagation();
            exitSearchMode();
          }
        }}
      >
        <div className="model-detail-list-head">
          {tr("已接入模型")}
          {listMode === "search" && (
            <span className="model-list-mode-hint">{tr("按 Esc 退出搜索")}</span>
          )}
        </div>
        <div className="model-manual-add">
          {listMode === "add" ? (
            <>
              <input
                ref={modelListInputRef}
                value={manualModelId}
                placeholder={tr("手动输入模型 ID，如 gpt-4o、deepseek-chat（Ctrl+F 搜索）")}
                onChange={(e) => setManualModelId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addManualModel();
                  }
                }}
              />
              <button
                type="button"
                className="ghost small"
                disabled={!manualModelId.trim()}
                onClick={addManualModel}
              >
                {tr("添加")}
              </button>
            </>
          ) : (
            <input
              ref={modelListInputRef}
              value={modelSearchQuery}
              placeholder={tr("模糊搜索模型名称或 ID…")}
              onChange={(e) => setModelSearchQuery(e.target.value)}
              aria-label={tr("搜索模型")}
            />
          )}
        </div>
        {selectedModels.filter((m) => m.providerId === provider.id).length === 0 ? (
          <p className="hint">{tr("点击「获取所有模型」浏览目录，用 + 加入已接入列表，或在上方手动输入模型 ID")}</p>
        ) : addedModels.length === 0 ? (
          <p className="hint">{tr("无匹配模型")}</p>
        ) : (
          addedModels.map((m) => (
            <div key={`${m.providerId}\u0000${m.id}`} className="model-detail-row">
              {editingId === m.id ? (
                <span className="model-display-edit">
                  <input
                    autoFocus
                    value={editingName}
                    placeholder={m.name}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveDisplayName(m.id, editingName);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setEditingId(null);
                      }
                    }}
                    aria-label={tr("自定义展示名")}
                  />
                  <button type="button" className="ghost tiny" onClick={() => saveDisplayName(m.id, editingName)}>
                    {tr("保存")}
                  </button>
                  <button type="button" className="ghost tiny" onClick={() => setEditingId(null)}>
                    {tr("取消")}
                  </button>
                </span>
              ) : (
                <label className="model-detail-row-label">
                  <input
                    type="checkbox"
                    checked
                    onChange={(e) => toggleModel(m, e.target.checked)}
                  />
                  <span className="model-detail-row-name">{modelDisplayName(m)}</span>
                  {m.displayName && m.displayName !== m.name ? (
                    <span className="model-detail-row-id">{m.id}</span>
                  ) : null}
                </label>
              )}
              <span className="model-detail-row-actions">
                <button
                  type="button"
                  className="ghost tiny"
                  title={tr("自定义展示名")}
                  onClick={() => {
                    setEditingId(m.id);
                    setEditingName(m.displayName ?? "");
                  }}
                >
                  ⚙
                </button>
                <button
                  type="button"
                  className="ghost tiny danger"
                  title={tr("移除该模型")}
                  onClick={() => removeModel(m.id)}
                >
                  {tr("删除")}
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      {browseModels && (
        <ModelBrowserModal
          providerName={name || provider.baseUrl}
          models={browseModels}
          addedIds={addedIds}
          onAdd={addModel}
          onClose={() => setBrowseModels(null)}
        />
      )}
    </div>
  );
}
