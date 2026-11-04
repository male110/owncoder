import { useEffect, useMemo, useRef, useState } from "react";
import { customConfirm } from "./utils/customConfirm";
import {
  BUILTIN_SENSITIVE_FILES,
  SECURITY_STACK_COVERAGE,
  type SystemWorkflowConfig,
} from "@owncoder/settings";

import type { RuleFileDto, SettingsSnapshotDto } from "../../preload/index";
import { BlurNumberInput } from "./components/BlurNumberInput";
import { SecurityRedactionTest } from "./components/SecurityRedactionTest";
import type { LocalePref, MsgId } from "../../shared/i18n/core";
import { setLocalePref, useI18n } from "./i18n";
import { ModelTab } from "./settings/ModelTab";
import { MemoriesTab } from "./settings/MemoriesTab";
import { RulesTab } from "./settings/RulesTab";
import { SkillsTab } from "./settings/SkillsTab";

export type TabId =
  | "harness"
  | "models"
  | "context"
  | "mcp"
  | "secrets"
  | "rules"
  | "memories"
  | "skills"
  | "restore";

const TABS: { id: TabId; label: MsgId; group?: MsgId }[] = [
  { id: "harness", label: "常规设置", group: "运转" },
  { id: "models", label: "模型", group: "运转" },
  { id: "context", label: "上下文", group: "运转" },
  { id: "mcp", label: "MCP", group: "运转" },
  { id: "secrets", label: "安全", group: "运转" },
  { id: "rules", label: "规则", group: "项目" },
  { id: "memories", label: "偏好记忆", group: "项目" },
  { id: "skills", label: "技能", group: "项目" },
  { id: "restore", label: "还原", group: "维护" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** Default tab to show when opened. Resets when the panel closes/reopens. */
  initialTab?: TabId;
}

export function SettingsPanel({ open, onClose, onSaved, initialTab }: Props) {
  const [tab, setTab] = useState<TabId>(initialTab ?? "harness");
  const { t: tr } = useI18n();

  // Reset tab when panel reopens with a different initialTab
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);
  const [snap, setSnap] = useState<SettingsSnapshotDto | null>(null);
  const [draft, setDraft] = useState<SystemWorkflowConfig | null>(null);
  const [llmApiKey, setLlmApiKey] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  // Auto-save bookkeeping (no manual Save button).
  const savingRef = useRef(false);
  /** Invalidates an in-flight debounced save when a restore is requested. */
  const settingsRevisionRef = useRef(0);
  const savedApiKeyRef = useRef("");
  const latestDraftRef = useRef<SystemWorkflowConfig | null>(null);
  latestDraftRef.current = draft;
  /** 自动保存 effect 经此 ref 调用最新 persistSettings（组件体内未 memo 函数）。 */
  const persistSettingsRef = useRef<() => Promise<void>>(async () => {});

  const [hasWorkspace, setHasWorkspace] = useState(false);
  const [rules, setRules] = useState<RuleFileDto[]>([]);
  const [selectedRule, setSelectedRule] = useState<string | null>(null);
  const [ruleBody, setRuleBody] = useState("");
  const [ruleDirty, setRuleDirty] = useState(false);
  const [newRuleName, setNewRuleName] = useState("");

  const reloadRules = async () => {
    const ws = await window.owncoder.getWorkspace();
    setHasWorkspace(Boolean(ws));
    if (!ws) {
      setRules([]);
      setSelectedRule(null);
      setRuleBody("");
      setRuleDirty(false);
      return;
    }
    const list = await window.owncoder.listRules();
    setRules(list);
    if (selectedRule && !list.some((r) => r.name === selectedRule)) {
      setSelectedRule(null);
      setRuleBody("");
      setRuleDirty(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const s = await window.owncoder.getSettings();
      const secrets = await window.owncoder.getSecrets();
      setSnap(s);
      setDraft(structuredClone(s.effective));
      setLocalePref((s.effective.harness.locale ?? "system") as LocalePref);
      setLlmApiKey(secrets.llmApiKey ?? "");
      savedApiKeyRef.current = secrets.llmApiKey ?? "";
      setStatus("");
      await reloadRules();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dirty = useMemo(() => {
    if (!snap || !draft) return false;
    return JSON.stringify(draft) !== JSON.stringify(snap.effective);
  }, [draft, snap]);

  // Auto-save workflow settings shortly after any change.
  useEffect(() => {
    if (!open || !draft || !snap) return;
    if (savingRef.current) return;
    const apiDirty = llmApiKey.trim() !== savedApiKeyRef.current;
    if (!dirty && !apiDirty) return;
    const timer = setTimeout(() => void persistSettingsRef.current(), 700);
    return () => clearTimeout(timer);
  }, [draft, snap, llmApiKey, dirty, open]);

  // Auto-save the edited rule file shortly after typing stops.
  useEffect(() => {
    if (!open || !selectedRule || !ruleDirty) return;
    const timer = setTimeout(() => void autoSaveRule(), 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleBody, ruleDirty, selectedRule, open]);

  if (!open || !draft || !snap) return null;

  const patch = (fn: (d: SystemWorkflowConfig) => void) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  };

  const persistSettings = async () => {
    if (!draft || !snap) return;
    savingRef.current = true;
    const revision = settingsRevisionRef.current;
    setBusy(true);
    const savingDraft = latestDraftRef.current ?? draft;
    const savingJson = JSON.stringify(savingDraft);
    try {
      if (revision !== settingsRevisionRef.current) return;
      const s = await window.owncoder.saveSettings(savingDraft);
      if (revision !== settingsRevisionRef.current) return;
      if (llmApiKey.trim() !== savedApiKeyRef.current) {
        await window.owncoder.setLlmApiKey(llmApiKey.trim() || null);
        savedApiKeyRef.current = llmApiKey.trim();
      }
      setSnap(s);
      setLocalePref((s.effective.harness.locale ?? "system") as LocalePref);
      // Don't clobber edits made while the async save was in flight.
      if (JSON.stringify(latestDraftRef.current) === savingJson) {
        setDraft(structuredClone(s.effective));
      }
      setStatus(tr("已自动保存（{{fp}}）", { fp: s.fingerprint }));
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };
  // 每次渲染刷新 ref，使 debounce 到期时始终执行最新闭包
  // （携带最新 draft/snap/llmApiKey），保存成功→setSnap→dirty 收敛语义不变。
  persistSettingsRef.current = persistSettings;

  const onRestore = async () => {
    if (!(await customConfirm(tr("一键还原将清除当前项目的全部规则和偏好记忆，此操作不可撤销。")))) {
      return;
    }
    setBusy(true);
    try {
      const result = await window.owncoder.restoreProjectContext();
      await reloadRules();
      setStatus(tr("已清除 {{rules}} 条项目规则和 {{memories}} 条项目偏好记忆", result));
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openRule = async (name: string) => {
    // Flush any unsaved edits before switching (auto-save, no prompt).
    if (ruleDirty && selectedRule) {
      try {
        await window.owncoder.writeRule(selectedRule, ruleBody);
      } catch {
        /* ignore; surfaced on next explicit action */
      }
    }
    const body = await window.owncoder.readRule(name);
    setSelectedRule(name);
    setRuleBody(body);
    setRuleDirty(false);
  };

  const autoSaveRule = async () => {
    if (!selectedRule) return;
    try {
      await window.owncoder.writeRule(selectedRule, ruleBody);
      setRuleDirty(false);
      setStatus(tr("已自动保存规则：.owncoder/rules/{{name}}", { name: selectedRule }));
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const onCreateRule = async () => {
    let name = newRuleName.trim() || "project.md";
    if (!name.endsWith(".md")) name += ".md";
    setBusy(true);
    try {
      await window.owncoder.writeRule(
        name,
        tr("# {{name}}\n\n- 优先小范围补丁。\n- 遵循项目既有约定。\n", { name: name.replace(/\.md$/i, "") }),
      );
      setNewRuleName("");
      await reloadRules();
      await openRule(name);
      setStatus(tr("已创建 {{name}}", { name }));
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDeleteRule = async () => {
    if (!selectedRule) return;
    if (!(await customConfirm(tr("删除 .owncoder/rules/{{name}}？", { name: selectedRule })))) return;
    setBusy(true);
    try {
      await window.owncoder.deleteRule(selectedRule);
      setSelectedRule(null);
      setRuleBody("");
      setRuleDirty(false);
      await reloadRules();
      setStatus(tr("已删除规则文件"));
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={tr("系统设置")}
    >
      <div className="settings-modal">
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={tr("工作流分区")}>
            <button type="button" className="settings-back" onClick={onClose}>
              {tr("← 返回工作区")}
            </button>
            {TABS.map((tb, i) => {
              const prev = TABS[i - 1];
              const showGroup = tb.group && tb.group !== prev?.group;
              return (
                <div key={tb.id}>
                  {showGroup && tb.group ? <div className="settings-nav-group">{tr(tb.group)}</div> : null}
                  <button
                    type="button"
                    className={tab === tb.id ? "active" : ""}
                    onClick={() => setTab(tb.id)}
                  >
                    {tr(tb.label)}
                  </button>
                </div>
              );
            })}
          </nav>

        <div className={`settings-body${tab === "models" ? " settings-body-models" : ""}`}>
          <div className="settings-body-head">
            <h2>{tr(TABS.find((tb) => tb.id === tab)?.label ?? "模型")}</h2>
          </div>
          {tab === "models" && (
            <ModelTab
              draft={draft}
              patch={patch}
              onProviderAdded={() => void persistSettings()}
              onImported={(next) => {
                setSnap(next);
                setDraft(structuredClone(next.effective));
                onSaved();
              }}
              setStatus={setStatus}
              setBusy={setBusy}
            />
          )}

          {tab === "context" && (
            <div className="form">
              {/* Context Window + Input/Output Ratio (single group) */}
              <fieldset>
                <legend style={{ fontSize: "0.8em", fontWeight: 500 }}>{tr("上下文窗口")}</legend>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                  {[
                    { label: "64K", value: 65536 },
                    { label: "128K", value: 131072 },
                    { label: "256K", value: 262144 },
                    { label: "1M", value: 1048576 },
                  ].map(({ label, value }) => (
                    <button
                      key={value}
                      type="button"
                      className={draft.context.contextWindow === value ? "active" : ""}
                      style={{
                        padding: "4px 12px",
                        border: `2px solid ${draft.context.contextWindow === value ? "var(--accent)" : "var(--border)"}`,
                        borderRadius: 4,
                        background: draft.context.contextWindow === value ? "rgba(77, 159, 255, 0.12)" : "transparent",
                        color: draft.context.contextWindow === value ? "var(--accent)" : "var(--text)",
                        cursor: "pointer",
                        transition: "all 0.12s ease",
                        fontSize: "13px",
                      }}
                      onClick={() =>
                        patch((d) => {
                          d.context.contextWindow = value;
                        })
                      }
                    >
                      {label}
                    </button>
                  ))}
                  <input
                    key={draft.context.contextWindow}
                    type="text"
                    placeholder={tr("自定义")}
                    title={tr("支持 K/M 后缀，如 512K、2M")}
                    defaultValue={draft.context.contextWindow.toString()}
                    style={{
                      width: 80,
                      padding: "4px 6px",
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      color: "var(--text)",
                      fontSize: "13px",
                      outline: "none",
                    }}
                    onBlur={(e) => {
                      const raw = e.target.value.trim().toUpperCase();
                      const m = raw.match(/^(\d+(?:\.\d+)?)\s*([KM])?$/);
                      if (m) {
                        const n = parseFloat(m[1]!);
                        const suffix = m[2];
                        let parsed = Math.round(n);
                        if (suffix === "K") parsed = Math.round(n * 1024);
                        if (suffix === "M") parsed = Math.round(n * 1024 * 1024);
                        if (parsed >= 1024) {
                          patch((d) => {
                            d.context.contextWindow = parsed;
                          });
                        }
                      }
                    }}
                  />
                </div>
                <label>
                  {tr("输入占比")}
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "nowrap", marginTop: 6 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 0 }}>
                      <BlurNumberInput
                        min={1}
                        max={99}
                        value={draft.context.inputRatio}
                        onCommit={(n) =>
                          patch((d) => {
                            d.context.inputRatio = n;
                          })
                        }
                      />
                      <span style={{ marginLeft: 4, color: "var(--muted)", fontSize: "13px", fontWeight: 500 }}>%</span>
                    </span>
                    <span style={{ color: "var(--muted)", fontSize: "0.85em", whiteSpace: "nowrap", opacity: 0.9 }}>
                      {tr("输入 ≈{{in}} tokens · 输出 ≈{{out}} tokens", { in: (draft.context.contextWindow * draft.context.inputRatio / 100).toLocaleString("zh-CN"), out: (draft.context.contextWindow * (100 - draft.context.inputRatio) / 100).toLocaleString("zh-CN") })}
                    </span>
                  </div>
                </label>
              </fieldset>

              {/* Segment Ratios */}
              <fieldset>
                <legend style={{ fontSize: "0.8em", fontWeight: 500 }}>{tr("输入预算段分配")}</legend>
                <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                  {tr("输入预算扣除系统提示、工具定义等固定段后，剩余空间按以下比例分配给三个动态段。")}
                </p>
                {([
                  { key: "historyRatio" as const, label: tr("对话历史"), hint: tr("聊天记录与上下文") },
                  { key: "toolResultRatio" as const, label: tr("工具调用结果"), hint: tr("工具返回给模型的内容，含代码检索结果") },
                  { key: "techStackRatio" as const, label: tr("技术栈信息"), hint: tr("项目结构、依赖等") },
                ]).map(({ key, label, hint }) => (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                    <span style={{ minWidth: 100, fontSize: "13px", fontWeight: 500 }}>{label}</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 0 }}>
                      <BlurNumberInput
                        min={0}
                        max={100}
                        value={Math.round((draft.context.segments[key] ?? 0) * 100)}
                        onCommit={(n) =>
                          patch((d) => {
                            if (!d.context.segments) d.context.segments = {} as any;
                            d.context.segments[key] = n / 100;
                          })
                        }
                      />
                      <span style={{ marginLeft: 4, color: "var(--muted)", fontSize: "13px", fontWeight: 500 }}>%</span>
                    </span>
                    <span style={{ color: "var(--muted)", fontSize: "0.85em" }}>{hint}</span>
                  </div>
                ))}
                <div style={{ marginTop: 4, fontSize: "0.85em", color: "var(--muted)" }}>
                  {tr("合计：{{total}}", { total: Math.round(
                    ((draft.context.segments?.historyRatio ?? 0.3)
                      + (draft.context.segments?.toolResultRatio ?? 0.65)
                      + (draft.context.segments?.techStackRatio ?? 0.05)) * 100,
                  ) })}%
                  {(() => {
                    const sum = (draft.context.segments?.historyRatio ?? 0.3)
                      + (draft.context.segments?.toolResultRatio ?? 0.65)
                      + (draft.context.segments?.techStackRatio ?? 0.05);
                    if (Math.abs(sum - 1) > 0.01) {
                      return <span style={{ color: "var(--danger, #e74c3c)", marginLeft: 8 }}>{tr("（建议合计 100%）")}</span>;
                    }
                    return null;
                  })()}
                </div>
              </fieldset>

            </div>
          )}

          {tab === "harness" && (
            <div className="form">
              <label>
                {tr("语言")}
                <select
                  value={draft.harness.locale ?? "system"}
                  onChange={(e) => {
                    const next = e.target.value as LocalePref;
                    patch((d) => {
                      d.harness.locale = next;
                    });
                    setLocalePref(next);
                  }}
                >
                  <option value="system">{tr("跟随系统")}</option>
                  <option value="zh">{tr("中文")}</option>
                  <option value="en">English</option>
                </select>
              </label>
              <p className="hint">{tr("同时作用于界面显示语言与 LLM 回复语言。")}</p>
              <label>
                {tr("工具输出最大字符数")}
                <BlurNumberInput
                  min={500}
                  value={draft.harness.toolOutputMaxChars}
                  onCommit={(n) =>
                    patch((d) => {
                      d.harness.toolOutputMaxChars = n;
                    })
                  }
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.harness.separateStageModels ?? false}
                  onChange={(e) =>
                    patch((d) => {
                      const enabling = e.target.checked;
                      d.harness.separateStageModels = enabling;
                      
                      if (enabling) {
                        // 启用执行阶段单独配置：从统一配置迁移模型
                        const unifiedModel = draft.selectedModels?.[0]?.id;

                        // 只在 reactModel 为空时才迁移
                        if (!d.harness.reactModel && unifiedModel) {
                          d.harness.reactModel = unifiedModel;
                        }
                        // 执行阶段思考等级默认“中强度”：未配置时固定为 medium，
                        // 不从任务分解的 defaultEffort 迁移（后者默认 high）。
                        if (!d.harness.reactThinkingEffort) {
                          d.harness.reactThinkingEffort = "medium";
                        }
                      } else {
                        // 禁用执行阶段单独配置：回退到统一配置
                        const fallbackModel = d.harness.reactModel;
                        const fallbackEffort = d.harness.reactThinkingEffort || "medium";
                        
                        if (fallbackModel && draft.selectedModels?.length) {
                          // 查找对应的模型对象
                          const targetModel = draft.selectedModels.find(m => m.id === fallbackModel);
                          if (targetModel) {
                            // 将选中的模型移到数组第一位
                            d.selectedModels = [targetModel, ...draft.selectedModels.filter(m => m.id !== fallbackModel)];
                          }
                        }
                        
                        if (!d.thinking) {
                          d.thinking = { defaultEffort: fallbackEffort };
                        } else {
                          d.thinking.defaultEffort = fallbackEffort;
                        }
                      }
                    })
                  }
                />
                {tr("执行阶段单独配置")}
              </label>
              <p className="hint">{tr("开启后，React 循环使用单独的模型和思考强度")}。{tr("建议任务分解用较好的模型，React 用中等的模型。React 循环比较费 token。")}。</p>
              {draft.harness.separateStageModels && (
                <div style={{ marginLeft: "1.5rem", marginTop: "0.5rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <div style={{ width: "3px", height: "20px", backgroundColor: "#3b82f6" }} />
                      <span>任务分解 蓝色</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <div style={{ width: "3px", height: "20px", backgroundColor: "#10b981" }} />
                      <span>执行 绿色</span>
                    </div>
                  </div>
                </div>
              )}

              {/* 危险 bash 自动批准：勾选后所有 bash 命令（含危险命令）不再弹确认 */}
              <label className="check" style={{ marginTop: "1rem" }}>
                <input
                  type="checkbox"
                  checked={draft.modes.agent.autoApproveBash ?? false}
                  onChange={(e) =>
                    patch((d) => {
                      d.modes.agent.autoApproveBash = e.target.checked;
                    })
                  }
                />
                {tr("自动批准所有 bash 命令")}
              </label>
              <p className="hint">
                {tr("勾选后所有 bash 命令（含危险命令）不再弹出确认，直接执行。")}
                {" "}
                <strong>{tr("危险命令将跳过确认直接执行，请仅在可信环境中开启。")}</strong>
              </p>
            </div>
          )}

          {tab === "mcp" && (
            <div className="form">
              <p className="hint">
                {tr("通过 stdio 连接 MCP 服务器。工具名形如 ")}<code>mcp__id__tool</code>{tr("，保存后自动连接。")}
              </p>
              {(draft.mcp?.servers ?? []).map((s, i) => (
                <div key={`${s.id}-${i}`} className="mcp-server-card">
                  <div className="grid-2">
                    <label>
                      ID
                      <input
                        value={s.id}
                        onChange={(e) =>
                          patch((d) => {
                            const servers = [...(d.mcp?.servers ?? [])];
                            servers[i] = { ...servers[i]!, id: e.target.value.trim() || s.id };
                            d.mcp = { servers };
                          })
                        }
                      />
                    </label>
                    <label>
                      {tr("显示名")}
                      <input
                        value={s.name ?? ""}
                        onChange={(e) =>
                          patch((d) => {
                            const servers = [...(d.mcp?.servers ?? [])];
                            servers[i] = { ...servers[i]!, name: e.target.value || undefined };
                            d.mcp = { servers };
                          })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    {tr("命令")}
                    <input
                      value={s.command}
                      placeholder={tr("例如 npx")}
                      onChange={(e) =>
                        patch((d) => {
                          const servers = [...(d.mcp?.servers ?? [])];
                          servers[i] = { ...servers[i]!, command: e.target.value };
                          d.mcp = { servers };
                        })
                      }
                    />
                  </label>
                  <label>
                    {tr("参数（空格分隔）")}
                    <input
                      value={(s.args ?? []).join(" ")}
                      placeholder="-y @modelcontextprotocol/server-filesystem ."
                      onChange={(e) =>
                        patch((d) => {
                          const servers = [...(d.mcp?.servers ?? [])];
                          servers[i] = {
                            ...servers[i]!,
                            args: e.target.value.trim() ? e.target.value.trim().split(/\s+/) : [],
                          };
                          d.mcp = { servers };
                        })
                      }
                    />
                  </label>
                  <div className="todo-actions">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={s.enabled !== false}
                        onChange={(e) =>
                          patch((d) => {
                            const servers = [...(d.mcp?.servers ?? [])];
                            servers[i] = { ...servers[i]!, enabled: e.target.checked };
                            d.mcp = { servers };
                          })
                        }
                      />
                      {tr("启用")}
                    </label>
                    <button
                      type="button"
                      className="ghost tiny"
                      onClick={() =>
                        patch((d) => {
                          d.mcp = {
                            servers: (d.mcp?.servers ?? []).filter((_, j) => j !== i),
                          };
                        })
                      }
                    >
                      {tr("删除")}
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  patch((d) => {
                    const n = (d.mcp?.servers?.length ?? 0) + 1;
                    d.mcp = {
                      servers: [
                        ...(d.mcp?.servers ?? []),
                        {
                          id: `server${n}`,
                          name: `MCP ${n}`,
                          command: "npx",
                          args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
                          enabled: true,
                        },
                      ],
                    };
                  })
                }
              >
                {tr("添加 MCP 服务器")}
              </button>
            </div>
          )}

          {tab === "secrets" && (
            <div className="form">
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.secrets?.enabled ?? true}
                  onChange={(e) =>
                    patch((d) => {
                      d.secrets = { ...d.secrets, enabled: e.target.checked };
                    })
                  }
                />
                {tr("启用敏感信息脱敏")}
              </label>
              <div className="security-scope-note">
                {tr("开启后，内建工具和 MCP 工具返回给大模型的文本都会经过敏感值脱敏；.env 等配置文件只遮罩账号、密码、令牌、密钥和连接凭据，普通配置仍可见。私钥、证书、加密凭据和数据库备份才会整体遮罩。")}
                {tr("配置保存后立即生效，安全相关用户设置优先于项目配置，项目不能静默关闭本机保护；脱敏只影响发送给模型的内容，不修改本地文件。")}
                <strong> {tr("注意：")}</strong>{tr("脱敏不是命令或第三方 MCP 的完整权限沙箱；可变更数据的 MCP 工具会要求确认，其服务器授权范围仍由本机 MCP 配置决定。")}
              </div>

              <SecurityRedactionTest />

              <h3>{tr("文件写入")}</h3>
              <p className="hint" style={{ marginTop: 4 }}>
                {tr("内建工具允许修改工作区内的文件，不再按文件类型、敏感文件、依赖目录或锁文件拦截写入。读取内容发送给大模型前仍会执行敏感信息脱敏；命令行中的潜在写入或删除操作仍会进入危险命令确认。")}
              </p>

              <h3>{tr("主流项目默认覆盖")}</h3>
              <p className="hint">{tr("以下类型使用同一份运行时默认清单，不再由界面单独维护：")}</p>
              <div className="security-coverage-grid">
                {SECURITY_STACK_COVERAGE.map((item) => (
                  <div className="security-coverage-item" key={item.name}>
                    <strong>{item.name}</strong>
                    <span>{item.files}</span>
                  </div>
                ))}
              </div>

              <h3>{tr("内置敏感文件规则")}</h3>
              <p className="hint">
                {tr("共 {{count}} 条受保护文件规则。.env*、Spring application*/bootstrap* 与 .NET appsettings* 使用敏感字段检测，端口、环境、日志级别等普通配置保持可见；私钥、JKS/keystore、加密凭据和数据库备份整体保护。", { count: BUILTIN_SENSITIVE_FILES.length })}
              </p>
              <div className="secrets-builtin-list">
                <code>{BUILTIN_SENSITIVE_FILES.join(", ")}</code>
              </div>

              <h3>{tr("内置敏感值检测规则")}</h3>
              <p className="hint">{tr("所有工具输出都会检测以下敏感值（只读展示，不可修改）：")}</p>
              <div className="secrets-builtin-list">
                <code>
                  {tr("OpenAI / Anthropic / AWS / GCP / HuggingFace / GitHub / GitLab / Slack / Stripe Token，")}
                  {tr("Bearer Token、JWT、PEM/OpenSSH 私钥、账号 / Username / Login、Password/Passwd/API Key/Secret/Token 字段、环境变量凭据，以及 MongoDB/PostgreSQL/MySQL/Redis/AMQP 连接字符串")}
                </code>
              </div>

              <h3>{tr("自定义敏感文件")}</h3>
              <p className="hint">{tr("添加额外的敏感文件 glob 模式（每行一个）：")}</p>
              <label>
                {tr("敏感文件模式")}
                <textarea
                  rows={4}
                  value={(draft.secrets?.sensitiveFiles ?? []).join("\n")}
                  placeholder={"config/production.json\n*.secret\nmy-custom-env.*"}
                  onChange={(e) =>
                    patch((d) => {
                      d.secrets = {
                        ...d.secrets,
                        sensitiveFiles: e.target.value
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      };
                    })
                  }
                />
              </label>

              <h3>{tr("自定义检测规则")}</h3>
              <p className="hint">
                {tr("添加额外正则表达式（每行一个）。无效表达式会被忽略，不会中断文件读取或关闭内置保护。")}
              </p>
              <label>
                {tr("检测规则（正则）")}
                <textarea
                  rows={4}
                  value={(draft.secrets?.patterns ?? []).join("\n")}
                  placeholder={"INTERNAL-\\d{8}-[A-Z]+\nmy_company_[A-Za-z0-9]{32}"}
                  onChange={(e) =>
                    patch((d) => {
                      d.secrets = {
                        ...d.secrets,
                        patterns: e.target.value
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      };
                    })
                  }
                />
              </label>
            </div>
          )}

          {tab === "rules" && (
            <RulesTab
              hasWorkspace={hasWorkspace}
              rules={rules}
              selectedRule={selectedRule}
              ruleBody={ruleBody}
              newRuleName={newRuleName}
              busy={busy}
              onOpenRule={(name) => void openRule(name)}
              onDeleteRule={() => void onDeleteRule()}
              onCreateRule={() => void onCreateRule()}
              onRuleBodyChange={(value) => {
                setRuleBody(value);
                setRuleDirty(true);
              }}
              onNewRuleNameChange={setNewRuleName}
            />
          )}

          {tab === "memories" && <MemoriesTab />}

          {tab === "skills" && <SkillsTab />}

          {tab === "restore" && (
            <div className="form">
              <p className="hint">{tr("清除当前项目的全部规则和偏好记忆，不影响项目源码、全局偏好、模型设置或 API Key。")}</p>
              <button type="button" className="danger" disabled={busy || !hasWorkspace} onClick={() => void onRestore()}>
                {tr("一键还原")}
              </button>
              {!hasWorkspace ? <p className="hint">{tr("请先打开工作区文件夹")}</p> : null}
            </div>
          )}
        </div>
        </div>

        <footer className="settings-footer">
          <span className="status">
            {status ||
              (tab === "rules"
                ? ruleDirty
                  ? tr("自动保存中…")
                  : tr("规则已自动保存")
                : busy || dirty
                  ? tr("自动保存中…")
                  : tr("已自动保存"))}
          </span>
        </footer>
      </div>
    </div>
  );
}
