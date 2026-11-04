import { useCallback, useEffect, useState } from "react";
import type { UserMemoryDto } from "../../../preload/index";
import { customConfirm } from "../utils/customConfirm";
import { useI18n } from "../i18n";

export function MemoriesTab() {
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
