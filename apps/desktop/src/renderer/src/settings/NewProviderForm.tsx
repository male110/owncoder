import { useCallback, useState } from "react";
import { listedModelToEntry, type ApiFormat, type Provider } from "@owncoder/settings";
import { useI18n } from "../i18n";

export function NewProviderForm({
  onDone,
  onCancel,
}: {
  onDone: (p: Provider) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiFormat, setApiFormat] = useState<ApiFormat>("openai-chat");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [showKey, setShowKey] = useState(false);
  const { t: tr } = useI18n();

  const fetchAndAdd = useCallback(async () => {
    if (!baseUrl.trim()) return;
    setFetching(true);
    setFetchError("");
    try {
      const providerId = `provider_${Date.now().toString(36)}`;
      const result = await window.owncoder.fetchModelList(baseUrl, apiKey || undefined, apiFormat);
      if (!result.ok) {
        setFetchError(result.error ?? tr("未知错误"));
        return;
      }
      // name 是请求用的模型 id，展示名放 displayName（providerId 属于 selectedModels，此处不需要）。
      const models = (result.models ?? []).map((m: { id: string; name: string; display_name?: string }) =>
        listedModelToEntry({ id: m.id, name: m.name || m.id, ...(m.display_name ? { display_name: m.display_name } : {}) }),
      );
      onDone({
        id: providerId,
        name: name.trim() || new URL(baseUrl).hostname,
        baseUrl,
        apiKey,
        apiFormat,
        models,
      });
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }, [baseUrl, apiKey, apiFormat, name, onDone]);

  const addDirect = useCallback(() => {
    if (!baseUrl.trim()) return;
    const providerId = `provider_${Date.now().toString(36)}`;
    let displayName = name.trim();
    if (!displayName) {
      try {
        displayName = new URL(baseUrl).hostname;
      } catch {
        displayName = "";
      }
    }
    onDone({
      id: providerId,
      name: displayName,
      baseUrl,
      apiKey,
      apiFormat,
      models: [],
    });
  }, [baseUrl, apiKey, apiFormat, name, onDone]);

  return (
    <div className="model-detail">
      <div className="model-detail-head">
        <div className="model-detail-title">{tr("添加平台")}</div>
      </div>

      <label className="model-detail-field">
        {tr("平台名称")}
        <input
          value={name}
          placeholder="Ollama / OpenAI / DeepSeek"
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <label className="model-detail-field">
        Base URL
        <input
          value={baseUrl}
          placeholder="http://127.0.0.1:11434/v1"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>

      <label className="model-detail-field">
        {tr("API 协议")}
        <select value={apiFormat} onChange={(e) => setApiFormat(e.target.value as ApiFormat)}>
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
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button type="button" className="ghost tiny" onClick={() => setShowKey((s) => !s)}>
            {showKey ? tr("隐藏") : tr("显示")}
          </button>
        </div>
      </label>

      {fetchError && <p className="error-text">{fetchError}</p>}

      <p className="hint" style={{ margin: "4px 0 10px" }}>
        {tr("「获取并添加」将调用 /v1/models 拉取模型列表；若端点不可用或想稍后手动添加模型，请用「直接添加」。")}
      </p>

      <div className="model-detail-actions">
        <button
          type="button"
          className="primary small"
          disabled={fetching || !baseUrl.trim()}
          onClick={() => void fetchAndAdd()}
        >
          {fetching ? tr("获取中...") : tr("获取并添加")}
        </button>
        <button
          type="button"
          className="ghost small"
          disabled={!baseUrl.trim()}
          onClick={addDirect}
        >
          {tr("直接添加")}
        </button>
        <button type="button" className="ghost small" onClick={onCancel}>
          {tr("取消")}
        </button>
      </div>
    </div>
  );
}
