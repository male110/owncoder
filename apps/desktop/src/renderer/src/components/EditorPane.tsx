import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { useUiStore } from "../store/ui-store";
import { Markdown } from "./Markdown";

// 必须在 Monaco 加载前配置 worker 环境，否则 FileAccess 的 toUrl 未定义
self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

loader.config({ monaco });

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
  onClose: () => void;
  onSaved?: () => void;
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

export function EditorPane({ path, content, originalContent, diffMode, onClose, onSaved }: EditorPaneProps) {
  const [value, setValue] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [mdViewMode, setMdViewMode] = useState<MdViewMode>("preview");
  const theme = useUiStore((s) => s.theme);
  const monacoTheme = theme === "codex" ? "vs" : "vs-dark";
  const isMarkdown = useMemo(() => isMarkdownPath(path), [path]);
  const dirty = value !== original;
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const loadRequestRef = useRef(0);
  // DiffEditor 的模型由 @monaco-editor/react 自动创建；组件卸载时它先释放模型、
  // 再销毁编辑器，会触发 Monaco 的 "TextModel got disposed before DiffEditorWidget
  // model got reset" 报错。因此用 keepCurrent* 让包装组件不释放模型，改由这里在
  // 编辑器销毁之后统一释放（子组件清理先于父组件清理执行）。
  const diffModelsRef = useRef<{
    original: monaco.editor.ITextModel;
    modified: monaco.editor.ITextModel;
  } | null>(null);

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

  return (
    <div className="editor-pane">
      <div className="editor-pane-head">
        <div className="editor-path" title={path}>
          {path}
          {dirty && !diffMode ? <span className="editor-dirty">●</span> : null}
          {diffMode ? <span className="editor-mode-badge">变更对比</span> : null}
        </div>
        <div className="editor-actions">
          {!diffMode && isMarkdown ? (
            <div className="editor-md-toggle" role="group" aria-label="Markdown 视图">
              <button
                type="button"
                className={`ghost tiny${mdViewMode === "source" ? " active" : ""}`}
                onClick={() => setMdViewMode("source")}
              >
                原码
              </button>
              <button
                type="button"
                className={`ghost tiny${mdViewMode === "preview" ? " active" : ""}`}
                onClick={() => setMdViewMode("preview")}
              >
                预览
              </button>
            </div>
          ) : null}
          {!diffMode ? (
            <>
              <button type="button" className="ghost tiny" onClick={() => void load()} disabled={loading}>
                重载
              </button>
              <button
                type="button"
                className="ghost tiny accent"
                disabled={!dirty || saving || loading}
                onClick={() => void save()}
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </>
          ) : null}
          <button type="button" className="ghost tiny" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
      {error ? <p className="editor-error">{error}</p> : null}
      <div className="editor-pane-body">
        {loading ? (
          <p className="hint context-empty">加载中…</p>
        ) : diffMode ? (
          <DiffEditor
            height="100%"
            theme={monacoTheme}
            language={languageForPath(path)}
            original={original}
            modified={value}
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
              <p className="hint context-empty">空文档</p>
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
      </div>
    </div>
  );
}
