import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Editor, { DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "./monaco-editor.worker?worker";
import tsWorker from "./monaco-typescript.worker?worker";
import jsonWorker from "./monaco-json.worker?worker";
import cssWorker from "./monaco-css.worker?worker";
import htmlWorker from "./monaco-html.worker?worker";
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
    if (label === "json") {
      return new jsonWorker();
    }
    if (label === "css" || label === "scss" || label === "less") {
      return new cssWorker();
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new htmlWorker();
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
  /** 当前页签是否可见。 */
  active?: boolean;
  /** 定位到指定行；requestId 用于同一文件的重复定位。 */
  revealLine?: { line: number; requestId: number };
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
  active = true,
  revealLine,
}: EditorPaneProps) {
  const [value, setValue] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [mdViewMode, setMdViewMode] = useState<MdViewMode>("preview");
  const { t } = useI18n();
  const theme = useUiStore((s) => s.theme);
  const monacoTheme = theme === "light" ? "vs" : "vs-dark";
  const isMarkdown = useMemo(() => isMarkdownPath(path), [path]);
  const dirty = value !== original;
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const loadRequestRef = useRef(0);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // 包装组件默认先释放模型再销毁编辑器；保留模型并延后释放，避免销毁顺序错误。
  const diffModelsRef = useRef<{
    original: monaco.editor.ITextModel;
    modified: monaco.editor.ITextModel;
  } | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const editorModelRef = useRef<monaco.editor.ITextModel | null>(null);
  const normalLoadedRef = useRef(false);
  const diffSnapshotRef = useRef<{ before: string; after: string } | null>(null);
  if (diffMode) diffSnapshotRef.current = { before: originalContent, after: content };
  const diffSnapshot = diffSnapshotRef.current;
  const sourceVisible = active && !diffMode && !(isMarkdown && mdViewMode === "preview");
  const sourceVisibleRef = useRef(sourceVisible);
  sourceVisibleRef.current = sourceVisible;
  const diffVisible = active && Boolean(diffMode);
  const diffVisibleRef = useRef(diffVisible);
  diffVisibleRef.current = diffVisible;
  // 同一页签复用 URI，关闭并重开页签时才生成新 URI。
  const diffModelPaths = useMemo(() => {
    const id = ++nextDiffModelId;
    return {
      original: `inmemory://owncoder/diff/${id}/original/${path}`,
      modified: `inmemory://owncoder/diff/${id}/modified/${path}`,
    };
  }, [path]);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    const isCurrent = () => loadRequestRef.current === requestId;

    // Diff 快照不能覆盖普通文件内容和撤销历史。
    if (diffMode) {
      setLoading(false);
      return;
    }
    if (content !== undefined) {
      normalLoadedRef.current = true;
      setValue(content);
      setOriginal(content);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const text = await window.owncoder.readWorkspaceFile(path);
      if (!isCurrent()) return;
      normalLoadedRef.current = true;
      setValue(text);
      setOriginal(text);
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [path, content, diffMode]);

  useEffect(() => {
    if (diffMode || !normalLoadedRef.current) void load();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    setMdViewMode("preview");
  }, [path]);

  useEffect(() => {
    if (!active || !revealLine) return;
    if (isMarkdown) setMdViewMode("source");
    const editor = editorRef.current;
    if (!editor) return;
    editor.setPosition({ lineNumber: revealLine.line, column: 1 });
    editor.revealLineInCenter(revealLine.line);
    editor.focus();
  }, [active, isMarkdown, revealLine]);

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

  // 父组件清理可能早于子组件；等本轮清理完成、编辑器销毁后再释放模型。
  useEffect(() => {
    return () => {
      const models = diffModelsRef.current;
      diffModelsRef.current = null;
      const editorModel = editorModelRef.current;
      editorModelRef.current = null;
      editorRef.current = null;
      diffEditorRef.current = null;
      queueMicrotask(() => {
        if (editorModel && !editorModel.isDisposed()) editorModel.dispose();
        if (models && !models.original.isDisposed()) models.original.dispose();
        if (models && !models.modified.isDisposed()) models.modified.dispose();
      });
    };
  }, [diffModelPaths]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: !sourceVisible });
    if (sourceVisible) {
      editorRef.current?.layout();
      editorRef.current?.focus();
    }
    if (diffVisible) {
      diffEditorRef.current?.layout();
      diffEditorRef.current?.getModifiedEditor().focus();
    }
  }, [sourceVisible, diffVisible]);

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
        <div
          style={{ position: "absolute", inset: 0, visibility: diffVisible ? "visible" : "hidden", pointerEvents: diffVisible ? "auto" : "none" }}
          aria-hidden={!diffVisible}
          inert={!diffVisible}
        >
        {diffSnapshot ? (
          <DiffEditor
            height="100%"
            theme={monacoTheme}
            language={languageForPath(path)}
            original={diffSnapshot.before}
            modified={diffSnapshot.after}
            originalModelPath={diffModelPaths?.original}
            modifiedModelPath={diffModelPaths?.modified}
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
              diffEditorRef.current = ed;
              if (diffVisibleRef.current) {
                ed.layout();
                ed.getModifiedEditor().focus();
              }
              const model = ed.getModel();
              diffModelsRef.current = model
                ? { original: model.original, modified: model.modified }
                : null;
            }}
          />
        ) : null}
        </div>
        {active && !diffMode && isMarkdown && mdViewMode === "preview" ? (
          <div className="editor-md-preview">
            {value.trim() ? (
              <Markdown content={value} className="md-body editor-md-body" showCopy={false} />
            ) : (
              <p className="hint context-empty">{t("空文档")}</p>
            )}
          </div>
        ) : null}
        <div
          style={{ position: "absolute", inset: 0, visibility: sourceVisible ? "visible" : "hidden", pointerEvents: sourceVisible ? "auto" : "none" }}
          aria-hidden={!sourceVisible}
          inert={!sourceVisible}
        >
          <Editor
            height="100%"
            theme={monacoTheme}
            language={languageForPath(path)}
            value={value}
            keepCurrentModel
            onChange={(v) => { if (sourceVisibleRef.current) setValue(v ?? ""); }}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              automaticLayout: true,
              tabSize: 2,
              readOnly: !sourceVisible,
            }}
            onMount={(ed) => {
              editorRef.current = ed;
              editorModelRef.current = ed.getModel();
              ed.updateOptions({ readOnly: !sourceVisibleRef.current });
              if (sourceVisibleRef.current) {
                ed.layout();
                if (revealLine) {
                  ed.setPosition({ lineNumber: revealLine.line, column: 1 });
                  ed.revealLineInCenter(revealLine.line);
                }
                ed.focus();
              }
              ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                if (sourceVisibleRef.current) void saveRef.current();
              });
            }}
          />
        </div>
        {loading && !diffMode ? <p className="hint context-empty editor-loading-overlay">{t("加载中…")}</p> : null}
      </div>
    </div>
  );
}
