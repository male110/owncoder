import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ApiFormat,
  type AvailableModel,
  type Provider,
  type SystemWorkflowConfig,
} from "@owncoder/settings";
import { useI18n } from "../i18n";

/** Subsequence fuzzy match: query chars appear in order within haystack. */
function fuzzyMatchModel(name: string, id: string, query: string): boolean {
  const targets = [name.toLowerCase(), id.toLowerCase()];
  return targets.some((text) => {
    let qi = 0;
    for (let i = 0; i < text.length && qi < query.length; i++) {
      if (text[i] === query[qi]) qi++;
    }
    return qi === query.length;
  });
}

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

  const fetchModels = useCallback(async () => {
    setFetching(true);
    setFetchError("");
    try {
      const result = await window.owncoder.fetchModelList(baseUrl, apiKey || undefined, apiFormat);
      if (!result.ok) {
        setFetchError(result.error ?? tr("未知错误"));
        return;
      }
      const models = (result.models ?? []).map((m: { id: string; name: string }) => ({
        id: m.id,
        name: m.name || m.id,
        providerId: provider.id,
      }));
      patch((d) => {
        const idx = (d.providers ?? []).findIndex((p) => p.id === provider.id);
        if (idx < 0) return;

        d.providers![idx]!.models = models;
        const currentModels = new Map(models.map((model) => [model.id, model]));
        d.selectedModels = (d.selectedModels ?? []).flatMap((selected) => {
          if (selected.providerId !== provider.id) return [selected];
          const current = currentModels.get(selected.id);
          return current ? [{ ...selected, name: current.name }] : [];
        });
      });
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }, [baseUrl, apiKey, apiFormat, provider.id, patch]);

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
    const modelId = `model_${provider.id}_${raw}`;
    patch((d) => {
      const idx = (d.providers ?? []).findIndex((p) => p.id === provider.id);
      if (idx < 0) return;
      const existing = d.providers![idx]!.models ?? [];
      if (existing.some((m) => m.id === modelId)) return;
      d.providers![idx]!.models = [...existing, { id: modelId, name: raw }];
      d.selectedModels = [
        ...(d.selectedModels ?? []),
        { id: modelId, name: raw, providerId: provider.id },
      ];
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
    },
    [patch, provider.id],
  );

  const enabledCount = selectedModels.filter((m) => m.providerId === provider.id).length;

  const filteredModels = useMemo(() => {
    if (listMode !== "search" || !modelSearchQuery.trim()) return provider.models;
    const q = modelSearchQuery.trim().toLowerCase();
    return provider.models.filter((m) => fuzzyMatchModel(m.name, m.id, q));
  }, [provider.models, listMode, modelSearchQuery]);

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
          {fetching ? tr("获取中...") : tr("获取模型列表")}
        </button>
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
          {tr("模型列表")}
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
        {provider.models.length === 0 ? (
          <p className="hint">{tr("点击「获取模型列表」拉取，或在上方手动输入模型 ID 后添加")}</p>
        ) : filteredModels.length === 0 ? (
          <p className="hint">{tr("无匹配模型")}</p>
        ) : (
          filteredModels.map((m) => {
            const isSelected = selectedModels.some(
              (s) => s.providerId === provider.id && s.id === m.id,
            );
            return (
              <div key={m.id} className="model-detail-row">
                <label className="model-detail-row-label">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) =>
                      toggleModel(
                        { id: m.id, name: m.name, providerId: provider.id },
                        e.target.checked,
                      )
                    }
                  />
                  <span className="model-detail-row-name">{m.name}</span>
                </label>
                <button
                  type="button"
                  className="ghost tiny danger"
                  title={tr("移除该模型")}
                  onClick={() => removeModel(m.id)}
                >
                  {tr("删除")}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
