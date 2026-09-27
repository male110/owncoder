import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentMode } from "@owncoder/shared";
import type { AvailableModel, Provider, ThinkingEffort } from "@owncoder/settings";
import type { GitStatusDto, ProjectDto, ChatAttachmentDto } from "../../../preload/index";
import { useI18n } from "../i18n";

interface Props {
  mode: AgentMode;
  activeSessionId: string | null;
  draft: string;
  sending: boolean;
  queueCount: number;
  modelLabel: string;
  availableModels: AvailableModel[];
  providers: Provider[];
  thinkingEffort: ThinkingEffort;
  
  /** 执行阶段单独配置 */
  separateStageModels: boolean;
  reactModelId: string | null;
  reactThinkingEffort: ThinkingEffort;

  workspaceName: string | null;
  workspaceRoot: string | null;
  projects: ProjectDto[];
  gitStatus: GitStatusDto | null;
  isEmptySession: boolean;
  pendingNewSession: boolean;
  modeMenuOpen: boolean;
  onDraft: (v: string) => void;
  onSend: (attachments?: ChatAttachmentDto[]) => void;
  onCancel: () => void;
  onNewSession: () => void;
  onMode: (mode: AgentMode) => void;
  onModeMenuOpen: (open: boolean) => void;
  onSelectModel: (modelId: string, providerId: string) => void;
  onOpenSettings: () => void;
  onSelectThinkingEffort: (effort: ThinkingEffort) => void;
  onSelectProject: (root: string, focusSessionId?: string) => Promise<void>;
  onAddProject: () => void;
  onRemoveQueueMessage: (index: number) => void;
  onSelectReactModel: (modelName: string, providerId: string) => void;
  onSelectReactThinkingEffort: (effort: ThinkingEffort) => void;
}

