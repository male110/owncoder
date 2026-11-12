import { useMemo } from "react";
import { modelDisplayName, type AvailableModel, type Provider } from "@owncoder/settings";

export interface ModelGroup {
  providerId: string;
  providerName: string;
  models: AvailableModel[];
}

/**
 * 按平台分组：平台顺序跟随 providers 配置，未知平台按名称排在末尾；
 * 组内模型按展示名（displayName 优先）排序，同名再按 id 排序。
 */
export function groupModels(availableModels: AvailableModel[], providers: Provider[]): ModelGroup[] {
  const map = new Map<string, AvailableModel[]>();
  for (const m of availableModels) {
    const list = map.get(m.providerId) ?? [];
    list.push(m);
    map.set(m.providerId, list);
  }
  const providerOrder = providers.map((p) => p.id);
  const sortedKeys = [...map.keys()].sort((a, b) => {
    const ia = providerOrder.indexOf(a);
    const ib = providerOrder.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return sortedKeys.map((pid) => {
    const provider = providers.find((p) => p.id === pid);
    return {
      providerId: pid,
      providerName: provider?.name || pid,
      models: [...(map.get(pid) ?? [])].sort((a, b) => {
        const byName = modelDisplayName(a).localeCompare(modelDisplayName(b));
        return byName !== 0 ? byName : a.id.localeCompare(b.id);
      }),
    };
  });
}

export function useGroupedModels(availableModels: AvailableModel[], providers: Provider[]): ModelGroup[] {
  return useMemo(() => groupModels(availableModels, providers), [availableModels, providers]);
}
