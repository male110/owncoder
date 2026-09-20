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
import type { WritePolicy } from "@owncoder/shared";
import type { RuleFileDto, SettingsSnapshotDto, UserMemoryDto } from "../../preload/index";
import { BlurNumberInput } from "./components/BlurNumberInput";
import { SecurityRedactionTest } from "./components/SecurityRedactionTest";

export type TabId =
  | "models"
  | "context"
  | "index"
  | "harness"
  | "mcp"
  | "secrets"
  | "rules"
  | "memories"
  | "restore";

const TABS: { id: TabId; label: string; group?: string }[] = [
  { id: "models", label: "模型", group: "运转" },
  { id: "context", label: "上下文", group: "运转" },
  { id: "index", label: "索引", group: "运转" },
  { id: "harness", label: "执行", group: "运转" },
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
  const [tab, setTab] = useState<TabId>(initialTab ?? "models");

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
    const timer = setTimeout(() => void persistSettings(), 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // Don't clobber edits made while the async save was in flight.
      if (JSON.stringify(latestDraftRef.current) === savingJson) {
        setDraft(structuredClone(s.effective));
      }
      setStatus(`已自动保存（${s.fingerprint}）`);
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  const onRestore = async () => {
    if (!(await customConfirm("一键还原出厂设置？将删除用户工作流覆盖层，保留模型设置，不影响 API Key 环境变量与项目源码。"))) {
      return;
    }
    settingsRevisionRef.current += 1;
    setBusy(true);
    try {
      const s = await window.owncoder.restoreFactorySettings();
      setSnap(s);
      setDraft(structuredClone(s.effective));
      setStatus("已还原出厂配置（不含项目规则）");
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
      setStatus(`已自动保存规则：.owncoder/rules/${selectedRule}`);
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
        `# ${name.replace(/\.md$/i, "")}\n\n- 优先小范围补丁。\n- 遵循项目既有约定。\n`,
      );
      setNewRuleName("");
      await reloadRules();
      await openRule(name);
      setStatus(`已创建 ${name}`);
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDeleteRule = async () => {
    if (!selectedRule) return;
    if (!(await customConfirm(`删除 .owncoder/rules/${selectedRule}？`))) return;
    setBusy(true);
    try {
      await window.owncoder.deleteRule(selectedRule);
      setSelectedRule(null);
      setRuleBody("");
      setRuleDirty(false);
      await reloadRules();
      setStatus("已删除规则文件");
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
      aria-label="系统设置"
    >
      <div className="settings-modal">
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="工作流分区">
            <button type="button" className="settings-back" onClick={onClose}>
              ← 返回工作区
            </button>
            {TABS.map((t, i) => {
              const prev = TABS[i - 1];
              const showGroup = t.group && t.group !== prev?.group;
              return (
                <div key={t.id}>
                  {showGroup ? <div className="settings-nav-group">{t.group}</div> : null}
                  <button
                    type="button"
                    className={tab === t.id ? "active" : ""}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                </div>
              );
            })}
          </nav>

        <div className={`settings-body${tab === "models" ? " settings-body-models" : ""}`}>
          <div className="settings-body-head">
            <h2>{TABS.find((t) => t.id === tab)?.label}</h2>
          </div>
          {tab === "models" && <ModelTab draft={draft} patch={patch} />}

          {tab === "context" && (
            <div className="form">
              {/* Context Window + Input/Output Ratio (single group) */}
              <fieldset>
                <legend style={{ fontSize: "0.8em", fontWeight: 500 }}>上下文窗口</legend>
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
                    placeholder="自定义"
                    title="支持 K/M 后缀，如 512K、2M"
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
                  输入占比
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
                      输入 ≈{(draft.context.contextWindow * draft.context.inputRatio / 100).toLocaleString("zh-CN")} tokens · 输出 ≈{(draft.context.contextWindow * (100 - draft.context.inputRatio) / 100).toLocaleString("zh-CN")} tokens
                    </span>
                  </div>
                </label>
              </fieldset>

              {/* Segment Ratios */}
              <fieldset>
                <legend style={{ fontSize: "0.8em", fontWeight: 500 }}>输入预算段分配</legend>
                <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                  输入预算扣除系统提示、工具定义等固定段后，剩余空间按以下比例分配给三个动态段。
                </p>
                {([
                  { key: "historyRatio" as const, label: "对话历史", hint: "聊天记录与上下文" },
                  { key: "toolResultRatio" as const, label: "工具调用结果", hint: "工具返回给模型的内容，含代码检索结果" },
                  { key: "techStackRatio" as const, label: "技术栈信息", hint: "项目结构、依赖等" },
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
                  合计：{Math.round(
                    ((draft.context.segments?.historyRatio ?? 0.3)
                      + (draft.context.segments?.toolResultRatio ?? 0.65)
                      + (draft.context.segments?.techStackRatio ?? 0.05)) * 100,
                  )}%
                  {(() => {
                    const sum = (draft.context.segments?.historyRatio ?? 0.3)
                      + (draft.context.segments?.toolResultRatio ?? 0.65)
                      + (draft.context.segments?.techStackRatio ?? 0.05);
                    if (Math.abs(sum - 1) > 0.01) {
                      return <span style={{ color: "var(--danger, #e74c3c)", marginLeft: 8 }}>（建议合计 100%）</span>;
                    }
                    return null;
                  })()}
                </div>
              </fieldset>

            </div>
          )}

          {tab === "index" && (
            <div className="form">
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.index.enabled}
                  onChange={(e) =>
                    patch((d) => {
                      d.index.enabled = e.target.checked;
                    })
                  }
                />
                启用符号索引
              </label>
              <label>
                额外忽略（每行一条）
                <textarea
                  rows={6}
                  value={draft.index.extraIgnore.join("\n")}
                  onChange={(e) =>
                    patch((d) => {
                      d.index.extraIgnore = e.target.value
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean);
                    })
                  }
                />
              </label>
            </div>
          )}

          {tab === "harness" && (
            <div className="form">
              <label className="check">
                <input type="checkbox" checked disabled readOnly />
                优先打补丁（锁定，不可关闭）
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.harness.checkpoint}
                  onChange={(e) =>
                    patch((d) => {
                      d.harness.checkpoint = e.target.checked;
                    })
                  }
                />
                回合检查点
              </label>
              <label>
                工具输出最大字符数
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
            </div>
          )}

          {tab === "mcp" && (
            <div className="form">
              <p className="hint">
                通过 stdio 连接 MCP 服务器。工具名形如 <code>mcp__id__tool</code>，保存后自动连接。
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
                      显示名
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
                    命令
                    <input
                      value={s.command}
                      placeholder="例如 npx"
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
                    参数（空格分隔）
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
                      启用
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
                      删除
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
                添加 MCP 服务器
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
                启用敏感信息脱敏
              </label>
              <div className="security-scope-note">
                开启后，内建工具和 MCP 工具返回给大模型的文本都会经过敏感值脱敏；.env 等配置文件只遮罩账号、密码、令牌、密钥和连接凭据，普通配置仍可见。私钥、证书、加密凭据和数据库备份才会整体遮罩。
                配置保存后立即生效，安全相关用户设置优先于项目配置，项目不能静默关闭本机保护；脱敏只影响发送给模型的内容，不修改本地文件。
                <strong> 注意：</strong>脱敏不是命令或第三方 MCP 的完整权限沙箱；可变更数据的 MCP 工具会要求确认，其服务器授权范围仍由本机 MCP 配置决定。
              </div>

              <SecurityRedactionTest />

              <h3>文件写入保护</h3>
              <label>
                可写策略
                <select
                  value={draft.context.writePolicy}
                  onChange={(e) =>
                    patch((d) => {
                      d.context.writePolicy = e.target.value as WritePolicy;
                    })
                  }
                >
                  <option value="loose">宽松（仅保留核心敏感文件保护）</option>
                  <option value="balanced">均衡（推荐：保护密钥、依赖、构建产物和锁文件）</option>
                  <option value="strict">严格（仅允许主流源码与配置文件）</option>
                </select>
              </label>
              <p className="hint" style={{ marginTop: 4 }}>
                {draft.context.writePolicy === "balanced" && "保护敏感文件（.env、密钥）、锁文件（package-lock、yarn.lock）和构建产物目录（dist、build），其余文件可写入。"}
                {draft.context.writePolicy === "strict" && "仅允许主流源码和配置文件扩展名（.ts/.py/.go/.rs/.json/.yaml 等），其他类型文件一律拒绝写入。"}
                {draft.context.writePolicy === "loose" && "只保留核心安全防护（.git、node_modules、.owncoder 元数据不可写），其余文件均放行。"}
              </p>
              <p className="hint" style={{ marginTop: 2 }}>
                该策略约束内建文件写入工具；Agent 命令中的潜在写入/删除操作仍会进入危险命令确认。
                严格模式已覆盖 Java/Spring、Kotlin、Maven/Gradle、Node.js、Python、Go、Rust、.NET、PHP、Ruby、移动端、Shell、SQL、GraphQL、Protobuf 及常见前端框架。
              </p>

              <h3>主流项目默认覆盖</h3>
              <p className="hint">以下类型使用同一份运行时默认清单，不再由界面单独维护：</p>
              <div className="security-coverage-grid">
                {SECURITY_STACK_COVERAGE.map((item) => (
                  <div className="security-coverage-item" key={item.name}>
                    <strong>{item.name}</strong>
                    <span>{item.files}</span>
                  </div>
                ))}
              </div>

              <h3>内置敏感文件规则</h3>
              <p className="hint">
                共 {BUILTIN_SENSITIVE_FILES.length} 条受保护文件规则。.env*、Spring application*/bootstrap* 与 .NET appsettings* 使用敏感字段检测，端口、环境、日志级别等普通配置保持可见；私钥、JKS/keystore、加密凭据和数据库备份整体保护。
              </p>
              <div className="secrets-builtin-list">
                <code>{BUILTIN_SENSITIVE_FILES.join(", ")}</code>
              </div>

              <h3>内置敏感值检测规则</h3>
              <p className="hint">所有工具输出都会检测以下敏感值（只读展示，不可修改）：</p>
              <div className="secrets-builtin-list">
                <code>
                  OpenAI / Anthropic / AWS / GCP / HuggingFace / GitHub / GitLab / Slack / Stripe Token，
                  Bearer Token、JWT、PEM/OpenSSH 私钥、账号 / Username / Login、Password/Passwd/API Key/Secret/Token 字段、
                  环境变量凭据，以及 MongoDB/PostgreSQL/MySQL/Redis/AMQP 连接字符串
                </code>
              </div>

              <h3>自定义敏感文件</h3>
              <p className="hint">添加额外的敏感文件 glob 模式（每行一个）：</p>
              <label>
                敏感文件模式
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

              <h3>自定义检测规则</h3>
              <p className="hint">
                添加额外正则表达式（每行一个）。无效表达式会被忽略，不会中断文件读取或关闭内置保护。
              </p>
              <label>
                检测规则（正则）
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
                项目级规则存于 <code>.owncoder/rules/*.md</code>，按文件名排序合并后注入
                系统提示（有预算截断）。不属于用户工作流，一键还原不会删除。
              </p>
              {!hasWorkspace ? (
                <p className="hint">请先打开工作区文件夹。</p>
              ) : (
                <>
                  <div className="rules-layout">
                    <div className="rules-list">
                      {rules.length === 0 ? (
                        <p className="hint">暂无规则文件</p>
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
                              删除
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
                        <p className="hint">选择左侧文件，或新建规则。</p>
                      )}
                    </div>
                  </div>
                  <div className="todo-actions">
                    <input
                      value={newRuleName}
                      placeholder="新规则.md"
                      onChange={(e) => setNewRuleName(e.target.value)}
                      style={{ flex: 1, minWidth: 120 }}
                    />
                    <button type="button" className="ghost" disabled={busy} onClick={() => void onCreateRule()}>
                      新建
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "memories" && <MemoriesTab />}

          {tab === "restore" && (
            <div className="form">
              <p>
                指纹：<code>{snap.fingerprint}</code>
                {snap.matchesBuiltin ? "（与出厂一致）" : "（已有用户覆盖）"}
              </p>
              <p className="mono">工作流：{snap.paths.userWorkflow}</p>
              <p className="mono">模型设置：{snap.paths.userModels}</p>
              <button type="button" className="danger" disabled={busy} onClick={() => void onRestore()}>
                一键还原出厂
              </button>
              <p className="hint">删除用户工作流覆盖；保留模型设置与 API Key，不改项目源码与规则。</p>
            </div>
          )}
        </div>
        </div>

        <footer className="settings-footer">
          <span className="status">
            {status ||
              (tab === "rules"
                ? ruleDirty
                  ? "自动保存中…"
                  : "规则已自动保存"
                : busy || dirty
                  ? "自动保存中…"
                  : "已自动保存")}
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
}: {
  draft: SystemWorkflowConfig;
  patch: (fn: (d: SystemWorkflowConfig) => void) => void;
}) {
  const providers = draft.providers ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

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
        <div className="model-provider-list-head">自定义平台</div>
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
                title={`已启用 ${enabledCount} 个模型`}
              />
            </button>
          );
        })}
        <button
          type="button"
          className={`model-provider-item add ${adding ? "active" : ""}`}
          onClick={() => setAdding(true)}
        >
          + 添加平台
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
            <p className="hint">暂无平台配置，点击左侧「添加平台」开始。</p>
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
  const [apiFormat, setApiFormat] = useState<ApiFormat>(provider.apiFormat ?? "openai-chat");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [manualModelId, setManualModelId] = useState("");
  const [listMode, setListMode] = useState<"add" | "search">("add");
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const modelListInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setApiKey(provider.apiKey);
    setApiFormat(provider.apiFormat ?? "openai-chat");
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
        setFetchError(result.error ?? "未知错误");
        return;
      }
      const models = (result.models ?? []).map((m: { id: string; name: string }) => ({
        id: `${provider.id}_${m.id}`,
        name: m.name || m.id,
      }));
      patch((d) => {
        const idx = (d.providers ?? []).findIndex((p) => p.id === provider.id);
        if (idx >= 0) d.providers![idx]!.models = models;
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
          d.selectedModels = (d.selectedModels ?? []).filter((m) => m.id !== model.id);
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
    const modelId = `${provider.id}_${raw}`;
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
        d.selectedModels = (d.selectedModels ?? []).filter((m) => m.id !== modelId);
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
            placeholder="平台名称"
            onChange={(e) => {
              setName(e.target.value);
              syncProvider("name", e.target.value);
            }}
          />
          <span className={`model-status-badge ${enabledCount > 0 ? "on" : ""}`}>
            {enabledCount > 0 ? `已启用 ${enabledCount}` : "未启用"}
          </span>
        </div>
        <button type="button" className="ghost small danger" onClick={removeProvider}>
          删除
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
        API 协议
        <select
          value={apiFormat}
          onChange={(e) => {
            const next = e.target.value as ApiFormat;
            setApiFormat(next);
            syncProvider("apiFormat", next);
          }}
        >
          <option value="openai-chat">OpenAI Chat Completions</option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
        <span className="hint">协议与 Base URL 独立：自建或代理端点也可选 Anthropic Messages。</span>
      </label>

      <label className="model-detail-field">
        API Key
        <div className="api-key-row">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            placeholder="sk-...（本地可留空）"
            autoComplete="off"
            onChange={(e) => {
              setApiKey(e.target.value);
              syncProvider("apiKey", e.target.value);
            }}
          />
          <button type="button" className="ghost tiny" onClick={() => setShowKey((s) => !s)}>
            {showKey ? "隐藏" : "显示"}
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
          {fetching ? "获取中..." : "获取模型列表"}
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
          模型列表
          {listMode === "search" && (
            <span className="model-list-mode-hint">按 Esc 退出搜索</span>
          )}
        </div>
        <div className="model-manual-add">
          {listMode === "add" ? (
            <>
              <input
                ref={modelListInputRef}
                value={manualModelId}
                placeholder="手动输入模型 ID，如 gpt-4o、deepseek-chat（Ctrl+F 搜索）"
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
                添加
              </button>
            </>
          ) : (
            <input
              ref={modelListInputRef}
              value={modelSearchQuery}
              placeholder="模糊搜索模型名称或 ID…"
              onChange={(e) => setModelSearchQuery(e.target.value)}
              aria-label="搜索模型"
            />
          )}
        </div>
        {provider.models.length === 0 ? (
          <p className="hint">点击「获取模型列表」拉取，或在上方手动输入模型 ID 后添加</p>
        ) : filteredModels.length === 0 ? (
          <p className="hint">无匹配模型</p>
        ) : (
          filteredModels.map((m) => {
            const isSelected = selectedModels.some((s) => s.id === m.id);
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
                  title="移除该模型"
                  onClick={() => removeModel(m.id)}
                >
                  删除
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

  const fetchAndAdd = useCallback(async () => {
    if (!baseUrl.trim()) return;
    setFetching(true);
    setFetchError("");
    try {
      const providerId = `provider_${Date.now().toString(36)}`;
      const result = await window.owncoder.fetchModelList(baseUrl, apiKey || undefined, apiFormat);
      if (!result.ok) {
        setFetchError(result.error ?? "未知错误");
        return;
      }
      const models = (result.models ?? []).map((m: { id: string; name: string }) => ({
        id: `${providerId}_${m.id}`,
        name: m.name || m.id,
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
        <div className="model-detail-title">添加平台</div>
      </div>

      <label className="model-detail-field">
        平台名称
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
        API 协议
        <select value={apiFormat} onChange={(e) => setApiFormat(e.target.value as ApiFormat)}>
          <option value="openai-chat">OpenAI Chat Completions</option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
        <span className="hint">协议与 Base URL 独立：自建或代理端点也可选 Anthropic Messages。</span>
      </label>

      <label className="model-detail-field">
        API Key
        <div className="api-key-row">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            placeholder="sk-...（本地可留空）"
            autoComplete="off"
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button type="button" className="ghost tiny" onClick={() => setShowKey((s) => !s)}>
            {showKey ? "隐藏" : "显示"}
          </button>
        </div>
      </label>

      {fetchError && <p className="error-text">{fetchError}</p>}

      <p className="hint" style={{ margin: "4px 0 10px" }}>
        「获取并添加」将调用 /v1/models 拉取模型列表；若端点不可用或想稍后手动添加模型，请用「直接添加」。
      </p>

      <div className="model-detail-actions">
        <button
          type="button"
          className="primary small"
          disabled={fetching || !baseUrl.trim()}
          onClick={() => void fetchAndAdd()}
        >
          {fetching ? "获取中..." : "获取并添加"}
        </button>
        <button
          type="button"
          className="ghost small"
          disabled={!baseUrl.trim()}
          onClick={addDirect}
        >
          直接添加
        </button>
        <button type="button" className="ghost small" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

// ── Memories Tab Component ──────────────────────────────────

function MemoriesTab() {
  const [globalMemories, setGlobalMemories] = useState<UserMemoryDto[]>([]);
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
    if (!(await customConfirm("删除此偏好记忆？"))) return;
    await window.owncoder.deleteMemory(id, scope);
    await reload();
  };

  const showForm = addingScope !== null || editing !== null;

  const renderList = (items: UserMemoryDto[], scope: string) => (
    <div className="memories-list">
      {items.length === 0 ? (
        <p className="hint">暂无{scope === "global" ? "全局" : "项目"}偏好记忆</p>
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
                  编辑
                </button>
                <button type="button" className="ghost tiny danger" onClick={() => void deleteMemory(m.id, scope)}>
                  删除
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
        模型在对话中识别到持久偏好时会主动调用 save_memory 工具保存到这里。
        全局偏好跨项目生效，项目偏好仅在当前工作区生效。
      </p>

      {showForm ? (
        <div className="memories-form">
          <p className="hint-inline">
            {addingScope ? `添加${addingScope === "global" ? "全局" : "项目"}偏好` : `编辑${editing?.scope === "global" ? "全局" : "项目"}偏好`}
          </p>
          <label>
            标题
            <input
              value={form.title}
              placeholder="例如：使用中文回复"
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
          </label>
          <label>
            内容
            <textarea
              rows={4}
              value={form.content}
              placeholder="偏好的详细描述"
              onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
            />
          </label>
          <label>
            分类
            <input
              value={form.category}
              placeholder="general"
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            />
          </label>
          <label>
            关键词（逗号分隔）
            <input
              value={form.keywords}
              placeholder="中文, 语言, 回复"
              onChange={(e) => setForm((f) => ({ ...f, keywords: e.target.value }))}
            />
          </label>
          <div className="todo-actions">
            <button type="button" className="ghost" onClick={() => void saveForm()}>
              {editing ? "保存" : "添加"}
            </button>
            <button type="button" className="ghost" onClick={cancelForm}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      <h3>全局偏好</h3>
      {renderList(globalMemories, "global")}
      {!showForm ? (
        <button type="button" className="ghost" onClick={() => startAdd("global")}>
          + 添加全局偏好
        </button>
      ) : null}

      <h3 style={{ marginTop: "1.5em" }}>当前项目偏好</h3>
      {!hasWorkspace ? (
        <p className="hint">请先打开工作区文件夹</p>
      ) : (
        <>
          {renderList(projectMemories, "project")}
          {!showForm ? (
            <button type="button" className="ghost" onClick={() => startAdd("project")}>
              + 添加项目偏好
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
