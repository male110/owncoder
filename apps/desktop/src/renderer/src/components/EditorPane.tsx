import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Editor, { DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "./monaco-editor.worker?worker";
import tsWorker from "./monaco-typescript.worker?worker";
import { useUiStore } from "../store/ui-store";
import { Markdown } from "./Markdown";
import { useI18n } from "../i18n";

function IconReload({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 8a5.5 5.5 0 0 1 9.3-4.05M13.5 8a5.5 5.5 0 0 1-9.3 4.05"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M12.2 2.2v3.2h-3.2M3.8 13.8v-3.2h3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSave({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 2.5h7.2L13.5 5.3v8.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M5 2.5v3.5h5.5V2.5M5 13.5v-4h6v4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// worker 入口会在加载 Monaco ESM 模块前设置资源根路径，避免 FileAccess.toUri
// 在语言服务加载 foreign module 时调用未初始化的 moduleIdToUrl。
self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

loader.config({ monaco });

let nextDiffModelId = 0;

function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    scss: "scss",
    html: "html",
    htm: "html",
    rs: "rust",
    py: "python",
    go: "go",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    sh: "shell",
    bash: "shell",
    ps1: "powershell",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    sql: "sql",
  };
  return map[ext] ?? "plaintext";
}

function isMarkdownPath(path: string): boolean {
  return path.split(".").pop()?.toLowerCase() === "md";
}

type MdViewMode = "source" | "preview";

// 使用 discriminated union 确保类型安全
type EditorPaneProps = {
  path: string;
  /** 单文件模式关闭回调；多 tab 模式下页签已有关闭，可不传。 */
  onClose?: () => void;
  onSaved?: () => void;
  /** 向父级同步 dirty，供 tab 关闭确认与脏标记使用。 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 隐藏内置路径标题栏（由外层多 tab 栏展示路径时使用）。 */
  hidePathTitle?: boolean;
  /** 将保存/重新加载等操作渲染到外层页签行容器。 */
  actionsHost?: HTMLElement | null;
} & (
  | {
      /** 普通编辑模式 */
      diffMode?: false;
      content?: string;
      originalContent?: never;
    }
  | {
      /** Diff 对比模式 */
      diffMode: true;
      /** 修改后的内容 */
      content: string;
      /** 原始内容（修改前） */
      originalContent: string;
    }
);

export function EditorPane({
  path,
  content,
  originalContent,
  diffMode,
  onClose,
  onSaved,
  onDirtyChange,
  hidePathTitle = false,
  actionsHost = null,
}: EditorPaneProps) {
  const [value, setValue] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [mdViewMode, setMdViewMode] = useState<MdViewMode>("preview");
  const { t } = useI18n();
  const theme = useUiStore((s) => s.theme);
  const monacoTheme = theme === "codex" ? "vs" : "vs-dark";
  const isMarkdown = useMemo(() => isMarkdownPath(path), [path]);
  const dirty = value !== original;
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const loadRequestRef = useRef(0);

  useEffect(() => {
    onDirtyChange?.(dirty && !diffMode);
  }, [dirty, diffMode, onDirtyChange]);
  // DiffEditor 的模型由 @monaco-editor/react 自动创建；组件卸载时它先释放模型、
  // 再销毁编辑器，会触发 Monaco 的 "TextModel got disposed before DiffEditorWidget
  // model got reset" 报错。因此用 keepCurrent* 让包装组件不释放模型，改由这里在
  // 编辑器销毁之后统一释放（子组件清理先于父组件清理执行）。
  const diffModelsRef = useRef<{
    original: monaco.editor.ITextModel;
    modified: monaco.editor.ITextModel;
  } | null>(null);
  // DiffEditor 会按模型 URI 复用内部视图状态；每次查看使用新 URI，避免前次展开的
  // 未变更区域在关闭并重开后恢复为全部内容。
  const diffModelPaths = useRef(
    diffMode ? {
      original: `inmemory://owncoder/diff/${++nextDiffModelId}/original/${path}`,
      modified: `inmemory://owncoder/diff/${nextDiffModelId}/modified/${path}`,
    } : null,
  );

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    const isCurrent = () => loadRequestRef.current === requestId;

    // 如果传入了 content，直接使用，跳过文件读取
    if (content !== undefined) {
      if (!isCurrent()) return;
      setValue(content);
      // 如果是diff模式，originalContent 保证存在（由类型系统确保）
      setOriginal(diffMode ? originalContent : content);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const text = await window.owncoder.readWorkspaceFile(path);
      if (!isCurrent()) return;
      setValue(text);
      setOriginal(text);
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [path, content, originalContent, diffMode]);

  useEffect(() => {
    void load();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    setMdViewMode("preview");
  }, [path]);

  const save = useCallback(async () => {
    setSaving(true);
    setError("");
    try {
      await window.owncoder.writeWorkspaceFile(path, value);
      setOriginal(value);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [path, value, onSaved]);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  // 在 DiffEditor（子组件）卸载并销毁编辑器之后再释放模型
  useEffect(() => {
    return () => {
      const models = diffModelsRef.current;
      diffModelsRef.current = null;
      if (!models) return;
      if (!models.original.isDisposed()) models.original.dispose();
      if (!models.modified.isDisposed()) models.modified.dispose();
    };
  }, [diffMode]);

  const mdToggle =
    !diffMode && isMarkdown ? (
      <div className="editor-md-toggle" role="group" aria-label={t("Markdown 视图")}>
        <button
          type="button"
          className={`ghost tiny${mdViewMode === "source" ? " active" : ""}`}
          onClick={() => setMdViewMode("source")}
        >
          {t("原码")}
        </button>
        <button
          type="button"
          className={`ghost tiny${mdViewMode === "preview" ? " active" : ""}`}
          onClick={() => setMdViewMode("preview")}
        >
          {t("预览")}
        </button>
      </div>
    ) : null;

  const fileActions: ReactNode = !diffMode ? (
    <>
      <button
        type="button"
        className="ghost tiny editor-icon-btn"
        onClick={() => void load()}
        disabled={loading}
        title={t("重新加载")}
        aria-label={t("重新加载")}
      >
        <IconReload />
      </button>
      <button
        type="button"
        className="ghost tiny accent editor-icon-btn"
        disabled={!dirty || saving || loading}
        onClick={() => void save()}
        title={saving ? t("保存中…") : t("保存")}
        aria-label={saving ? t("保存中") : t("保存")}
      >
        <IconSave />
      </button>
    </>
  ) : null;

  const hostActions =
    actionsHost && (mdToggle || fileActions) ? (
      <>
        {mdToggle}
        {fileActions}
      </>
    ) : null;
  const showHead = !hidePathTitle || (!actionsHost && (Boolean(mdToggle) || Boolean(fileActions) || Boolean(onClose)));
  const tabActions = hostActions
    ? createPortal(
        <div className="editor-actions editor-tab-actions">{hostActions}</div>,
        actionsHost!,
      )
    : null;

  return (
    <div className="editor-pane">
      {showHead ? (
        <div className="editor-pane-head">
          {hidePathTitle ? (
            <div className="editor-path editor-path-spacer" aria-hidden="true" />
          ) : (
            <div className="editor-path" title={path}>
              {path}
              {dirty && !diffMode ? <span className="editor-dirty">●</span> : null}
              {diffMode ? <span className="editor-mode-badge">{t("变更对比")}</span> : null}
            </div>
          )}
          <div className="editor-actions">
            {actionsHost ? null : mdToggle}
            {actionsHost ? null : fileActions}
            {onClose ? (
              <button
                type="button"
                className="ghost tiny editor-icon-btn"
                onClick={onClose}
                title={t("关闭")}
                aria-label={t("关闭")}
              >
                ×
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {tabActions}
      {error ? <p className="editor-error">{error}</p> : null}
      <div className="editor-pane-body">
        {diffMode ? (
          <DiffEditor
            height="100%"
            theme={monacoTheme}
            language={languageForPath(path)}
            original={original}
            modified={value}
            originalModelPath={diffModelPaths.current?.original}
            modifiedModelPath={diffModelPaths.current?.modified}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: "off",
              automaticLayout: true,
              renderSideBySide: true,
              // Diff模式设计为只读，用于审查变更
              // 如需编辑，用户应从文件树或"打开文件"直接打开
              readOnly: true,
              enableSplitViewResizing: true,
              renderOverviewRuler: true,
              // 只展示发生变更的部分，未变更的整段内容折叠为「…」占位
              hideUnchangedRegions: {
                enabled: true,
                revealLineCount: 3,
                minimumLineCount: 3,
                contextLineCount: 1,
              },
            }}
            onMount={(ed) => {
              const model = ed.getModel();
              diffModelsRef.current = model
                ? { original: model.original, modified: model.modified }
                : null;
            }}
          />
        ) : isMarkdown && mdViewMode === "preview" ? (
          <div className="editor-md-preview">
            {value.trim() ? (
              <Markdown content={value} className="md-body editor-md-body" showCopy={false} />
            ) : (
              <p className="hint context-empty">{t("空文档")}</p>
            )}
          </div>
        ) : (
          <Editor
            height="100%"
            theme={monacoTheme}
            language={languageForPath(path)}
            value={value}
            onChange={(v) => setValue(v ?? "")}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              automaticLayout: true,
              tabSize: 2,
            }}
            onMount={(ed) => {
              ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                void saveRef.current();
              });
            }}
          />
        )}
        {loading ? <p className="hint context-empty editor-loading-overlay">{t("加载中…")}</p> : null}
      </div>
    </div>
  );
}