function ComposerImpl({
  mode,
  activeSessionId,
  draft,
  sending,
  queueCount,
  modelLabel,
  availableModels,
  providers,
  thinkingEffort,
  
  separateStageModels,
  reactModelId,
  reactThinkingEffort,

  workspaceName,
  workspaceRoot,
  projects,
  gitStatus,
  isEmptySession,
  pendingNewSession,
  modeMenuOpen,
  onDraft,
  onSend,
  onCancel,
  onNewSession,
  onMode,
  onModeMenuOpen,
  onSelectModel,
  onOpenSettings,
  onSelectThinkingEffort,
  onSelectProject,
  onAddProject,
  onRemoveQueueMessage,
  onSelectReactModel,
  onSelectReactThinkingEffort,
}: Props) {
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const wsMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const reactMenuRef = useRef<HTMLDivElement | null>(null);
  const thinkingMenuRef = useRef<HTMLDivElement | null>(null);
  const reactThinkingMenuRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const prevSessionIdRef = useRef<string | null>(activeSessionId);
  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    // 先清除旧高度再读取 scrollHeight，确保删除内容后也能回缩。
    el.style.height = "auto";
    const minHeight = 72;
    const maxHeight = 240;
    const nextHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    autoResizeTextarea();
    window.addEventListener("resize", autoResizeTextarea);
    return () => window.removeEventListener("resize", autoResizeTextarea);
  }, [autoResizeTextarea, draft]);
  const didMountRef = useRef(false);
  const { t } = useI18n();

  // Re-focus the textarea whenever the active session changes (new / delete /
  // switch). Focusing on activeSessionId — instead of a one-shot window event
  // fired right after the async session op — is deterministic: by the time this
  // effect runs, React has already committed the render that updated `draft` and
  // the session list, so the textarea is the current one and ready for focus.
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      prevSessionIdRef.current = activeSessionId;
      return;
    }
    if (prevSessionIdRef.current === activeSessionId) return;
    prevSessionIdRef.current = activeSessionId;

    // Focus immediately, then again on the next frame in case a later store
    // update re-renders and displaces focus.
    textareaRef.current?.focus();
    const raf = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [activeSessionId]);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [reactMenuOpen, setReactMenuOpen] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [selectedReactProviderId, setSelectedReactProviderId] = useState<string | null>(null);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [reactThinkingMenuOpen, setReactThinkingMenuOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [projectSwitching, setProjectSwitching] = useState(false);
  const [mentionStart, setMentionStart] = useState(0);
  const [mentionHits, setMentionHits] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachments] = useState<Array<{ file: File; status: "uploading" | "error" | "success"; result?: ChatAttachmentDto; error?: string }>>([]);
  const uploadStatus = attachments.some((item) => item.status === "uploading")
    ? "uploading"
    : attachments.some((item) => item.status === "error")
      ? "error"
      : attachments.length > 0
        ? "success"
        : "idle";

  const uploadFile = useCallback(async (file: File) => {
    setAttachments((items) => [...items, { file, status: "uploading" }]);
    try {
      // 获取当前选中模型的协议类型
      const currentModel = availableModels[0];
      const currentProvider = providers.find((p) => p.id === currentModel?.providerId);
      const isAnthropicProtocol = currentProvider?.apiFormat === "anthropic-messages";

      let attachment: ChatAttachmentDto;

      if (isAnthropicProtocol) {
        // Anthropic 协议：转 base64
        const arrayBuffer = await file.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        );
        const dataUrl = `data:${file.type || "application/octet-stream"};base64,${base64}`;
        attachment = {
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          url: dataUrl,
          size: file.size,
        };
      } else {
        // 非 Anthropic 协议：上传图片
        const data = new Uint8Array(await file.arrayBuffer());
        const result = await window.owncoder.uploadFile({ name: file.name, type: file.type, data, provider: "uguu" });
        attachment = {
          name: result.name || file.name,
          mimeType: file.type || "application/octet-stream",
          url: result.url,
          size: result.size,
        };
      }

      setAttachments((items) => items.map((item) => item.file === file ? { ...item, status: "success", result: attachment } : item));
    } catch (error) {
      setAttachments((items) => items.map((item) => item.file === file ? { ...item, status: "error", error: error instanceof Error ? error.message : "上传失败，请重试" } : item));
    }
  }, [availableModels, providers]);

  const onFileSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    for (const file of files) void uploadFile(file);
  }, [uploadFile]);
  
  // 超时保护：防止 projectSwitching 异常卡死导致 UI 永久禁用
  useEffect(() => {
    if (!projectSwitching) return;
    const timeout = setTimeout(() => {
      console.warn('[Composer] projectSwitching 超时，强制重置');
      setProjectSwitching(false);
    }, 15000);
    return () => clearTimeout(timeout);
  }, [projectSwitching]);

  const groupedModels = useMemo(() => {
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
          const byName = a.name.localeCompare(b.name);
          return byName !== 0 ? byName : a.id.localeCompare(b.id);
        }),
      };
    });
  }, [availableModels, providers]);

  useEffect(() => {
    if (!modeMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!modeMenuRef.current?.contains(e.target as Node)) onModeMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onModeMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [modeMenuOpen, onModeMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    // 展开时直接显示第一个平台的模型，避免模型仅在悬停平台后才出现。
    setSelectedProviderId(groupedModels[0]?.providerId ?? null);
    const onDoc = (e: MouseEvent) => {
      if (!modelMenuRef.current?.contains(e.target as Node)) setModelMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [modelMenuOpen, groupedModels]);

  useEffect(() => {
    if (!wsMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!wsMenuRef.current?.contains(e.target as Node)) setWsMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [wsMenuOpen]);

  useEffect(() => {
    if (!reactMenuOpen) return;
    setSelectedReactProviderId(groupedModels[0]?.providerId ?? null);
    const onDoc = (e: MouseEvent) => {
      if (!reactMenuRef.current?.contains(e.target as Node)) setReactMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setReactMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [reactMenuOpen, groupedModels]);

  useEffect(() => {
    if (!thinkingMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!thinkingMenuRef.current?.contains(e.target as Node)) setThinkingMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setThinkingMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [thinkingMenuOpen]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onDown = (e: MouseEvent) => {
      if (!ctxMenuRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [ctxMenu]);

  useEffect(() => {
    if (mentionQuery === null) {
      setMentionHits([]);
      return;
    }
    let cancelled = false;
    void window.owncoder.searchWorkspaceFiles(mentionQuery).then((hits) => {
      if (!cancelled) {
        setMentionHits(hits);
        setMentionIndex(0);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [mentionQuery]);

  const syncMention = useCallback((value: string, cursor: number) => {
    const before = value.slice(0, cursor);
    const match = before.match(/@([^\s@]*)$/);
    if (match) {
      setMentionQuery(match[1] ?? "");
      setMentionStart(cursor - match[0].length);
    } else {
      setMentionQuery(null);
    }
  }, []);

  const insertMention = useCallback(
    (path: string) => {
      const el = textareaRef.current;
      const cursor = el?.selectionStart ?? draft.length;
      const token = `@${path} `;
      const next = `${draft.slice(0, mentionStart)}${token}${draft.slice(cursor)}`;
      onDraft(next);
      setMentionQuery(null);
      requestAnimationFrame(() => {
        const pos = mentionStart + token.length;
        el?.focus();
        el?.setSelectionRange(pos, pos);
      });
    },
    [draft, mentionStart, onDraft],
  );

  // 输入框右键菜单：菜单尺寸近似值，用于把菜单收进视口内
  const openCtxMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const el = textareaRef.current;
    const hasSelection = !!el && el.selectionStart !== el.selectionEnd;
    const menuW = 190;
    const menuH = 150;
    const x = Math.max(4, Math.min(e.clientX, window.innerWidth - menuW - 8));
    const y = Math.max(4, Math.min(e.clientY, window.innerHeight - menuH - 8));
    setCtxMenu({ x, y, hasSelection });
  }, []);

  const execCtxAction = useCallback(
    (action: "cut" | "copy" | "paste" | "selectAll") => {
      const el = textareaRef.current;
      if (!el) return;
      const start = el.selectionStart ?? draft.length;
      const end = el.selectionEnd ?? draft.length;
      if (action === "selectAll") {
        el.focus();
        el.setSelectionRange(0, draft.length);
      } else if (action === "copy" || action === "cut") {
        if (start === end) return;
        void navigator.clipboard.writeText(draft.slice(start, end)).catch(() => {});
        if (action === "cut") {
          const next = `${draft.slice(0, start)}${draft.slice(end)}`;
          onDraft(next);
          requestAnimationFrame(() => {
            el.focus();
            el.setSelectionRange(start, start);
          });
        }
      } else {
        // 粘贴走剪贴板 API，与受控 draft 状态保持一致；失败时退回到 execCommand
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (!text) return;
            const next = `${draft.slice(0, start)}${text}${draft.slice(end)}`;
            onDraft(next);
            const pos = start + text.length;
            requestAnimationFrame(() => {
              el.focus();
              el.setSelectionRange(pos, pos);
            });
          })
          .catch(() => {
            el.focus();
            el.setSelectionRange(start, end);
            document.execCommand("paste");
          });
      }
      setCtxMenu(null);
    },
    [draft, onDraft],
  );

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        console.log("[Composer] form submitted, projectSwitching=", projectSwitching, "draft=", JSON.stringify(draft));
        if (projectSwitching || uploadStatus === "uploading") return;
        if (mentionQuery !== null && mentionHits.length > 0) {
          insertMention(mentionHits[mentionIndex]!);
          return;
        }
        console.log("[Composer] calling onSend()");
        const ready = attachments.filter((item) => item.status === "success").map((item) => item.result!);
        onSend(ready);
        setAttachments([]);
      }}
    >
      {(isEmptySession || pendingNewSession) ? (
      <div className="composer-top">
        <div className="ws-picker" ref={wsMenuRef}>
          <button
            type="button"
            className="ws-trigger"
            onClick={() => setWsMenuOpen((v) => !v)}
            title={t("切换工作区")}
          >
            <span className="ws-icon" aria-hidden>
              📁
            </span>
            {workspaceName ?? t("未打开工作区")}
            <span className="mode-chevron" aria-hidden>
              ▾
            </span>
          </button>
          {wsMenuOpen ? (
            <ul className="ws-menu">
              {projects.map((p) => (
                <li key={p.root}>
                  <button
                    type="button"
                    className={p.root === workspaceRoot ? "selected" : ""}
                    title={p.root}
                    onClick={async () => {
                      setWsMenuOpen(false);
                      if (p.root !== workspaceRoot) {
                        setProjectSwitching(true);
                        try {
                          await onSelectProject(p.root);
                        } catch (error) {
                          console.error('[Composer] 项目切换失败:', error);
                        } finally {
                          setProjectSwitching(false);
                        }
                      }
                    }}
                  >
                    <span className="ws-menu-name">{p.name}</span>
                    {p.root === workspaceRoot ? (
                      <span className="ws-menu-check" aria-hidden>
                        ✓
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
              {projects.length > 0 ? <li className="ws-menu-sep" aria-hidden /> : null}
              <li>
                <button
                  type="button"
                  className="ws-menu-open"
                  onClick={() => {
                    setWsMenuOpen(false);
                    onAddProject();
                  }}
                >
                  <span className="ws-menu-name">{t("＋ 打开新目录…")}</span>
                </button>
              </li>
            </ul>
          ) : null}
        </div>
        {gitStatus?.isRepo && gitStatus.branch ? (
          <span
            className={gitStatus.dirty ? "ws-branch-chip dirty" : "ws-branch-chip"}
            title={gitStatus.summary}
          >
            <span className="ws-branch-dot" aria-hidden />
            {gitStatus.branch}
          </span>
        ) : null}
      </div>
      ) : null}

      <div className="composer-input-wrap">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            onDraft(e.target.value);
            syncMention(e.target.value, e.target.selectionStart);
          }}
          onClick={(e) => syncMention(draft, e.currentTarget.selectionStart)}
          onKeyUp={(e) => syncMention(draft, e.currentTarget.selectionStart)}
          placeholder={
            mode === "plan"
              ? t("提出一个问题或描述要规划的任务…")
              : t("提出一个问题或描述一个任务…")
          }
          rows={3}
          disabled={projectSwitching}
          aria-label={mode === "plan" ? t("提出一个问题或描述要规划的任务…") : t("提出一个问题或描述一个任务…")}
          onKeyDown={(e) => {
            if (mentionQuery !== null && mentionHits.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIndex((i) => Math.min(i + 1, mentionHits.length - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIndex((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                insertMention(mentionHits[mentionIndex]!);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMentionQuery(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              // Route keyboard sends through the form submit handler so Enter
              // and the send button cannot invoke onSend through two paths.
              e.currentTarget.form?.requestSubmit();
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
              e.preventDefault();
              onNewSession();
            }
          }}
          onContextMenu={openCtxMenu}
        />
        {mentionQuery !== null && mentionHits.length > 0 ? (
          <ul className="mention-menu" role="listbox">
            {mentionHits.map((path, i) => (
              <li key={path}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === mentionIndex}
                  className={i === mentionIndex ? "selected" : ""}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(path);
                  }}
                >
                  {path}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {ctxMenu ? (
          <div
            ref={ctxMenuRef}
            className="ctx-menu"
            role="menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button type="button" role="menuitem" disabled={!ctxMenu.hasSelection} onClick={() => execCtxAction("cut")}>
              <span>{t("剪切")}</span>
              <span className="ctx-menu-key">Ctrl+X</span>
            </button>
            <button type="button" role="menuitem" disabled={!ctxMenu.hasSelection} onClick={() => execCtxAction("copy")}>
              <span>{t("复制")}</span>
              <span className="ctx-menu-key">Ctrl+C</span>
            </button>
            <button type="button" role="menuitem" onClick={() => execCtxAction("paste")}>
              <span>{t("粘贴")}</span>
              <span className="ctx-menu-key">Ctrl+V</span>
            </button>
            <div className="ctx-menu-sep" aria-hidden />
            <button type="button" role="menuitem" disabled={!draft.length} onClick={() => execCtxAction("selectAll")}>
              <span>{t("全选")}</span>
              <span className="ctx-menu-key">Ctrl+A</span>
            </button>
          </div>
        ) : null}
      </div>

      <div className="composer-bar">
        <input ref={fileInputRef} className="composer-file-input" type="file" multiple onChange={onFileSelected} />
        <button
          type="button"
          className="upload-trigger"
          aria-label="上传文件"
          title="上传图片或文件"
          disabled={projectSwitching}
          onClick={() => fileInputRef.current?.click()}
        >
          ＋ <span>上传</span>
        </button>
        {attachments.map((item) => <div key={`${item.file.name}-${item.file.lastModified}`} className={`upload-chip ${item.status === "error" ? "error" : ""}`} role="status"><span className="upload-chip-name">{item.status === "uploading" ? `上传中：${item.file.name}` : item.status === "error" ? `上传失败：${item.file.name}` : item.file.name}</span>{item.status === "error" ? <button type="button" onClick={() => void uploadFile(item.file)}>{t("重试")}</button> : null}<button type="button" aria-label="移除附件" onClick={() => setAttachments((xs) => xs.filter((x) => x !== item))}>×</button></div>)}
        <div className="mode-picker" ref={modeMenuRef}>
          <button
            type="button"
            className="mode-trigger"
            aria-haspopup="listbox"
            aria-expanded={modeMenuOpen}
            onClick={() => onModeMenuOpen(!modeMenuOpen)}
          >
            <span className="mode-icon" aria-hidden>
              {mode === "plan" ? "☰" : "∞"}
            </span>
            {mode === "plan" ? "Plan" : "Agent"}
            <span className="mode-chevron" aria-hidden>
              ▾
            </span>
          </button>
          {modeMenuOpen ? (
            <ul className="mode-menu" role="listbox">
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={mode === "agent"}
                  className={mode === "agent" ? "selected" : ""}
                  onClick={() => onMode("agent")}
                >
                  <span className="mode-icon" aria-hidden>
                    ∞
                  </span>
                  <span className="mode-meta">
                    <strong>Agent</strong>
                    <small>{t("可写 · 改代码与跑命令")}</small>
                  </span>
                  {mode === "agent" ? <span className="mode-check">✓</span> : null}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={mode === "plan"}
                  className={mode === "plan" ? "selected" : ""}
                  onClick={() => onMode("plan")}
                >
                  <span className="mode-icon" aria-hidden>
                    ☰
                  </span>
                  <span className="mode-meta">
                    <strong>Plan</strong>
                    <small>{t("只读 · 分析与出方案")}</small>
                  </span>
                  {mode === "plan" ? <span className="mode-check">✓</span> : null}
                </button>
              </li>
            </ul>
          ) : null}
        </div>

        {/* 所有设置项在同一行 */}
        <div className="composer-settings-row">
          {/* 任务分解模型选择器 - 分阶段和非分阶段都显示 */}
          <div className={`model-picker ${separateStageModels ? "model-picker-decomposer" : ""}`} ref={modelMenuRef}>
            <button
              type="button"
              className={`model-chip ${separateStageModels ? "model-chip-decomposer" : ""}`}
              aria-haspopup="listbox"
              aria-expanded={modelMenuOpen}
              onClick={() => setModelMenuOpen((v) => !v)}
              title={separateStageModels ? "任务分解模型" : t("切换模型")}
            >
              {separateStageModels ? <span className="model-stage-indicator">📋</span> : null}
              {modelLabel}
              <span className="mode-chevron" aria-hidden>
                ▾
              </span>
            </button>
            {modelMenuOpen ? (
              <div className="model-menu" role="listbox">
                {availableModels.length === 0 ? (
                  <div className="model-menu-empty">
                    <span>{t("暂无可用模型")}</span>
                    <button
                      type="button"
                      className="model-menu-settings"
                      onClick={() => {
                        setModelMenuOpen(false);
                        onOpenSettings();
                      }}
                    >
                      {t("去设置")}
                    </button>
                  </div>
                ) : (
                  <>
                    {/*
                      经典二级菜单：两列同在文档流 + align-items:flex-start，
                      高度互不拉伸；各自 height:auto / max-height 独立滚动。
                    */}
                    <div className="model-menu-body">
                      <nav className="model-menu-providers" role="tablist" aria-label={t("模型平台")}>
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
                      </nav>
                      <ul className="model-menu-models" role="group">
                        {(groupedModels.find((g) => g.providerId === selectedProviderId)?.models ?? []).map((m) => (
                          <li key={m.id}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={m.id === availableModels[0]?.id}
                              className={`${m.id === availableModels[0]?.id ? "selected" : ""} ${
                                (groupedModels.find((g) => g.providerId === selectedProviderId)?.models.length ?? 0) === 1
                                  ? "single-model"
                                  : ""
                              }`}
                              onClick={() => {
                                setModelMenuOpen(false);
                                setSelectedProviderId(null);
                                onSelectModel(m.id, m.providerId);
                              }}
                            >
                              <span className="model-menu-name">{m.name}</span>
                              {m.id === availableModels[0]?.id ? <span className="mode-check">✓</span> : null}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="ws-menu-sep" aria-hidden />
                    <button
                      type="button"
                      className="model-menu-settings"
                      onClick={() => {
                        setModelMenuOpen(false);
                        onOpenSettings();
                      }}
                    >
                      {t("⚙ 模型设置…")}
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </div>

          {/* 任务分解思考强度选择器 - 分阶段和非分阶段都显示 */}
          <div className="thinking-picker" ref={thinkingMenuRef}>
            <button
              type="button"
              className="thinking-chip"
              aria-haspopup="listbox"
              aria-expanded={thinkingMenuOpen}
              onClick={() => setThinkingMenuOpen((v) => !v)}
              title={separateStageModels ? "任务分解思考强度" : t("思考强度")}
            >
              {separateStageModels ? <span className="thinking-icon">📋</span> : <span className="thinking-icon">💭</span>}
              {thinkingEffort === "low" ? t("低") : thinkingEffort === "medium" ? t("中") : t("高")}
              <span className="mode-chevron" aria-hidden>
                ▾
              </span>
            </button>
            {thinkingMenuOpen ? (
              <ul className="thinking-menu" role="listbox">
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={thinkingEffort === "high"}
                    className={thinkingEffort === "high" ? "selected" : ""}
                    onClick={() => {
                      setThinkingMenuOpen(false);
                      onSelectThinkingEffort("high");
                    }}
                  >
                    <span className="thinking-menu-name">{t("高强度")}</span>
                    {thinkingEffort === "high" ? <span className="mode-check">✓</span> : null}
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={thinkingEffort === "medium"}
                    className={thinkingEffort === "medium" ? "selected" : ""}
                    onClick={() => {
                      setThinkingMenuOpen(false);
                      onSelectThinkingEffort("medium");
                    }}
                  >
                    <span className="thinking-menu-name">{t("中强度")}</span>
                    {thinkingEffort === "medium" ? <span className="mode-check">✓</span> : null}
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={thinkingEffort === "low"}
                    className={thinkingEffort === "low" ? "selected" : ""}
                    onClick={() => {
                      setThinkingMenuOpen(false);
                      onSelectThinkingEffort("low");
                    }}
                  >
                    <span className="thinking-menu-name">{t("低强度")}</span>
                    {thinkingEffort === "low" ? <span className="mode-check">✓</span> : null}
                  </button>
                </li>
              </ul>
            ) : null}
          </div>

          {/* 循环执行模型选择器（仅分阶段模式显示） */}
          {separateStageModels ? (
            <div className="composer-settings-row">
              <div className="model-picker model-picker-react" ref={reactMenuRef}>
                <button
                  type="button"
                  className="model-chip model-chip-react"
                  aria-haspopup="listbox"
                  aria-expanded={reactMenuOpen}
                  onClick={() => setReactMenuOpen((v) => !v)}
                  title={t("循环执行模型")}
                >
                  <span className="model-stage-indicator">🔄</span>
                  {availableModels.find(m => m.name === reactModelId)?.name || t("选择模型")}
                  <span className="mode-chevron" aria-hidden>▾</span>
                </button>
                {reactMenuOpen ? (
                  <div className="model-menu" role="listbox">
                    {availableModels.length === 0 ? (
                      <div className="model-menu-empty">
                        <span>{t("暂无可用模型")}</span>
                        <button type="button" className="model-menu-settings" onClick={() => { setReactMenuOpen(false); onOpenSettings(); }}>
                          {t("去设置")}
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="model-menu-body">
                          <nav className="model-menu-providers" role="tablist" aria-label={t("模型平台")}>
                            {groupedModels.map((group) => (
                              <button key={group.providerId} type="button" role="tab" aria-selected={selectedReactProviderId === group.providerId} className={`model-menu-provider-item ${selectedReactProviderId === group.providerId ? "active" : ""}`} onMouseEnter={() => setSelectedReactProviderId(group.providerId)} onFocus={() => setSelectedReactProviderId(group.providerId)} onClick={() => setSelectedReactProviderId(group.providerId)}>
                                <span className="model-menu-provider-label">{group.providerName}<span className="model-menu-provider-count">{group.models.length}</span></span>
                              </button>
                            ))}
                          </nav>
                          <ul className="model-menu-models" role="group">
                            {(groupedModels.find((g) => g.providerId === selectedReactProviderId)?.models ?? []).map((m) => (
                              <li key={m.id}>
                                <button type="button" role="option" aria-selected={m.name === reactModelId} className={`${m.name === reactModelId ? "selected" : ""}`} onClick={() => { setReactMenuOpen(false); setSelectedReactProviderId(null); onSelectReactModel(m.name, m.providerId); }}>
                                  <span className="model-menu-name">{m.name}</span>
                                  {m.name === reactModelId ? <span className="mode-check">✓</span> : null}
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div className="ws-menu-sep" aria-hidden />
                        <button type="button" className="model-menu-settings" onClick={() => { setReactMenuOpen(false); onOpenSettings(); }}>{t("⚙ 模型设置…")}</button>
                      </>
                    )}
                  </div>
                ) : null}
              </div>

              {/* 循环执行思考强度选择器 */}
              <div className="thinking-picker thinking-picker-react" ref={reactThinkingMenuRef}>
                <button
                  type="button"
                  className="thinking-chip thinking-chip-react"
                  aria-haspopup="listbox"
                  aria-expanded={reactThinkingMenuOpen}
                  onClick={() => setReactThinkingMenuOpen((v) => !v)}
                  title={t("循环执行思考强度")}
                >
                  <span className="thinking-icon">💭</span>
                  {reactThinkingEffort === "low" ? t("低") : reactThinkingEffort === "medium" ? t("中") : t("高")}
                  <span className="mode-chevron" aria-hidden>▾</span>
                </button>
                {reactThinkingMenuOpen ? (
                  <ul className="thinking-menu" role="listbox">
                    <li>
                      <button
                        type="button"
                        role="option"
                        aria-selected={reactThinkingEffort === "high"}
                        className={reactThinkingEffort === "high" ? "selected" : ""}
                        onClick={() => {
                          setReactThinkingMenuOpen(false);
                          onSelectReactThinkingEffort("high");
                        }}
                      >
                        <span className="thinking-menu-name">{t("高强度")}</span>
                        {reactThinkingEffort === "high" ? <span className="mode-check">✓</span> : null}
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        role="option"
                        aria-selected={reactThinkingEffort === "medium"}
                        className={reactThinkingEffort === "medium" ? "selected" : ""}
                        onClick={() => {
                          setReactThinkingMenuOpen(false);
                          onSelectReactThinkingEffort("medium");
                        }}
                      >
                        <span className="thinking-menu-name">{t("中强度")}</span>
                        {reactThinkingEffort === "medium" ? <span className="mode-check">✓</span> : null}
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        role="option"
                        aria-selected={reactThinkingEffort === "low"}
                        className={reactThinkingEffort === "low" ? "selected" : ""}
                        onClick={() => {
                          setReactThinkingMenuOpen(false);
                          onSelectReactThinkingEffort("low");
                        }}
                      >
                        <span className="thinking-menu-name">{t("低强度")}</span>
                        {reactThinkingEffort === "low" ? <span className="mode-check">✓</span> : null}
                      </button>
                    </li>
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="composer-actions">
          {queueCount > 0 ? (
            <div className="queue-badge">
              <span className="queue-badge-text">{t("待执行{{count}}条", { count: queueCount })}</span>
              <button
                type="button"
                className="queue-badge-remove"
                onClick={() => onRemoveQueueMessage(0)}
                title={t("移除最早待执行消息")}
              >
                ✕
              </button>
            </div>
          ) : null}
          {sending ? (
            <button type="button" className="stop-btn" onClick={onCancel}>
              {t("停止")}
            </button>
          ) : null}
          <button 
            type="submit" 
            className="send" 
            disabled={!draft.trim() || projectSwitching} 
            aria-label={t("发送")}
            title={
              projectSwitching 
                ? t("正在切换项目，请稍候...") 
                : !draft.trim() 
                  ? t("请输入消息") 
                  : t("发送消息")
            }
          >
            ↑
          </button>
        </div>
      </div>
    </form>
  );
}

export const Composer = memo(ComposerImpl);
