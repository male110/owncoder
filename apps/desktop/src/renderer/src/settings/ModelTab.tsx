import { useEffect, useMemo, useRef, useState } from "react";
import type { SystemWorkflowConfig } from "@owncoder/settings";
import type { SettingsSnapshotDto } from "../../../preload/index";
import { useI18n } from "../i18n";
import { NewProviderForm } from "./NewProviderForm";
import { ProviderDetail } from "./ProviderDetail";

export function ModelTab({
  draft,
  patch,
  onProviderAdded,
  onImported,
  setStatus,
  setBusy,
}: {
  draft: SystemWorkflowConfig;
  patch: (fn: (d: SystemWorkflowConfig) => void) => void;
  onProviderAdded: () => void;
  onImported: (snapshot: SettingsSnapshotDto) => void;
  setStatus: (status: string) => void;
  setBusy: (busy: boolean) => void;
}) {
  // useMemo 稳定引用：draft.providers 为 undefined 时复用同一空数组，
  // 避免每次渲染新建数组进入 effect deps 导致 effect 空转。
  const providers = useMemo(() => draft.providers ?? [], [draft.providers]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [transferAction, setTransferAction] = useState<"import" | "export" | null>(null);
  const providerCountRef = useRef(providers.length);
  const { t: tr } = useI18n();

  useEffect(() => {
    if (providers.length > providerCountRef.current) onProviderAdded();
    providerCountRef.current = providers.length;
  }, [providers.length, onProviderAdded]);

  useEffect(() => {
    if (adding) return;
    if (!selectedId && providers.length > 0) {
      setSelectedId(providers[0]!.id);
      return;
    }
    if (selectedId && !providers.some((p) => p.id === selectedId)) {
      setSelectedId(providers[0]?.id ?? null);
    }
  }, [providers, selectedId, adding]);

  return (
    <div className="model-tab-layout">
      <div className="model-provider-list">
        <div className="model-provider-list-head">
          <div className="model-provider-list-title">
            <span>{tr("自定义平台")}</span>
            <span className="model-provider-count" aria-hidden="true">{providers.length}</span>
          </div>
          <div className="model-settings-actions">
            <button type="button" className="model-transfer-button" title={tr("导出模型设置")} disabled={transferAction !== null} aria-busy={transferAction === "export"} onClick={() => void (async () => {
              setTransferAction("export");
              setBusy(true);
              try {
                const result = await window.owncoder.exportModelSettings();
                if (result.status === "success") setStatus(tr("已导出 {{count}} 个模型", { count: result.count ?? 0 }));
              } catch (e) {
                setStatus(e instanceof Error ? e.message : String(e));
              } finally { setBusy(false); setTransferAction(null); }
            })()}>
              <span className="model-transfer-icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 15V3m-4 4 4-4 4 4M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
                </svg>
              </span>
              <span>{tr("导出")}</span>
            </button>
            <button type="button" className="model-transfer-button model-transfer-button-primary" title={tr("导入模型设置")} disabled={transferAction !== null} aria-busy={transferAction === "import"} onClick={() => void (async () => {
              setTransferAction("import");
              setBusy(true);
              try {
                const result = await window.owncoder.importModelSettings();
                if (result.status === "success") {
                  onImported(result.snapshot);
                  setStatus(tr("导入完成：新增 {{added}} 个，跳过 {{skipped}} 个", { added: result.added, skipped: result.skipped }));
                } else if (result.status === "error") {
                  setStatus(result.message);
                }
              } catch (e) {
                setStatus(e instanceof Error ? e.message : String(e));
              } finally { setBusy(false); setTransferAction(null); }
            })()}>
              <span className="model-transfer-icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v12m-4-4 4 4 4-4M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
                </svg>
              </span>
              <span>{tr("导入")}</span>
            </button>
          </div>
        </div>
        {providers.map((p) => {
          const enabledCount =
            draft.selectedModels?.filter((m) => m.providerId === p.id).length ?? 0;
          return (
            <button
              key={p.id}
              type="button"
              className={`model-provider-item ${selectedId === p.id && !adding ? "active" : ""}`}
              onClick={() => {
                setSelectedId(p.id);
                setAdding(false);
              }}
            >
              <span className="model-provider-name">{p.name || p.baseUrl}</span>
              <span
                className={`model-provider-dot ${enabledCount > 0 ? "on" : ""}`}
                title={tr("已启用 {{count}} 个模型", { count: enabledCount })}
              />
            </button>
          );
        })}
        <button
          type="button"
          className={`model-provider-item add ${adding ? "active" : ""}`}
          onClick={() => setAdding(true)}
        >
          {tr("+ 添加平台")}
        </button>
      </div>

      <div className="model-provider-detail">
        {adding ? (
          <NewProviderForm
            onDone={(p) => {
              patch((d) => {
                d.providers = [...(d.providers ?? []), p];
              });
              setAdding(false);
              setSelectedId(p.id);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : selectedId && providers.some((p) => p.id === selectedId) ? (
          <ProviderDetail
            key={selectedId}
            provider={providers.find((p) => p.id === selectedId)!}
            selectedModels={draft.selectedModels ?? []}
            patch={patch}
          />
        ) : (
          <div className="model-empty">
            <p className="hint">{tr("暂无平台配置，点击左侧「添加平台」开始。")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
