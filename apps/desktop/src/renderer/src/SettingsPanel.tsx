import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { customConfirm } from "./utils/customConfirm";
import {
  materializeEnglishPrompts,
  BUILTIN_SENSITIVE_FILES,
  SECURITY_STACK_COVERAGE,
  type SystemWorkflowConfig,
  type Provider,
  type AvailableModel,
  type ApiFormat,
} from "@owncoder/settings";

import type { RuleFileDto, SettingsSnapshotDto, UserMemoryDto } from "../../preload/index";
import { BlurNumberInput } from "./components/BlurNumberInput";
import { SecurityRedactionTest } from "./components/SecurityRedactionTest";
import type { LocalePref, MsgId } from "../../shared/i18n/core";
import { setLocalePref, useI18n } from "./i18n";

export type TabId =
  | "harness"
  | "models"
  | "context"
  | "mcp"
  | "secrets"
  | "rules"
  | "memories"
  | "restore";

const TABS: { id: TabId; label: MsgId; group?: MsgId }[] = [
  { id: "harness", label: "常规设置", group: "运转" },
  { id: "models", label: "模型", group: "运转" },
  { id: "context", label: "上下文", group: "运转" },
  { id: "mcp", label: "MCP", group: "运转" },
  { id: "secrets", label: "安全", group: "运转" },
  { id: "rules", label: "规则", group: "项目" },
  { id: "memories", label: "偏好记忆", group: "项目" },
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
      // Chinese UI edits → English runtime prompts before persist
      const ready = await materializeEnglishPrompts(
        savingDraft,
        (text, target) => window.owncoder.translatePrompt(text, target),
        snap.effective,
      );
      if (revision !== settingsRevisionRef.current) return;
      const s = await window.owncoder.saveSettings(ready);
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
              <label>
                <input
                  type="checkbox"
                  checked={draft.harness.separateStageModels ?? false}
                  onChange={(e) =>
                    patch((d) => {
                      const enabling = e.target.checked;
                      d.harness.separateStageModels = enabling;
                      
                      if (enabling) {
                        // 启用执行阶段单独配置：从统一配置迁移
                        const unifiedModel = draft.selectedModels?.[0]?.id;
                        const unifiedEffort = draft.thinking?.defaultEffort ?? "high";
                        
                        // 只在 reactModel 为空时才迁移
                        if (!d.harness.reactModel && unifiedModel) {
                          d.harness.reactModel = unifiedModel;
                        }
                        if (!d.harness.reactThinkingEffort) {
                          d.harness.reactThinkingEffort = unifiedEffort;
                        }
                      } else {
                        // 禁用执行阶段单独配置：回退到统一配置
                        const fallbackModel = d.harness.reactModel;
                        const fallbackEffort = d.harness.reactThinkingEffort || "high";
                        
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
            <div className="form rules-form">
              <p className="hint">
                {tr("项目级规则存于 ")}<code>.owncoder/rules/*.md</code>{tr("，按文件名排序合并后注入系统提示（有预算截断）。不属于用户工作流，一键还原不会删除。")}
              </p>
              {!hasWorkspace ? (
                <p className="hint">{tr("请先打开工作区文件夹。")}</p>
              ) : (
                <>
                  <div className="rules-layout">
                    <div className="rules-list">
                      {rules.length === 0 ? (
                        <p className="hint">{tr("暂无规则文件")}</p>
                      ) : (
                        rules.map((r) => (
                          <button
                            key={r.name}
                            type="button"
                            className={selectedRule === r.name ? "rule-item active" : "rule-item"}
                            onClick={() => void openRule(r.name)}
                          >
                            {r.name}
                          </button>
                        ))
                      )}
                    </div>
                    <div className="rules-editor">
                      {selectedRule ? (
                        <>
                          <div className="prompt-toolbar">
                            <strong>{selectedRule}</strong>
                            <button type="button" className="ghost" disabled={busy} onClick={() => void onDeleteRule()}>
                              {tr("删除")}
                            </button>
                          </div>
                          <textarea
                            rows={14}
                            value={ruleBody}
                            onChange={(e) => {
                              setRuleBody(e.target.value);
                              setRuleDirty(true);
                            }}
                          />
                        </>
                      ) : (
                        <p className="hint">{tr("选择左侧文件，或新建规则。")}</p>
                      )}
                    </div>
                  </div>
                  <div className="todo-actions">
                    <input
                      value={newRuleName}
                      placeholder={tr("新规则.md")}
                      onChange={(e) => setNewRuleName(e.target.value)}
                      style={{ flex: 1, minWidth: 120 }}
                    />
                    <button type="button" className="ghost" disabled={busy} onClick={() => void onCreateRule()}>
                      {tr("新建")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "memories" && <MemoriesTab />}

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

// ── Model Tab Component ─────────────────────────────────────

function ModelTab({
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

// ── Provider Detail (right panel) ───────────────────────────

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

function ProviderDetail({
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

// ── New Provider Form (right panel) ─────────────────────────

function NewProviderForm({
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
      const models = (result.models ?? []).map((m: { id: string; name: string }) => ({
        id: m.id,
        name: m.name || m.id,
        providerId: providerId,
      }));
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

// ── Memories Tab Component ──────────────────────────────────

function MemoriesTab() {
  const [globalMemories, setGlobalMemories] = useState<UserMemoryDto[]>([]);
  const { t: tr } = useI18n();
  const [projectMemories, setProjectMemories] = useState<UserMemoryDto[]>([]);
  const [editing, setEditing] = useState<{ memory: UserMemoryDto; scope: string } | null>(null);
  const [addingScope, setAddingScope] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", content: "", category: "general", keywords: "" });
  const [hasWorkspace, setHasWorkspace] = useState(false);

  const reload = useCallback(async () => {
    const ws = await window.owncoder.getWorkspace();
    setHasWorkspace(Boolean(ws));
    const g = await window.owncoder.listMemories("global");
    setGlobalMemories(g);
    const p = ws ? await window.owncoder.listMemories("project") : [];
    setProjectMemories(p);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const startAdd = (scope: string) => {
    setForm({ title: "", content: "", category: "general", keywords: "" });
    setEditing(null);
    setAddingScope(scope);
  };

  const startEdit = (m: UserMemoryDto, scope: string) => {
    setForm({
      title: m.title,
      content: m.content,
      category: m.category,
      keywords: m.keywords.join(", "),
    });
    setEditing({ memory: m, scope });
    setAddingScope(null);
  };

  const cancelForm = () => {
    setAddingScope(null);
    setEditing(null);
  };

  const activeScope = addingScope ?? editing?.scope ?? "global";

  const saveForm = async () => {
    if (!form.title.trim() || !form.content.trim()) return;
    const keywords = form.keywords
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const scope = activeScope;
    if (editing) {
      await window.owncoder.updateMemory(editing.memory.id, {
        title: form.title.trim(),
        content: form.content.trim(),
        category: form.category.trim() || "general",
        keywords,
      }, scope);
    } else {
      await window.owncoder.addMemory({
        title: form.title.trim(),
        content: form.content.trim(),
        category: form.category.trim() || "general",
        keywords,
      }, scope);
    }
    cancelForm();
    await reload();
  };

  const deleteMemory = async (id: string, scope: string) => {
    if (!(await customConfirm(tr("删除此偏好记忆？")))) return;
    await window.owncoder.deleteMemory(id, scope);
    await reload();
  };

  const showForm = addingScope !== null || editing !== null;

  const renderList = (items: UserMemoryDto[], scope: string) => (
    <div className="memories-list">
      {items.length === 0 ? (
        <p className="hint">{scope === "global" ? tr("暂无全局偏好记忆") : tr("暂无项目偏好记忆")}</p>
      ) : (
        items.map((m) => (
          <div key={m.id} className="memory-item">
            <div className="memory-item-head">
              <strong>{m.title}</strong>
              <span className="memory-item-category">{m.category}</span>
            </div>
            <p className="memory-item-content">{m.content}</p>
            <div className="memory-item-footer">
              <span className="hint">{new Date(m.updatedAt).toLocaleString()}</span>
              <div className="memory-item-actions">
                <button type="button" className="ghost tiny" onClick={() => startEdit(m, scope)}>
                  {tr("编辑")}
                </button>
                <button type="button" className="ghost tiny danger" onClick={() => void deleteMemory(m.id, scope)}>
                  {tr("删除")}
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );

  return (
    <div className="form">
      <p className="hint">
        {tr("模型在对话中识别到持久偏好时会主动调用 save_memory 工具保存到这里。")}
        {tr("全局偏好跨项目生效，项目偏好仅在当前工作区生效。")}
      </p>

      {showForm ? (
        <div className="memories-form">
          <p className="hint-inline">
            {addingScope ? (addingScope === "global" ? tr("添加全局偏好") : tr("添加项目偏好")) : (editing?.scope === "global" ? tr("编辑全局偏好") : tr("编辑项目偏好"))}
          </p>
          <label>
            {tr("标题")}
            <input
              value={form.title}
              placeholder={tr("例如：使用中文回复")}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
          </label>
          <label>
            {tr("内容")}
            <textarea
              rows={4}
              value={form.content}
              placeholder={tr("偏好的详细描述")}
              onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
            />
          </label>
          <label>
            {tr("分类")}
            <input
              value={form.category}
              placeholder="general"
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            />
          </label>
          <label>
            {tr("关键词（逗号分隔）")}
            <input
              value={form.keywords}
              placeholder={tr("中文, 语言, 回复")}
              onChange={(e) => setForm((f) => ({ ...f, keywords: e.target.value }))}
            />
          </label>
          <div className="todo-actions">
            <button type="button" className="ghost" onClick={() => void saveForm()}>
              {editing ? tr("保存") : tr("添加")}
            </button>
            <button type="button" className="ghost" onClick={cancelForm}>
              {tr("取消")}
            </button>
          </div>
        </div>
      ) : null}

      <h3>{tr("全局偏好")}</h3>
      {renderList(globalMemories, "global")}
      {!showForm ? (
        <button type="button" className="ghost" onClick={() => startAdd("global")}>
          {tr("+ 添加全局偏好")}
        </button>
      ) : null}

      <h3 style={{ marginTop: "1.5em" }}>{tr("当前项目偏好")}</h3>
      {!hasWorkspace ? (
        <p className="hint">{tr("请先打开工作区文件夹")}</p>
      ) : (
        <>
          {renderList(projectMemories, "project")}
          {!showForm ? (
            <button type="button" className="ghost" onClick={() => startAdd("project")}>
              {tr("+ 添加项目偏好")}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
